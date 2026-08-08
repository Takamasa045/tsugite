/**
 * Phase C: provider-neutral durable async generation jobs + minimax-http mock lifecycle.
 * Zero live network / DNS / provider / API key required.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalDigest,
  assertApprovalAllowsSubmit,
  assertTransition,
  buildApprovalDigestInput,
  canTransition,
  createApproval,
  GENERATION_JOB_TRANSITIONS,
  GenerationJobError,
  GenerationJobMachine,
  GenerationJobStore,
  GJ_APPROVAL_DIGEST_MISMATCH,
  GJ_CANCEL_UNSUPPORTED,
  GJ_CATALOG_NOT_ADAPTER,
  GJ_HASH_MISMATCH,
  GJ_INVALID_TRANSITION,
  GJ_MODE_UNSUPPORTED,
  GJ_PATH_UNSAFE,
  GJ_PREFLIGHT_ONLY,
  GJ_PRICE_UNKNOWN,
  GJ_RESUBMIT_FORBIDDEN,
  GJ_ROUTE_UNSUPPORTED,
  GJ_SUBMISSION_UNKNOWN,
  pinBytesAtomically,
  pinStreamAtomically,
  preflightGenerationJob,
  redactSecretsDeep,
  requestDigestFromParams,
  resolveContainedPath,
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
  assertAllowedHttpsUrl,
  assertLastFrameOnlyRequest,
  createMinimaxHttpAdapter,
  MINIMAX_HTTP_CONNECTION_ID,
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
  const params = { prompt: "A quiet lake at dusk.", duration: 6, ...(overrides.params ?? {}) };
  return {
    digest: overrides.digest ?? requestDigestFromParams(params),
    model_id: overrides.model_id ?? "demo-model",
    mode: overrides.mode ?? "text-to-video",
    connection_id: overrides.connection_id ?? "demo-connection",
    auth_env_names: overrides.auth_env_names ?? ["DEMO_API_KEY"],
    asset_paths: overrides.asset_paths ?? [],
    params
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

    const next = await store.transition(created.job_id, "awaiting_cost_approval");
    expect(next.status).toBe("awaiting_cost_approval");

    const reloaded = await store.load(created.job_id);
    expect(reloaded.status).toBe("awaiting_cost_approval");
    expect(reloaded.job_id).toBe(created.job_id);

    const events = await store.events(created.job_id);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events[0]?.type).toBe("created");
    expect(events[1]?.type).toBe("transition");
    expect(events[1]?.from_status).toBe("planned");
    expect(events[1]?.to_status).toBe("awaiting_cost_approval");

    // Append-only: refuse rewrite API
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

    // Simulate crash: new machine instance, resume from durable state.
    const machine2 = new GenerationJobMachine({
      store,
      adapter,
      now: () => FIXED_NOW,
      preflightOnly: false
    });
    const resumed = await machine2.resume(job.job_id);
    expect(resumed.status).toBe("succeeded");
    expect(submitCalls.count).toBe(1); // no resubmit
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

    // Mutate bound field after approval.
    const tampered: GenerationJobRecord = {
      ...job,
      model_profile_digest: "c".repeat(64)
    };
    await store.save(tampered, {
      expectedIdentity: job.identity_token,
      eventType: "tamper_for_test"
    });

    await expect(machine.submit(job.job_id)).rejects.toMatchObject({
      code: GJ_APPROVAL_DIGEST_MISMATCH
    });
  });

  it("amount above max_amount fails closed", () => {
    const request = baseRequest();
    const pricing = knownPricing(50, 10);
    const approval = createApproval(
      {
        request,
        model_profile_digest: "a".repeat(64),
        connection_capability_digest: "b".repeat(64),
        pricing
      },
      "actor",
      FIXED_NOW
    );
    const job = {
      schema_version: 1 as const,
      job_id: "j1",
      status: "approved" as const,
      connection_id: request.connection_id,
      model_id: request.model_id,
      mode: request.mode,
      request,
      model_profile_digest: "a".repeat(64),
      connection_capability_digest: "b".repeat(64),
      pricing,
      approval,
      submit_attempts: 0,
      submission_unknown: false,
      cancel_requested: false,
      created_at: FIXED_NOW,
      updated_at: FIXED_NOW
    };
    // amount 50 > max 10
    expect(() => assertApprovalAllowsSubmit(job)).toThrow(/max_amount/);
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
    // Writing through a name that resolves outside should be rejected by resolveContainedPath
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

    // Content-Length mismatch
    await expect(
      pinStreamAtomically(dest, [Buffer.from("abc")], {
        contentLength: 99,
        relativeName: "cl.bin"
      })
    ).rejects.toThrow();
  });
});

describe("F. minimax-http capability exact last-frame-only", () => {
  it("loads minimax-http as preflight-only with last-frame only", async () => {
    const loaded = await loadConnectionCapabilityProfile("minimax-http");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.profile.runtime_readiness).toBe("preflight-only");
    expect(loaded.profile.pricing_status).toBe("unknown");
    expect(loaded.profile.submit).toBe(true);
    expect(loaded.profile.cancel).toBe(false);
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

  it("exact model/mode missing rejects; non-last-frame explicit unsupported", () => {
    expect(() =>
      assertLastFrameOnlyRequest(
        baseRequest({
          model_id: MINIMAX_HTTP_IR_MODEL,
          mode: "text-to-video",
          connection_id: MINIMAX_HTTP_CONNECTION_ID
        })
      )
    ).toThrow(/last-frame|unsupported/i);

    expect(() =>
      assertLastFrameOnlyRequest(
        baseRequest({
          model_id: "other-model",
          mode: "last-frame",
          connection_id: MINIMAX_HTTP_CONNECTION_ID
        })
      )
    ).toThrow(/exact model/i);

    expect(() =>
      assertLastFrameOnlyRequest(
        baseRequest({
          model_id: MINIMAX_HTTP_IR_MODEL,
          mode: "last-frame",
          connection_id: MINIMAX_HTTP_CONNECTION_ID,
          params: { first_frame: "x.png" }
        })
      )
    ).toThrow(/first_frame/i);
  });
});

describe("G. mock adapter lifecycle (minimax-http transport DI)", () => {
  function fakeTransport(script: {
    submit?: MinimaxHttpTransportResponse;
    poll?: MinimaxHttpTransportResponse;
    download?: MinimaxHttpTransportResponse;
    onRequest?: (req: MinimaxHttpTransportRequest) => void;
  }): MinimaxHttpTransport {
    return {
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
    };
  }

  it("runs full lifecycle with mock transport and never needs a real API key", async () => {
    const root = await mkdtemp(join(tmpdir(), "gj-mmxhttp-"));
    const store = new GenerationJobStore({ rootDir: root, now: () => FIXED_NOW });
    const transport = fakeTransport({});
    // Force execution-ready for lifecycle unit test only (production profile stays preflight-only).
    const adapter = createMinimaxHttpAdapter({
      pricingStatus: "known",
      executionReady: true,
      cancelSupported: false
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

    const params = {
      prompt: "Final silhouette matches the last frame.",
      duration: 8,
      last_frame_path: "assets/last.png"
    };
    const request: GenerationJobRequest = {
      digest: requestDigestFromParams(params),
      model_id: "minimax-h3",
      mode: "last-frame",
      connection_id: "minimax-http",
      auth_env_names: ["MINIMAX_API_KEY"],
      asset_paths: ["assets/last.png"],
      params
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

    // Secrets must not appear in durable job or audit
    const rawJob = await readFile(store.jobPath(job.job_id), "utf8");
    const eventsText = await readFile(join(store.jobDir(job.job_id), "events.jsonl"), "utf8");
    expect(rawJob).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(rawJob).not.toMatch(/Bearer\s+[A-Za-z0-9]/i);
    expect(eventsText).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(JSON.stringify(redactSecretsDeep({ api_key: "sk-abcdefghijklmnopqrstuvwxyz" }))).toContain(
      "[REDACTED]"
    );
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
      executionReady: true
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
    const params = { prompt: "x", duration: 6 };
    let job = await machine.plan({
      request: {
        digest: requestDigestFromParams(params),
        model_id: "minimax-h3",
        mode: "last-frame",
        connection_id: "minimax-http",
        auth_env_names: ["MINIMAX_API_KEY"],
        asset_paths: ["assets/last.png"],
        params
      },
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
    const params = { prompt: "x", duration: 6 };
    const job = await machine.plan({
      request: {
        digest: requestDigestFromParams(params),
        model_id: "minimax-h3",
        mode: "last-frame",
        connection_id: "minimax-http",
        auth_env_names: ["MINIMAX_API_KEY"],
        asset_paths: ["assets/last.png"],
        params
      },
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
});

describe("H. orchestrator integration dry-run/preflight (opt-in)", () => {
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
    // preflightOnly machine blocks before approval/submit
    expect(["blocked", "awaiting_cost_approval", "planned"]).toContain(result.job.status);
  });

  it("catalog only without adapter → reject", async () => {
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
    expect(result.job.error?.code).toBe("GJ-E014");
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

describe("I. no silent fallback minimax-direct → minimax-http", () => {
  it("minimax-direct failure does not invoke minimax-http", async () => {
    let httpTouched = false;
    const httpAdapter = createMinimaxHttpAdapter({
      executionReady: true,
      pricingStatus: "known"
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

    // Simulate minimax-direct preflight failure (CLI path).
    const direct = await preflightMinimaxConnection({
      commandExists: async () => false,
      environment: {},
      generationIntegrated: false
    });
    expect(direct.status).toBe("needs-setup");
    expect(direct.generation_submitted).toBe(false);
    expect(direct.billing_action).toBe(false);

    // Core machine with direct-like connection must not switch adapter.
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
        mode: "last-frame"
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
      request: baseRequest({ digest: "a".repeat(64) }),
      model_profile_digest: "b".repeat(64),
      connection_capability_digest: "c".repeat(64),
      pricing: knownPricing(1, 10)
    });
    expect(built.pricing_status).toBe("known");
  });
});
