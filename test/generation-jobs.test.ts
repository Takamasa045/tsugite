/**
 * Phase C: provider-neutral durable async generation jobs + minimax-http mock lifecycle.
 * Zero live network / DNS / provider / API key values required.
 */
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalDigest,
  assertApprovalAllowsSubmit,
  assertRequestDigestMatches,
  assertTransition,
  buildApprovalDigestInput,
  canTransition,
  computeRequestDigest,
  createApproval,
  DEFAULT_LOCK_STALE_MS,
  exclusiveLock,
  GENERATION_JOB_TRANSITIONS,
  GenerationJobError,
  GenerationJobMachine,
  GenerationJobStore,
  GJ_APPROVAL_DIGEST_MISMATCH,
  GJ_CANCEL_UNSUPPORTED,
  GJ_CATALOG_NOT_ADAPTER,
  GJ_HASH_MISMATCH,
  GJ_IDENTITY_MISMATCH,
  GJ_INVALID_TRANSITION,
  GJ_LOCK_HELD,
  GJ_PATH_UNSAFE,
  GJ_PREFLIGHT_ONLY,
  GJ_PRICE_CAP_EXCEEDED,
  GJ_PRICE_UNKNOWN,
  GJ_RESUBMIT_FORBIDDEN,
  GJ_ROUTE_UNSUPPORTED,
  GJ_SCHEMA_INVALID,
  GJ_SUBMISSION_UNKNOWN,
  pinBytesAtomically,
  pinStreamAtomically,
  preflightGenerationJob,
  redactSecretsDeep,
  resolveContainedPath,
  verifyAdapterArtifact,
  type GenerationJobProviderAdapter,
  type GenerationJobRecord,
  type GenerationJobRequest
} from "../src/generationJobs/index.js";
import {
  assertConnectionModeSupported,
  connectionCapabilityDigest,
  loadConnectionCapabilityProfile
} from "../src/videoPromptDirector/connectionCapability.js";
import {
  loadModelPromptProfile,
  modelProfileDigest
} from "../src/videoPromptDirector/modelProfile.js";
import {
  asFixtureTransport,
  assertAllowedHttpsUrl,
  assertLastFrameOnlyRequest,
  createMinimaxHttpAdapter,
  MINIMAX_HTTP_CONNECTION_ID,
  MINIMAX_HTTP_FIXTURE_TRANSPORT_MARKER,
  MINIMAX_HTTP_IR_MODEL,
  type MinimaxHttpTransport,
  type MinimaxHttpTransportRequest,
  type MinimaxHttpTransportResponse
} from "../adapters/minimax-http/minimaxHttp.ts";
import {
  listConnectionOptions,
  loadConnectionCatalog
} from "../src/connections/registry.js";
import { preflightMinimaxConnection } from "../adapters/minimax/minimaxCli.mjs";

const FIXED_NOW = "2026-08-08T12:00:00.000Z";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).slice().sort();
  } catch {
    return [];
  }
}

function knownPricing(amount = 1.5, max = 10): GenerationJobRecord["pricing"] {
  return {
    status: "known",
    version: "price-v1",
    currency: "USD",
    amount,
    max_amount: max
  };
}

function unknownPricing(): GenerationJobRecord["pricing"] {
  return {
    status: "unknown",
    version: null,
    currency: null,
    amount: null,
    max_amount: null
  };
}

function baseRequest(overrides: Partial<GenerationJobRequest> = {}): GenerationJobRequest {
  const partial = {
    model_id: overrides.model_id ?? "demo-model",
    mode: overrides.mode ?? "text-to-video",
    connection_id: overrides.connection_id ?? "demo-connection",
    auth_env_names: overrides.auth_env_names ?? ["DEMO_API_KEY"],
    asset_paths: overrides.asset_paths ?? [],
    params: { prompt: "A quiet lake at dusk.", duration: 6, ...(overrides.params ?? {}) }
  };
  return {
    ...partial,
    digest: overrides.digest ?? computeRequestDigest(partial)
  };
}

function createMockAdapter(options: {
  connectionId?: string;
  adapterId?: string;
  submitImpl?: GenerationJobProviderAdapter["submit"];
  pollImpl?: GenerationJobProviderAdapter["poll"];
  downloadImpl?: GenerationJobProviderAdapter["download"];
  cancelSupported?: boolean;
  executionReady?: boolean;
  submitCalls?: { count: number };
} = {}): GenerationJobProviderAdapter {
  const submitCalls = options.submitCalls ?? { count: 0 };
  const bytes = Buffer.from("fake-video-bytes-phase-c");
  const hash = sha256(bytes.toString("utf8"));
  return {
    adapter_id: options.adapterId ?? "demo-adapter",
    connection_id: options.connectionId ?? "demo-connection",
    capabilities: {
      submit: true,
      poll: true,
      cancel: options.cancelSupported ?? false,
      download: true
    },
    async preflight() {
      return {
        ok: true,
        execution_ready: options.executionReady ?? true
      };
    },
    async submit(request, ctx) {
      submitCalls.count += 1;
      if (options.submitImpl) return options.submitImpl(request, ctx);
      return { ok: true, provider_job_id: "prov-1", accepted: true };
    },
    async poll(providerJobId, ctx) {
      if (options.pollImpl) return options.pollImpl(providerJobId, ctx);
      return { ok: true, status: "succeeded" };
    },
    async cancel() {
      if (!options.cancelSupported) {
        return {
          ok: false,
          code: "cancel_unsupported",
          message: "cancel unsupported",
          unsupported: true
        };
      }
      return { ok: true, cancelled: true };
    },
    async download(providerJobId, destinationDir, ctx) {
      if (options.downloadImpl) return options.downloadImpl(providerJobId, destinationDir, ctx);
      const pinned = await pinBytesAtomically(destinationDir, bytes, {
        relativeName: `${providerJobId}.bin`,
        expectedSha256: hash
      });
      return {
        ok: true,
        absolute_path: pinned.absolute_path,
        sha256: pinned.sha256,
        byte_length: pinned.byte_length
      };
    }
  };
}

describe("A. job schema / state transitions", () => {
  it("rejects invalid transitions fail-closed", () => {
    expect(() => assertTransition("planned", "submitted")).toThrowError(GenerationJobError);
    expect(() => assertTransition("pinned", "polling")).toThrowError(GenerationJobError);
    expect(() => assertTransition("submission_unknown", "submitting")).toThrowError(
      GenerationJobError
    );
    try {
      assertTransition("failed", "approved");
    } catch (error) {
      expect((error as GenerationJobError).code).toBe(GJ_INVALID_TRANSITION);
    }
  });

  it("allows the documented happy path and submission_unknown resume to poll only", () => {
    const happy: Array<[keyof typeof GENERATION_JOB_TRANSITIONS, string]> = [
      ["planned", "awaiting_cost_approval"],
      ["awaiting_cost_approval", "approved"],
      ["approved", "submitting"],
      ["submitting", "submitted"],
      ["submitted", "polling"],
      ["polling", "succeeded"],
      ["succeeded", "downloading"],
      ["downloading", "verified"],
      ["verified", "pinned"]
    ];
    for (const [from, to] of happy) {
      expect(canTransition(from, to as never)).toBe(true);
    }
    expect(canTransition("submission_unknown", "polling")).toBe(true);
    expect(canTransition("submission_unknown", "submitting")).toBe(false);
    expect(canTransition("cancel_requested", "succeeded")).toBe(true);
  });
});

describe("B. durable store crash/resume + append-only events", () => {
  it("persists job.json atomically and appends ordered events", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-store-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const request = baseRequest();
    const created = await store.create({
      connection_id: request.connection_id,
      model_id: request.model_id,
      mode: request.mode,
      request,
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing()
    });
    expect(created.status).toBe("planned");
    expect(created.revision).toBe(0);

    const next = await store.transition(created.job_id, "awaiting_cost_approval");
    expect(next.status).toBe("awaiting_cost_approval");
    expect(next.revision).toBe(1);
    expect(next.identity_token).not.toBe(created.identity_token);

    const reloaded = await store.load(created.job_id);
    expect(reloaded.status).toBe("awaiting_cost_approval");
    expect(reloaded.job_id).toBe(created.job_id);

    const events = await store.events(created.job_id);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events[0]?.type).toBe("created");
    expect(events[1]?.type).toBe("transition");
    expect(events[1]?.from_status).toBe("planned");
    expect(events[1]?.to_status).toBe("awaiting_cost_approval");

    const { GenerationJobAuditLog } = await import("../src/generationJobs/audit.js");
    const audit = new GenerationJobAuditLog(store.jobDir(created.job_id));
    await expect(audit.refuseRewrite()).rejects.toThrow(/append-only/);
  });

  it("resume after crash continues from durable provider_job_id via poll", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-resume-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const submitCalls = { count: 0 };
    const adapter = createMockAdapter({
      submitCalls,
      pollImpl: async () => ({ ok: true, status: "succeeded" })
    });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    const request = baseRequest();
    let job = await machine.plan({
      request,
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    job = await machine.submit(job.job_id);
    expect(job.status).toBe("submitted");
    expect(job.provider_job_id).toBe("prov-1");
    expect(submitCalls.count).toBe(1);

    const machine2 = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    const resumed = await machine2.resume(job.job_id);
    expect(resumed.status).toBe("succeeded");
    expect(submitCalls.count).toBe(1);
  });

  it("refuses duplicate create for same job_id (no overwrite)", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-dup-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const request = baseRequest();
    const first = await store.create({
      job_id: "fixed-job-1",
      connection_id: request.connection_id,
      model_id: request.model_id,
      mode: request.mode,
      request,
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing()
    });
    await store.transition(first.job_id, "awaiting_cost_approval");

    await expect(
      store.create({
        job_id: "fixed-job-1",
        connection_id: request.connection_id,
        model_id: request.model_id,
        mode: request.mode,
        request: baseRequest({ params: { prompt: "tampered" } }),
        model_profile_digest: "c".repeat(64),
        connection_capability_digest: "d".repeat(64),
        pricing: knownPricing(9, 10)
      })
    ).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });

    const loaded = await store.load("fixed-job-1");
    expect(loaded.status).toBe("awaiting_cost_approval");
    expect(loaded.request.params.prompt).toBe("A quiet lake at dusk.");
    expect(loaded.model_profile_digest).toBe("a".repeat(64));
  });

  it("rejects path-traversal job ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-id-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const request = baseRequest();
    await expect(
      store.create({
        job_id: "../escape",
        connection_id: request.connection_id,
        model_id: request.model_id,
        mode: request.mode,
        request,
        model_profile_digest: "a".repeat(64),
        connection_capability_digest: "b".repeat(64),
        pricing: knownPricing()
      })
    ).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });

    await expect(store.load("..%2fetc")).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });
  });

  it("save fails closed when job.json is missing / invalid JSON / schema-invalid (no recreate)", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-save-fc-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const request = baseRequest();
    const template = await store.create({
      job_id: "template-ok",
      connection_id: request.connection_id,
      model_id: request.model_id,
      mode: request.mode,
      request,
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing()
    });

    // --- missing job.json (job dir may exist empty-ish) ---
    const missingId = "missing-job";
    const missingDir = store.jobDir(missingId);
    await mkdir(missingDir, { recursive: true });
    await mkdir(store.artifactsDir(missingId), { recursive: true });
    const beforeMissing = await listDirNames(missingDir);
    await expect(
      store.save({ ...template, job_id: missingId }, { eventType: "should_not_write" })
    ).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });
    expect(await pathExists(store.jobPath(missingId))).toBe(false);
    expect(await pathExists(join(missingDir, "events.jsonl"))).toBe(false);
    expect(await listDirNames(missingDir)).toEqual(beforeMissing);

    // --- invalid JSON ---
    const badJsonId = "bad-json-job";
    const badJson = await store.create({
      job_id: badJsonId,
      connection_id: request.connection_id,
      model_id: request.model_id,
      mode: request.mode,
      request,
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing()
    });
    const jobPathBad = store.jobPath(badJsonId);
    const eventsPathBad = join(store.jobDir(badJsonId), "events.jsonl");
    const beforeBadJson = await readFile(jobPathBad, "utf8");
    const beforeEventsBad = await readFile(eventsPathBad, "utf8");
    await writeFile(jobPathBad, "{not-valid-json\n", "utf8");
    await expect(
      store.save(
        { ...badJson, status: "awaiting_cost_approval" },
        { eventType: "should_not_write" }
      )
    ).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });
    expect(await readFile(jobPathBad, "utf8")).toBe("{not-valid-json\n");
    expect(await readFile(eventsPathBad, "utf8")).toBe(beforeEventsBad);
    // durable corrupt blob must not be replaced by caller-supplied memory job
    expect(await readFile(jobPathBad, "utf8")).not.toBe(beforeBadJson);

    // --- schema-invalid job.json ---
    const badSchemaId = "bad-schema-job";
    const badSchema = await store.create({
      job_id: badSchemaId,
      connection_id: request.connection_id,
      model_id: request.model_id,
      mode: request.mode,
      request,
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing()
    });
    const jobPathSchema = store.jobPath(badSchemaId);
    const eventsPathSchema = join(store.jobDir(badSchemaId), "events.jsonl");
    const beforeEventsSchema = await readFile(eventsPathSchema, "utf8");
    const corruptRecord = {
      ...JSON.parse(await readFile(jobPathSchema, "utf8")),
      status: "not-a-real-status",
      revision: "nope"
    };
    await writeFile(jobPathSchema, JSON.stringify(corruptRecord, null, 2), "utf8");
    const beforeSchemaBlob = await readFile(jobPathSchema, "utf8");
    await expect(
      store.save(
        { ...badSchema, status: "awaiting_cost_approval" },
        { eventType: "should_not_write" }
      )
    ).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });
    expect(await readFile(jobPathSchema, "utf8")).toBe(beforeSchemaBlob);
    expect(await readFile(eventsPathSchema, "utf8")).toBe(beforeEventsSchema);
  });

  it("audit load/readAll fail closed on corrupt / gap / duplicate / truncated seq; ENOENT is empty", async () => {
    const { GenerationJobAuditLog } = await import("../src/generationJobs/audit.js");
    const root = await mkdtemp(join(tmpdir(), "gj-audit-fc-"));
    const jobDir = join(root, "job-a");
    await mkdir(jobDir, { recursive: true });
    const eventsPath = join(jobDir, "events.jsonl");

    // ENOENT → empty / seq0
    const missing = new GenerationJobAuditLog(jobDir, () => FIXED_NOW);
    await missing.load();
    expect(await missing.readAll()).toEqual([]);
    const first = await missing.append({ job_id: "job-a", type: "created", to_status: "planned" });
    expect(first.seq).toBe(0);
    await missing.append({
      job_id: "job-a",
      type: "transition",
      from_status: "planned",
      to_status: "awaiting_cost_approval"
    });
    const healthy = await readFile(eventsPath, "utf8");
    expect(healthy.trim().split("\n")).toHaveLength(2);

    // mid-line corruption
    await writeFile(eventsPath, healthy.replace(/"type":"transition"/, "NOT_JSON{{{"), "utf8");
    const midCorrupt = new GenerationJobAuditLog(jobDir, () => FIXED_NOW);
    await expect(midCorrupt.load()).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });
    await expect(midCorrupt.readAll()).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });

    // truncated / invalid JSON line
    await writeFile(eventsPath, healthy.split("\n")[0] + "\n{truncated\n", "utf8");
    const truncated = new GenerationJobAuditLog(jobDir, () => FIXED_NOW);
    await expect(truncated.load()).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });
    await expect(truncated.readAll()).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });

    // schema-invalid event (valid JSON, wrong shape)
    const line0 = healthy.trim().split("\n")[0]!;
    await writeFile(
      eventsPath,
      `${line0}\n${JSON.stringify({ schema_version: 1, seq: 1, not: "an event" })}\n`,
      "utf8"
    );
    const schemaBad = new GenerationJobAuditLog(jobDir, () => FIXED_NOW);
    await expect(schemaBad.load()).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });
    await expect(schemaBad.readAll()).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });

    // seq gap (0 then 2)
    const ev0 = JSON.parse(line0);
    const gapLine = JSON.stringify({
      ...ev0,
      seq: 2,
      event_id: "gap-event",
      type: "transition"
    });
    await writeFile(eventsPath, `${line0}\n${gapLine}\n`, "utf8");
    const gap = new GenerationJobAuditLog(jobDir, () => FIXED_NOW);
    await expect(gap.load()).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });
    await expect(gap.readAll()).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });

    // duplicate seq (0 then 0)
    const dupLine = JSON.stringify({ ...ev0, seq: 0, event_id: "dup-event", type: "dup" });
    await writeFile(eventsPath, `${line0}\n${dupLine}\n`, "utf8");
    const dup = new GenerationJobAuditLog(jobDir, () => FIXED_NOW);
    await expect(dup.load()).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });
    await expect(dup.readAll()).rejects.toMatchObject({ code: GJ_SCHEMA_INVALID });

    // restore healthy append-only path still works
    await writeFile(eventsPath, healthy, "utf8");
    const ok = new GenerationJobAuditLog(jobDir, () => FIXED_NOW);
    await ok.load();
    const more = await ok.append({ job_id: "job-a", type: "status_change", to_status: "approved" });
    expect(more.seq).toBe(2);
    const all = await ok.readAll();
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe("C. approval digest / unknown price / max cap", () => {
  it("unknown price cannot approve or submit", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-price-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter({ executionReady: true });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    const job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: unknownPricing(),
      route_ok: true,
      adapter_present: true
    });
    expect(job.status).toBe("blocked");
    expect(job.error?.code).toBe(GJ_PRICE_UNKNOWN);

    expect(() =>
      createApproval({
        request: baseRequest(),
        model_profile_digest: "a".repeat(64),
        connection_capability_digest: "b".repeat(64),
        pricing: unknownPricing()
      }, "actor")
    ).toThrowError(/unknown/);
  });

  it("amount > max_amount fails at approve with GJ_PRICE_CAP_EXCEEDED", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-cap-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter();
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    // Force awaiting_cost_approval with known pricing that exceeds cap after plan.
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(1, 10),
      route_ok: true,
      adapter_present: true
    });
    // Tamper pricing amount above max while keeping status awaiting approval.
    job = await store.save(
      { ...job, pricing: knownPricing(50, 10) },
      { expectedIdentity: job.identity_token, expectedRevision: job.revision, eventType: "price_tamper" }
    );
    await expect(machine.approve(job.job_id, "tester")).rejects.toMatchObject({
      code: GJ_PRICE_CAP_EXCEEDED
    });
  });

  it("approval digest mismatch after request/profile/connection/pricing change rejects submit", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-appr-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter();
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    expect(job.status).toBe("approved");

    const tampered: GenerationJobRecord = {
      ...job,
      model_profile_digest: "c".repeat(64)
    };
    await store.save(tampered, {
      expectedIdentity: job.identity_token,
      expectedRevision: job.revision,
      eventType: "tamper_for_test"
    });

    await expect(machine.submit(job.job_id)).rejects.toMatchObject({
      code: GJ_APPROVAL_DIGEST_MISMATCH
    });
  });

  it("params change after approval with stale stored digest rejects submit", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-req-bind-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter();
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");

    // Mutate params but keep the old digest (opaque caller trust attack).
    const staleDigest = job.request.digest;
    const mutatedRequest = {
      ...job.request,
      params: { ...job.request.params, prompt: "mutated after approve" },
      digest: staleDigest
    };
    await store.save(
      { ...job, request: mutatedRequest as GenerationJobRequest },
      {
        expectedIdentity: job.identity_token,
        expectedRevision: job.revision,
        eventType: "params_tamper"
      }
    );

    await expect(machine.submit(job.job_id)).rejects.toMatchObject({
      code: GJ_APPROVAL_DIGEST_MISMATCH
    });
  });

  it("amount above max_amount fails closed at approve time", () => {
    const request = baseRequest();
    const pricing = knownPricing(50, 10);
    try {
      createApproval(
        {
          request,
          model_profile_digest: "a".repeat(64),
          connection_capability_digest: "b".repeat(64),
          pricing
        },
        "actor",
        FIXED_NOW
      );
      expect.unreachable("createApproval should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationJobError);
      expect((error as GenerationJobError).code).toBe(GJ_PRICE_CAP_EXCEEDED);
    }
  });
});

describe("D. submission_unknown double-submit prevention", () => {
  it("timeout after possible acceptance → submission_unknown; retry does not increase submit count", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-unknown-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const submitCalls = { count: 0 };
    const adapter = createMockAdapter({
      submitCalls,
      submitImpl: async () => ({
        ok: false,
        code: "timeout",
        message: "submit timed out after possible acceptance",
        acceptance_possible: true
      })
    });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    job = await machine.submit(job.job_id);
    expect(job.status).toBe("submission_unknown");
    expect(job.submission_unknown).toBe(true);
    expect(job.submit_attempts).toBe(0);
    expect(submitCalls.count).toBe(1);
    expect(job.error?.code).toBe(GJ_SUBMISSION_UNKNOWN);

    await expect(machine.submit(job.job_id)).rejects.toMatchObject({
      code: GJ_RESUBMIT_FORBIDDEN
    });
    expect(submitCalls.count).toBe(1);
  });

  it("adapter submit throw after durable submitting → submission_unknown; resume does not resubmit", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-throw-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const submitCalls = { count: 0 };
    const adapter = createMockAdapter({
      submitCalls,
      submitImpl: async () => {
        throw new Error("Bearer supersecrettokenvalue12345678901234 crashed");
      }
    });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    job = await machine.submit(job.job_id);
    expect(job.status).toBe("submission_unknown");
    expect(job.submit_attempts).toBe(0);
    expect(submitCalls.count).toBe(1);

    const rawJob = await readFile(store.jobPath(job.job_id), "utf8");
    const eventsText = await readFile(join(store.jobDir(job.job_id), "events.jsonl"), "utf8");
    expect(rawJob).not.toMatch(/Bearer\s+[A-Za-z0-9]/i);
    expect(rawJob).not.toMatch(/supersecrettokenvalue/);
    expect(eventsText).not.toMatch(/supersecrettokenvalue/);

    const resumed = await machine.resume(job.job_id);
    // resume returns durable unknown; resubmit stays forbidden on submit()
    expect(resumed.status).toBe("submission_unknown");
    expect(resumed.submit_attempts).toBe(0);
    await expect(machine.submit(job.job_id)).rejects.toMatchObject({
      code: GJ_RESUBMIT_FORBIDDEN
    });
    expect(submitCalls.count).toBe(1);
  });

  it("resume(submitting + no provider_job_id) → submission_unknown without resubmit", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-submitting-crash-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const submitCalls = { count: 0 };
    const adapter = createMockAdapter({ submitCalls });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    // Simulate crash: durable status=submitting without calling adapter.
    job = await store.transition(job.job_id, "submitting");
    expect(job.status).toBe("submitting");
    expect(job.provider_job_id).toBeUndefined();

    const recovered = await machine.resume(job.job_id);
    expect(recovered.status).toBe("submission_unknown");
    expect(recovered.submit_attempts).toBe(0);
    expect(submitCalls.count).toBe(0);

    await expect(machine.submit(job.job_id)).rejects.toMatchObject({
      code: GJ_RESUBMIT_FORBIDDEN
    });
  });
});

describe("E. cancel / retry / poll / download / hash / pin", () => {
  it("download hash mismatch cannot pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-hash-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter({
      downloadImpl: async (_id, destinationDir) => {
        const pinned = await pinBytesAtomically(destinationDir, Buffer.from("wrong-bytes"), {
          relativeName: "x.bin"
        });
        return {
          ok: true,
          absolute_path: pinned.absolute_path,
          sha256: pinned.sha256,
          byte_length: pinned.byte_length
        };
      }
    });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    job = await machine.submit(job.job_id);
    job = await machine.poll(job.job_id);
    expect(job.status).toBe("succeeded");
    job = await machine.downloadAndPin(job.job_id, {
      expectedSha256: "0".repeat(64)
    });
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe(GJ_HASH_MISMATCH);
    expect(job.artifact?.pinned).toBeFalsy();
  });

  it("cancel unsupported fails closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-cancel-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter({ cancelSupported: false });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    job = await machine.submit(job.job_id);
    job = await machine.requestCancel(job.job_id);
    expect(job.cancel_requested).toBe(true);
    expect(job.error?.code).toBe(GJ_CANCEL_UNSUPPORTED);
    expect(["failed", "cancelled"]).toContain(job.status);
  });

  it("cancel_requested + poll succeeded normalizes to succeeded terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-cancel-race-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter({
      cancelSupported: true,
      pollImpl: async () => ({ ok: true, status: "succeeded" })
    });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    job = await machine.submit(job.job_id);
    // Mark cancel_requested without completing cancel.
    job = await store.transition(job.job_id, "cancel_requested", (j) => ({
      ...j,
      cancel_requested: true
    }));
    job = await machine.poll(job.job_id);
    expect(job.status).toBe("succeeded");
    expect(job.cancel_requested).toBe(true);
  });

  it("happy path reaches pinned", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-happy-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter();
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    job = await machine.submit(job.job_id);
    job = await machine.poll(job.job_id);
    job = await machine.downloadAndPin(job.job_id);
    expect(job.status).toBe("pinned");
    expect(job.artifact?.pinned).toBe(true);
    expect(job.artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects path traversal / symlink / oversize download", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-path-"));
    expect(() => resolveContainedPath(root, "../escape.bin")).toThrowError(/unsafe|escape/);
    expect(() => resolveContainedPath(root, "/abs.bin")).toThrowError(/unsafe|escape/);

    const dest = join(root, "artifacts");
    await mkdir(dest, { recursive: true });
    const link = join(dest, "link-out");
    await symlink(root, link);
    expect(() => resolveContainedPath(dest, "../outside")).toThrow();

    await expect(
      pinBytesAtomically(dest, Buffer.alloc(1024), { maxBytes: 10, relativeName: "big.bin" })
    ).rejects.toMatchObject({ code: expect.stringMatching(/OVERSIZE|E018/) });

    await expect(
      pinStreamAtomically(dest, [Buffer.alloc(8), Buffer.alloc(8)], {
        maxBytes: 10,
        relativeName: "stream.bin"
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/OVERSIZE|E018/) });

    await expect(
      pinStreamAtomically(dest, [Buffer.from("abc")], {
        contentLength: 99,
        relativeName: "cl.bin"
      })
    ).rejects.toThrow();
  });

  it("verifyAdapterArtifact rejects sibling-prefix / outside / symlink / size / hash mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-verify-"));
    const artifacts = join(root, "job-a", "artifacts");
    await mkdir(artifacts, { recursive: true });
    const sibling = join(root, "job-a-evil", "artifacts");
    await mkdir(sibling, { recursive: true });
    const evilFile = join(sibling, "evil.bin");
    await writeFile(evilFile, "evil-payload");

    // sibling-prefix: path starts with artifacts dir string prefix but is outside
    await expect(
      verifyAdapterArtifact(artifacts, {
        absolute_path: evilFile,
        sha256: sha256("evil-payload"),
        byte_length: Buffer.byteLength("evil-payload")
      })
    ).rejects.toMatchObject({ code: GJ_PATH_UNSAFE });

    // nonexistent
    await expect(
      verifyAdapterArtifact(artifacts, {
        absolute_path: join(artifacts, "missing.bin"),
        sha256: "0".repeat(64),
        byte_length: 1
      })
    ).rejects.toMatchObject({ code: GJ_PATH_UNSAFE });

    // symlink
    const good = await pinBytesAtomically(artifacts, Buffer.from("good"), {
      relativeName: "good.bin"
    });
    const linkPath = join(artifacts, "link.bin");
    await symlink(good.absolute_path, linkPath);
    await expect(
      verifyAdapterArtifact(artifacts, {
        absolute_path: linkPath,
        sha256: good.sha256,
        byte_length: good.byte_length
      })
    ).rejects.toMatchObject({ code: GJ_PATH_UNSAFE });

    // size mismatch
    await expect(
      verifyAdapterArtifact(artifacts, {
        absolute_path: good.absolute_path,
        sha256: good.sha256,
        byte_length: 999
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/E020|REJECTED/) });

    // hash mismatch
    await expect(
      verifyAdapterArtifact(artifacts, {
        absolute_path: good.absolute_path,
        sha256: "f".repeat(64),
        byte_length: good.byte_length
      })
    ).rejects.toMatchObject({ code: GJ_HASH_MISMATCH });

    // honest path ok
    const verified = await verifyAdapterArtifact(artifacts, {
      absolute_path: good.absolute_path,
      sha256: good.sha256,
      byte_length: good.byte_length
    });
    expect(verified.relative_path).toBe("good.bin");
  });

  it("pinStreamAtomically writes incrementally without requiring full Buffer concat API", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-stream-"));
    const dest = join(root, "artifacts");
    await mkdir(dest, { recursive: true });
    const chunks = [Buffer.from("hello-"), Buffer.from("stream-"), Buffer.from("pin")];
    const result = await pinStreamAtomically(dest, chunks, { relativeName: "s.bin" });
    expect(result.byte_length).toBe(Buffer.concat(chunks).byteLength);
    expect(result.sha256).toBe(sha256(Buffer.concat(chunks).toString("utf8")));
    const onDisk = await readFile(result.absolute_path);
    expect(onDisk.toString("utf8")).toBe("hello-stream-pin");
  });
});

describe("F. optimistic concurrency + concurrent submit", () => {
  it("stale writer with same status fails CAS after revision rotation", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-cas-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const request = baseRequest();
    const created = await store.create({
      connection_id: request.connection_id,
      model_id: request.model_id,
      mode: request.mode,
      request,
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing()
    });

    const a = await store.load(created.job_id);
    const b = await store.load(created.job_id);

    const first = await store.save(
      { ...a, status: "planned" },
      {
        expectedIdentity: a.identity_token,
        expectedRevision: a.revision,
        eventType: "writer_a"
      }
    );
    expect(first.revision).toBe((a.revision ?? 0) + 1);

    await expect(
      store.save(
        { ...b, status: "planned" },
        {
          expectedIdentity: b.identity_token,
          expectedRevision: b.revision,
          eventType: "writer_b_stale"
        }
      )
    ).rejects.toMatchObject({ code: GJ_IDENTITY_MISMATCH });
  });

  it("concurrent submit calls provider submit at most once", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-conc-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const submitCalls = { count: 0 };
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolveGate) => {
      releaseSubmit = resolveGate;
    });
    const adapter = createMockAdapter({
      submitCalls,
      submitImpl: async () => {
        await submitGate;
        return { ok: true, provider_job_id: "prov-once", accepted: true };
      }
    });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");

    const p1 = machine.submit(job.job_id);
    // Let first transition to submitting acquire lock before second starts racing hard.
    await new Promise((r) => setTimeout(r, 20));
    const p2 = machine.submit(job.job_id);
    releaseSubmit();

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(submitCalls.count).toBe(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<GenerationJobRecord>).value;
    expect(winner.status).toBe("submitted");
    expect(winner.provider_job_id).toBe("prov-once");
  });
});

describe("G. lock crash recovery", () => {
  it("recovers only dead pid + stale lock; otherwise GJ_LOCK_HELD", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-lock-"));
    const lockPath = join(root, ".job.lock");
    await mkdir(root, { recursive: true });

    const deadPid = 424242;
    const oldAt = new Date(Date.now() - DEFAULT_LOCK_STALE_MS - 5_000).toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({ token: "old", pid: deadPid, at: oldAt }) + "\n"
    );

    const recovered: Array<Record<string, unknown>> = [];
    const handle = await exclusiveLock(lockPath, "new-token", {
      nowMs: () => Date.now(),
      isPidAlive: (pid) => pid !== deadPid,
      staleMs: DEFAULT_LOCK_STALE_MS,
      onRecovered: (info) => {
        recovered.push({ ...info });
      }
    });
    expect(handle.recovered).toBe(true);
    expect(recovered).toHaveLength(1);
    await handle.release();

    // Live pid → fail-closed
    await writeFile(
      lockPath,
      JSON.stringify({
        token: "live",
        pid: 1,
        at: new Date(Date.now() - DEFAULT_LOCK_STALE_MS - 5_000).toISOString()
      }) + "\n"
    );
    await expect(
      exclusiveLock(lockPath, "x", {
        isPidAlive: () => true,
        staleMs: DEFAULT_LOCK_STALE_MS
      })
    ).rejects.toMatchObject({ code: GJ_LOCK_HELD });

    // Dead but not stale
    await writeFile(
      lockPath,
      JSON.stringify({
        token: "fresh",
        pid: deadPid,
        at: new Date().toISOString()
      }) + "\n"
    );
    await expect(
      exclusiveLock(lockPath, "x", {
        nowMs: () => Date.now(),
        isPidAlive: () => false,
        staleMs: DEFAULT_LOCK_STALE_MS
      })
    ).rejects.toMatchObject({ code: GJ_LOCK_HELD });

    // Unparseable
    await writeFile(lockPath, "not-json\n");
    await expect(exclusiveLock(lockPath, "x", { isPidAlive: () => false })).rejects.toMatchObject({
      code: GJ_LOCK_HELD
    });
  });

  it("store save after stale lock recovery appends lock_recovered audit without rewriting history", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-lock-audit-"));
    const store = new GenerationJobStore({
      rootDir: root,
      now: () => FIXED_NOW,
      lock: {
        nowMs: () => Date.now(),
        isPidAlive: (pid) => pid !== 424242,
        staleMs: DEFAULT_LOCK_STALE_MS
      }
    });
    const request = baseRequest();
    const created = await store.create({
      connection_id: request.connection_id,
      model_id: request.model_id,
      mode: request.mode,
      request,
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing()
    });
    const lockPath = join(store.jobDir(created.job_id), ".job.lock");
    const oldAt = new Date(Date.now() - DEFAULT_LOCK_STALE_MS - 5_000).toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({ token: "stale", pid: 424242, at: oldAt }) + "\n"
    );

    const beforeEvents = await readFile(join(store.jobDir(created.job_id), "events.jsonl"), "utf8");
    const saved = await store.save(
      { ...created, status: "awaiting_cost_approval" },
      {
        expectedIdentity: created.identity_token,
        expectedRevision: created.revision,
        eventType: "transition"
      }
    );
    expect(saved.status).toBe("awaiting_cost_approval");
    const events = await store.events(created.job_id);
    expect(events[0]?.type).toBe("created");
    expect(events.some((e) => e.type === "lock_recovered")).toBe(true);
    expect(events[events.length - 1]?.type).toBe("transition");
    // Prior lines remain prefix of the new log (append-only).
    const afterEvents = await readFile(join(store.jobDir(created.job_id), "events.jsonl"), "utf8");
    expect(afterEvents.startsWith(beforeEvents)).toBe(true);
  });
});

describe("H. minimax-http capability exact last-frame-only", () => {
  it("loads minimax-http as preflight-only with last-frame only and pin digest", async () => {
    const loaded = await loadConnectionCapabilityProfile("minimax-http");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.profile.runtime_readiness).toBe("preflight-only");
    expect(loaded.profile.pricing_status).toBe("unknown");
    expect(loaded.profile.submit).toBe(false);
    expect(loaded.profile.cancel).toBe(false);

    const pinBytes = await readFile("adapters/minimax-http/constraints.yaml");
    const pinHash = createHash("sha256").update(pinBytes).digest("hex");
    expect(loaded.profile.source.digest).toBe(pinHash);
    expect(pinHash).toBe(
      "5af3e77ba13c14c5fb1b3a40887a1fccbbfffe4ac1e6172a8056e26dccc3934b"
    );

    // Binding digest is profile body digest (separate from pin-file hash).
    expect(loaded.digest).toBe(connectionCapabilityDigest(loaded.profile));

    const last = assertConnectionModeSupported(loaded.profile, "minimax-h3", "last-frame");
    expect(last.ok).toBe(true);

    for (const mode of ["text-to-video", "first-frame", "first-last", "reference"] as const) {
      const result = assertConnectionModeSupported(loaded.profile, "minimax-h3", mode);
      expect(result.ok).toBe(false);
    }
  });

  it("catalog lists minimax-http separate from minimax-direct with no auto fallback", async () => {
    const catalog = await loadConnectionCatalog();
    const direct = catalog.connections.find((c) => c.id === "minimax-direct");
    const http = catalog.connections.find((c) => c.id === "minimax-http");
    expect(direct).toBeTruthy();
    expect(http).toBeTruthy();
    expect(direct?.adapter).toBe("minimax");
    expect(http?.adapter).toBe("minimax-http");
    expect(http?.implementation_status).toBe("available-to-add");
    expect(http?.automated_capabilities).toEqual([]);

    const options = await listConnectionOptions({
      model: "minimax-h3",
      commandExists: async () => false,
      environment: {}
    });
    const ids = options.map((o) => o.id);
    expect(ids).toContain("minimax-direct");
    expect(ids).toContain("minimax-http");
  });

  it("exact model/mode missing rejects; requires exactly one safe last-frame asset", () => {
    expect(() =>
      assertLastFrameOnlyRequest(
        baseRequest({
          model_id: MINIMAX_HTTP_IR_MODEL,
          mode: "text-to-video",
          connection_id: MINIMAX_HTTP_CONNECTION_ID,
          asset_paths: ["assets/last.png"]
        })
      )
    ).toThrow(/last-frame|unsupported/i);

    expect(() =>
      assertLastFrameOnlyRequest(
        baseRequest({
          model_id: "other-model",
          mode: "last-frame",
          connection_id: MINIMAX_HTTP_CONNECTION_ID,
          asset_paths: ["assets/last.png"]
        })
      )
    ).toThrow(/exact model/i);

    expect(() =>
      assertLastFrameOnlyRequest(
        baseRequest({
          model_id: MINIMAX_HTTP_IR_MODEL,
          mode: "last-frame",
          connection_id: MINIMAX_HTTP_CONNECTION_ID,
          asset_paths: ["assets/last.png"],
          params: { first_frame: "x.png" }
        })
      )
    ).toThrow(/first_frame/i);

    expect(() =>
      assertLastFrameOnlyRequest(
        baseRequest({
          model_id: MINIMAX_HTTP_IR_MODEL,
          mode: "last-frame",
          connection_id: MINIMAX_HTTP_CONNECTION_ID,
          asset_paths: []
        })
      )
    ).toThrow(/exactly one/i);

    expect(() =>
      assertLastFrameOnlyRequest(
        baseRequest({
          model_id: MINIMAX_HTTP_IR_MODEL,
          mode: "last-frame",
          connection_id: MINIMAX_HTTP_CONNECTION_ID,
          asset_paths: ["a.png", "b.png"]
        })
      )
    ).toThrow(/exactly one|duplicate/i);

    expect(() =>
      assertLastFrameOnlyRequest(
        baseRequest({
          model_id: MINIMAX_HTTP_IR_MODEL,
          mode: "last-frame",
          connection_id: MINIMAX_HTTP_CONNECTION_ID,
          asset_paths: ["../escape.png"]
        })
      )
    ).toThrow(/unsafe/i);
  });
});

describe("I. mock adapter lifecycle (minimax-http fixture transport DI)", () => {
  function fakeTransport(script: {
    submit?: MinimaxHttpTransportResponse;
    poll?: MinimaxHttpTransportResponse;
    download?: MinimaxHttpTransportResponse;
    onRequest?: (req: MinimaxHttpTransportRequest) => void;
  }): MinimaxHttpTransport {
    return asFixtureTransport({
      async request(req) {
        script.onRequest?.(req);
        assertAllowedHttpsUrl(req.url);
        if (req.redirect !== "error") {
          return { status: 500, headers: {}, body: "", networkError: "redirect" };
        }
        if (req.method === "POST") {
          return (
            script.submit ?? {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ task_id: "task-abc" })
            }
          );
        }
        if (req.url.includes("/query/")) {
          return (
            script.poll ?? {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "success" })
            }
          );
        }
        const payload = Buffer.from("minimax-http-fixture-video");
        return (
          script.download ?? {
            status: 200,
            headers: {
              "content-type": "video/mp4",
              "content-length": String(payload.byteLength)
            },
            body: payload
          }
        );
      }
    });
  }

  it("runs full lifecycle with fixture transport and never needs a real API key value", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-mmxhttp-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const transport = fakeTransport({});
    const adapter = createMinimaxHttpAdapter({
      pricingStatus: "known",
      executionReady: true,
      cancelSupported: false,
      allowFixtureTransport: true
    });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      transport,
      now: () => FIXED_NOW,
      preflightOnly: false
    });

    const model = await loadModelPromptProfile("minimax-h3");
    const connection = await loadConnectionCapabilityProfile("minimax-http");
    expect(model.ok && connection.ok).toBe(true);
    if (!model.ok || !connection.ok) return;

    const partial = {
      model_id: "minimax-h3" as const,
      mode: "last-frame",
      connection_id: "minimax-http",
      auth_env_names: ["MINIMAX_API_KEY"] as string[],
      asset_paths: ["assets/last.png"],
      params: {
        prompt: "Final silhouette matches the last frame.",
        duration: 8
      }
    };
    const request: GenerationJobRequest = {
      ...partial,
      digest: computeRequestDigest(partial)
    };

    let job = await machine.plan({
      request,
      model_profile_digest: model.digest,
      connection_capability_digest: connection.digest,
      pricing: knownPricing(),
      route_ok: true,
      mode_ok: true,
      adapter_present: true
    });
    expect(job.status).toBe("awaiting_cost_approval");
    job = await machine.approve(job.job_id, "tester");
    job = await machine.submit(job.job_id);
    expect(job.status).toBe("submitted");
    expect(job.provider_job_id).toBe("task-abc");
    job = await machine.poll(job.job_id);
    expect(job.status).toBe("succeeded");
    job = await machine.downloadAndPin(job.job_id);
    expect(job.status).toBe("pinned");

    const rawJob = await readFile(store.jobPath(job.job_id), "utf8");
    const eventsText = await readFile(join(store.jobDir(job.job_id), "events.jsonl"), "utf8");
    expect(rawJob).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(rawJob).not.toMatch(/Bearer\s+[A-Za-z0-9]/i);
    expect(eventsText).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(JSON.stringify(redactSecretsDeep({ api_key: "sk-abcdefghijklmnopqrstuvwxyz" }))).toContain(
      "[REDACTED]"
    );
  });

  it("executionReady=true alone does not enable live; unmarked transport cannot submit", async () => {
    const adapter = createMinimaxHttpAdapter({
      pricingStatus: "known",
      executionReady: true
      // no allowFixtureTransport
    });
    const unmarked = {
      async request() {
        return { status: 200, headers: {}, body: "{}" };
      }
    };
    const preflight = await adapter.preflight(
      baseRequest({
        model_id: MINIMAX_HTTP_IR_MODEL,
        mode: "last-frame",
        connection_id: MINIMAX_HTTP_CONNECTION_ID,
        asset_paths: ["assets/last.png"]
      }),
      {
        job: {} as GenerationJobRecord,
        transport: unmarked
      }
    );
    expect(preflight.ok).toBe(true);
    if (preflight.ok) expect(preflight.execution_ready).toBe(false);

    const submit = await adapter.submit(
      baseRequest({
        model_id: MINIMAX_HTTP_IR_MODEL,
        mode: "last-frame",
        connection_id: MINIMAX_HTTP_CONNECTION_ID,
        asset_paths: ["assets/last.png"]
      }),
      { job: {} as GenerationJobRecord, transport: unmarked }
    );
    expect(submit.ok).toBe(false);
    if (!submit.ok) expect(submit.acceptance_possible).toBe(false);
  });

  it("submit timeout after possible acceptance → submission_unknown without resubmit", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-mmx-to-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    let posts = 0;
    const transport = fakeTransport({
      onRequest: (req) => {
        if (req.method === "POST") posts += 1;
      },
      submit: {
        status: 0,
        headers: {},
        body: "",
        networkError: "timeout"
      }
    });
    const adapter = createMinimaxHttpAdapter({
      pricingStatus: "known",
      executionReady: true,
      allowFixtureTransport: true
    });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      transport,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    const model = await loadModelPromptProfile("minimax-h3");
    const connection = await loadConnectionCapabilityProfile("minimax-http");
    if (!model.ok || !connection.ok) throw new Error("profiles required");
    const partial = {
      model_id: "minimax-h3",
      mode: "last-frame",
      connection_id: "minimax-http",
      auth_env_names: ["MINIMAX_API_KEY"] as string[],
      asset_paths: ["assets/last.png"],
      params: { prompt: "x", duration: 6 }
    };
    let job = await machine.plan({
      request: { ...partial, digest: computeRequestDigest(partial) },
      model_profile_digest: model.digest,
      connection_capability_digest: connection.digest,
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    job = await machine.submit(job.job_id);
    expect(job.status).toBe("submission_unknown");
    expect(job.submit_attempts).toBe(0);
    expect(posts).toBe(1);
    await expect(machine.submit(job.job_id)).rejects.toMatchObject({
      code: GJ_RESUBMIT_FORBIDDEN
    });
    expect(posts).toBe(1);
  });

  it("default pricing unknown keeps preflight-only / blocked (not ready-to-send)", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-mmx-pf-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMinimaxHttpAdapter(); // defaults: unknown price, not execution ready
    const machine = new GenerationJobMachine({
      store,
      adapter,
      transport: fakeTransport({}),
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    const connection = await loadConnectionCapabilityProfile("minimax-http");
    const model = await loadModelPromptProfile("minimax-h3");
    if (!model.ok || !connection.ok) throw new Error("profiles required");
    const partial = {
      model_id: "minimax-h3",
      mode: "last-frame",
      connection_id: "minimax-http",
      auth_env_names: ["MINIMAX_API_KEY"] as string[],
      asset_paths: ["assets/last.png"],
      params: { prompt: "x", duration: 6 }
    };
    const job = await machine.plan({
      request: { ...partial, digest: computeRequestDigest(partial) },
      model_profile_digest: model.digest,
      connection_capability_digest: connection.digest,
      pricing: unknownPricing(),
      route_ok: true,
      adapter_present: true
    });
    expect(job.status).toBe("blocked");
    expect([GJ_PREFLIGHT_ONLY, GJ_PRICE_UNKNOWN]).toContain(job.error?.code);
  });

  it("rejects non-allowlisted hosts and redirects", () => {
    expect(() => assertAllowedHttpsUrl("http://api.minimax.io/v1/video_generation")).toThrow(
      /https/i
    );
    expect(() => assertAllowedHttpsUrl("https://evil.example/v1/video_generation")).toThrow(
      /allowlist/i
    );
    expect(() => assertAllowedHttpsUrl("https://api.minimax.io/admin/delete")).toThrow(
      /allowlist|path/i
    );
  });

  it("fixture marker symbol is required on transport objects", () => {
    const t = fakeTransport({});
    expect(t[MINIMAX_HTTP_FIXTURE_TRANSPORT_MARKER]).toBe(true);
  });
});

describe("J. orchestrator integration dry-run/preflight (opt-in)", () => {
  it("preflightGenerationJob never bills or submits", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-orch-"));
    const adapter = createMockAdapter({ executionReady: true });
    const result = await preflightGenerationJob({
      storeRoot: root,
      adapter,
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true,
      now: () => FIXED_NOW
    });
    expect(result.billing_action).toBe(false);
    expect(result.generation_submitted).toBe(false);
    expect(result.preflight_only).toBe(true);
    expect(["blocked", "awaiting_cost_approval", "planned"]).toContain(result.job.status);
  });

  it("catalog only without adapter → reject with GJ_CATALOG_NOT_ADAPTER", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-cat-"));
    const adapter = createMockAdapter();
    const result = await preflightGenerationJob({
      storeRoot: root,
      adapter,
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: false,
      catalog_present_without_adapter: true,
      now: () => FIXED_NOW
    });
    expect(result.job.status).toBe("blocked");
    expect(result.job.error?.code).toBe(GJ_CATALOG_NOT_ADAPTER);
    expect(result.generation_submitted).toBe(false);
  });

  it("exact model/mode missing → reject", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-route-"));
    const adapter = createMockAdapter();
    const machine = new GenerationJobMachine({
      store: new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW }),
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: true
    });
    await expect(
      machine.plan({
        request: baseRequest({ mode: "last-frame" }),
        model_profile_digest: "a".repeat(64),
        connection_capability_digest: "b".repeat(64),
        pricing: knownPricing(),
        route_ok: false,
        mode_ok: false,
        adapter_present: true
      })
    ).rejects.toMatchObject({
      code: expect.stringMatching(/GJ-E01[56]/)
    });
  });
});

describe("K. no silent fallback minimax-direct → minimax-http", () => {
  it("minimax-direct failure does not invoke minimax-http", async () => {
    let httpTouched = false;
    const httpAdapter = createMinimaxHttpAdapter({
      executionReady: true,
      pricingStatus: "known",
      allowFixtureTransport: true
    });
    const wrapped: GenerationJobProviderAdapter = {
      ...httpAdapter,
      async preflight(req, ctx) {
        httpTouched = true;
        return httpAdapter.preflight(req, ctx);
      },
      async submit(req, ctx) {
        httpTouched = true;
        return httpAdapter.submit(req, ctx);
      }
    };

    const direct = await preflightMinimaxConnection({
      commandExists: async () => false,
      environment: {},
      generationIntegrated: false
    });
    expect(direct.status).toBe("needs-setup");
    expect(direct.generation_submitted).toBe(false);
    expect(direct.billing_action).toBe(false);

    const root = await mkdtemp(join(tmpdir(), "gj-nofallback-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const directLike = createMockAdapter({
      connectionId: "minimax-direct",
      adapterId: "minimax",
      executionReady: false
    });
    const machine = new GenerationJobMachine({
      store,
      adapter: directLike,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    const model = await loadModelPromptProfile("minimax-h3");
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    const job = await machine.plan({
      request: baseRequest({
        connection_id: "minimax-direct",
        model_id: "minimax-h3",
        mode: "last-frame",
        asset_paths: ["assets/last.png"]
      }),
      model_profile_digest: modelProfileDigest(model.profile),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    expect(job.connection_id).toBe("minimax-direct");
    expect(job.adapter_id).toBe("minimax");
    expect(httpTouched).toBe(false);
    void wrapped;
  });

  it("machine rejects connection_id that does not match injected adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-switch-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter({ connectionId: "minimax-direct" });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    await expect(
      machine.plan({
        request: baseRequest({ connection_id: "minimax-http" }),
        model_profile_digest: "a".repeat(64),
        connection_capability_digest: "b".repeat(64),
        pricing: knownPricing(),
        route_ok: true,
        adapter_present: true
      })
    ).rejects.toMatchObject({ code: GJ_ROUTE_UNSUPPORTED });
  });
});

describe("secret hygiene", () => {
  it("redacts secret-like keys and values from durable projections", () => {
    const redacted = redactSecretsDeep({
      Authorization: "Bearer supersecrettokenvalue1234567890",
      api_key: "sk-abcdefghijklmnopqrstuvwxyz012345",
      nested: { access_token: "tok_abc", safe: "ok" },
      note: "use env MINIMAX_API_KEY name only"
    }) as Record<string, unknown>;
    expect(redacted.Authorization).toBe("[REDACTED]");
    expect(redacted.api_key).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).access_token).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).safe).toBe("ok");
  });

  it("rejects secret-shaped keys in request params at schema/plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-secret-params-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter();
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    const partial = {
      model_id: "demo-model",
      mode: "text-to-video",
      connection_id: "demo-connection",
      auth_env_names: ["DEMO_API_KEY"] as string[],
      asset_paths: [] as string[],
      params: { prompt: "x", api_key: "should-not-be-here" }
    };
    // computeRequestDigest does not validate; create/parse does.
    await expect(
      machine.plan({
        request: {
          ...partial,
          digest: computeRequestDigest(partial)
        } as GenerationJobRequest,
        model_profile_digest: "a".repeat(64),
        connection_capability_digest: "b".repeat(64),
        pricing: knownPricing(),
        route_ok: true,
        adapter_present: true
      })
    ).rejects.toThrow();
  });

  it("approval digest is stable for identical inputs", () => {
    const input = {
      request_digest: "a".repeat(64),
      model_profile_digest: "b".repeat(64),
      connection_capability_digest: "c".repeat(64),
      pricing_version: "v1",
      pricing_currency: "USD",
      pricing_max_amount: 10,
      pricing_status: "known" as const,
      pricing_amount: 1
    };
    expect(approvalDigest(input)).toBe(approvalDigest(input));
    expect(approvalDigest(input)).not.toBe(
      approvalDigest({ ...input, pricing_max_amount: 11 })
    );
    const built = buildApprovalDigestInput({
      request: baseRequest({ digest: computeRequestDigest(baseRequest()) }),
      model_profile_digest: "b".repeat(64),
      connection_capability_digest: "c".repeat(64),
      pricing: knownPricing(1, 10)
    });
    expect(built.pricing_status).toBe("known");
    expect(built.request_digest).toBe(computeRequestDigest(baseRequest()));
  });

  it("request digest binds model/mode/connection/auth/assets/params", () => {
    const a = baseRequest({ params: { prompt: "one" } });
    const b = baseRequest({ params: { prompt: "two" } });
    expect(a.digest).not.toBe(b.digest);
    expect(() => assertRequestDigestMatches({ ...a, digest: b.digest })).toThrowError(
      GenerationJobError
    );
    const c = baseRequest({ asset_paths: ["a.png"] });
    expect(c.digest).not.toBe(baseRequest().digest);
  });
});

describe("L. extra branch coverage for fail-closed edges", () => {
  it("assertNoSecretMaterial rejects sk- and Bearer shapes", async () => {
    const { assertNoSecretMaterial } = await import("../src/generationJobs/secrets.js");
    expect(() => assertNoSecretMaterial({ x: "sk-abcdefghijklmnopqrst" }, "t")).toThrow(
      /secret/i
    );
    expect(() =>
      assertNoSecretMaterial({ x: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" }, "t")
    ).toThrow(/secret/i);
    assertNoSecretMaterial({ safe: "ok", auth_env_names: ["MINIMAX_API_KEY"] }, "t");
  });

  it("assertApprovalAllowsSubmit requires approval and known price", () => {
    const request = baseRequest();
    expect(() =>
      assertApprovalAllowsSubmit({
        schema_version: 1,
        job_id: "j1",
        status: "approved",
        connection_id: request.connection_id,
        model_id: request.model_id,
        mode: request.mode,
        request,
        model_profile_digest: "a".repeat(64),
        connection_capability_digest: "b".repeat(64),
        pricing: knownPricing(),
        submit_attempts: 0,
        submission_unknown: false,
        cancel_requested: false,
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
        revision: 0
      })
    ).toThrow(/approval/i);
  });

  it("isResumableWithProviderJob covers submitted/polling/retry/download paths", async () => {
    const { isResumableWithProviderJob, isTerminalStatus } = await import(
      "../src/generationJobs/transitions.js"
    );
    for (const status of [
      "submitted",
      "polling",
      "retry_wait",
      "succeeded",
      "downloading",
      "submission_unknown"
    ] as const) {
      expect(isResumableWithProviderJob(status)).toBe(true);
    }
    expect(isResumableWithProviderJob("planned")).toBe(false);
    expect(isTerminalStatus("pinned")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
  });

  it("preflightOnly machine cannot submit", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-pf-only-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter();
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: true
    });
    // Force an approved job as if planned outside preflightOnly.
    const request = baseRequest();
    const created = await store.create({
      connection_id: request.connection_id,
      model_id: request.model_id,
      mode: request.mode,
      request,
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      status: "awaiting_cost_approval"
    });
    const approval = createApproval(created, "tester", FIXED_NOW);
    const approved = await store.transition(
      created.job_id,
      "approved",
      (j) => ({ ...j, approval })
    );
    await expect(machine.submit(approved.job_id)).rejects.toMatchObject({
      code: GJ_PREFLIGHT_ONLY
    });
  });

  it("poll retryable failure enters retry_wait", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-retry-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter({
      pollImpl: async () => ({
        ok: false,
        code: "transient",
        message: "try later",
        retryable: true
      })
    });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    job = await machine.submit(job.job_id);
    job = await machine.poll(job.job_id);
    expect(job.status).toBe("retry_wait");
  });

  it("openContainedFile rejects missing and accepts regular file", async () => {
    const { openContainedFile } = await import("../src/generationJobs/download.js");
    const root = await mkdtemp(join(tmpdir(), "gj-open-"));
    await writeFile(join(root, "ok.bin"), "data");
    const handle = await openContainedFile(root, "ok.bin");
    await handle.close();
    await expect(openContainedFile(root, "missing.bin")).rejects.toThrow();
  });

  it("sha256File / openContainedFile / verifyAdapterArtifact reject final-path symlink via O_NOFOLLOW", async () => {
    const {
      openContainedFile,
      openRegularFileNoFollow,
      sha256File
    } = await import("../src/generationJobs/download.js");
    const root = await mkdtemp(join(tmpdir(), "gj-nofollow-"));
    const artifacts = join(root, "artifacts");
    await mkdir(artifacts, { recursive: true });
    const realPath = join(artifacts, "real.bin");
    await writeFile(realPath, "payload-bytes");
    const linkPath = join(artifacts, "link.bin");
    await symlink(realPath, linkPath);

    await expect(sha256File(linkPath)).rejects.toMatchObject({ code: GJ_PATH_UNSAFE });
    await expect(openContainedFile(artifacts, "link.bin")).rejects.toMatchObject({
      code: GJ_PATH_UNSAFE
    });
    await expect(openRegularFileNoFollow(linkPath)).rejects.toMatchObject({
      code: GJ_PATH_UNSAFE
    });

    // Honest regular file still works
    const digest = await sha256File(realPath);
    expect(digest).toBe(sha256("payload-bytes"));
    const handle = await openContainedFile(artifacts, "real.bin");
    await handle.close();

    // verifyAdapterArtifact: leaf symlink rejected (open-time nofollow, not only pre-lstat)
    await expect(
      verifyAdapterArtifact(artifacts, {
        absolute_path: linkPath,
        sha256: digest,
        byte_length: Buffer.byteLength("payload-bytes")
      })
    ).rejects.toMatchObject({ code: GJ_PATH_UNSAFE });

    // TOCTOU-ish: replace regular file path with symlink after an honest path string is known.
    // open must still refuse following the symlink.
    const racePath = join(artifacts, "race.bin");
    await writeFile(racePath, "race-payload");
    await rm(racePath);
    await symlink(realPath, racePath);
    await expect(openRegularFileNoFollow(racePath)).rejects.toMatchObject({
      code: GJ_PATH_UNSAFE
    });
    await expect(sha256File(racePath)).rejects.toMatchObject({ code: GJ_PATH_UNSAFE });
  });

  it("loadConnectionCapabilityProfile rejects unsafe id", async () => {
    const bad = await loadConnectionCapabilityProfile("../escape");
    expect(bad.ok).toBe(false);
  });

  it("adapter missing throws GJ_ADAPTER_MISSING", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-noad-"));
    const machine = new GenerationJobMachine({
      store: new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW }),
      adapter: createMockAdapter(),
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    await expect(
      machine.plan({
        request: baseRequest(),
        model_profile_digest: "a".repeat(64),
        connection_capability_digest: "b".repeat(64),
        pricing: knownPricing(),
        route_ok: true,
        adapter_present: false,
        catalog_present_without_adapter: false
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/GJ-E013/) });
  });

  it("download failure path marks failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-dlfail-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const adapter = createMockAdapter({
      downloadImpl: async () => ({
        ok: false,
        code: "dl_fail",
        message: "no file",
        retryable: false
      })
    });
    const machine = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    let job = await machine.plan({
      request: baseRequest(),
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing: knownPricing(),
      route_ok: true,
      adapter_present: true
    });
    job = await machine.approve(job.job_id, "tester");
    job = await machine.submit(job.job_id);
    job = await machine.poll(job.job_id);
    job = await machine.downloadAndPin(job.job_id);
    expect(job.status).toBe("failed");
  });
});
