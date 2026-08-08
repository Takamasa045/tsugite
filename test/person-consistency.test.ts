/**
 * Person consistency QA (H3 Prompt Director Phase B) — TDD suite.
 * No provider / network calls. Fixture and manual adapters only.
 */
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSchema } from "../src/project/schema.js";
import { h3CreativeIrSchema } from "../src/h3/schema.js";
import {
  assertExternalExecutionAllowed,
  buildExternalPayloadPreview,
  buildFixtureReport,
  buildGateApprovalWithPersonQa,
  buildSamplingPlan,
  checkRequiredTraitsSupported,
  compilePersonConsistencyRequirements,
  digestTechnicalQc,
  evaluateGate2AutoPassWithPersonQa,
  fixtureCapability,
  isExternalAdapterConnected,
  issuesForOuterGateWithPersonQaDecision,
  loadPersonConsistencyReport,
  loadPersonQaApprovalBinding,
  mapPreservationToTraitRequirements,
  parsePersonConsistencyPolicy,
  parsePersonConsistencyReport,
  parsePersonQaHumanDecision,
  parseSemanticQaAdapterInput,
  parseSemanticQaCapability,
  personConsistencyRequiredForStage,
  revalidatePersonConsistencyForFinalize,
  revalidatePersonConsistencyOnFinalize,
  buildPersonQaApprovalBinding,
  writePersonQaApprovalBinding,
  resolveSafeRunArtifactPath,
  resolveSemanticQaAdapter,
  toViewerPersonConsistencyEvidence,
  validateContactSheetArtifact,
  validatePersonConsistencyAgainstAutoPass,
  validatePersonQaDecisionAgainstReport,
  type PersonConsistencyPolicyV1,
  type PersonConsistencyReportV1
} from "../src/qa/personConsistency/index.js";
import { createViewerWorkflow } from "../src/viewer/workflow.js";
import type { ExecutionPlan } from "../src/orchestrator/plan.js";
import type { Project } from "../src/project/schema.js";

const POLICY: PersonConsistencyPolicyV1 = {
  enabled: true,
  adapter: "person-consistency-fixture",
  fallback: "fail",
  stages: ["gate_2", "gate_3"],
  evidence: {
    sampling: "shot-boundaries-and-uniform",
    frames_per_shot: 4,
    retain_face_embeddings: false
  },
  external: { allowed: false }
};

const HEX = "a".repeat(64);

function baseReport(overrides: Partial<PersonConsistencyReportV1> = {}): PersonConsistencyReportV1 {
  const body = {
    schema_version: "person-consistency-report-v1" as const,
    stage: "gate_2" as const,
    status: "ok" as const,
    input_digest: HEX,
    subject_reference_hashes: {},
    tracks: [],
    subjects: [
      {
        subject_id: "hero",
        basis: "reference" as const,
        traits: [
          { trait: "identity" as const, status: "stable" as const, level: "required" as const }
        ],
        observations: [
          {
            timestamp_ms: 0,
            shot_id: "shot_1",
            visibility: "visible" as const,
            face_evaluable: true,
            reason: "face clear in fixture",
            track_id: "t1"
          }
        ],
        evaluable_coverage: 1,
        ambiguity_codes: []
      }
    ],
    sampling_plan: [
      { shot_id: "shot_1", timestamp_ms: 0, role: "boundary_start" as const }
    ],
    provenance: {
      adapter: "person-consistency-fixture",
      adapter_class: "semantic-qa" as const,
      model: "fixture",
      version: "1.0.0",
      network_used: false,
      network_input_scope: "none"
    },
    artifacts: {
      report_relative_path: "qa/person-consistency/gate2/report.json"
    },
    ambiguities: [],
    blocked_reasons: [],
    ...overrides
  };
  return body as PersonConsistencyReportV1;
}

describe("person consistency policy schema", () => {
  it("parses a valid policy and keeps disabled projects compatible", () => {
    const ok = parsePersonConsistencyPolicy(POLICY);
    expect(ok.ok).toBe(true);
    expect(ok.policy?.enabled).toBe(true);

    const disabled = parsePersonConsistencyPolicy(undefined);
    expect(disabled.ok).toBe(true);
    expect(disabled.policy).toBeUndefined();

    const legacy = projectSchema.safeParse({
      slug: "legacy",
      name: "legacy",
      manifest: "manifest.json",
      edit: { backend: "remotion" }
    });
    expect(legacy.success).toBe(true);
    expect(legacy.data?.quality).toBeUndefined();
  });

  it("rejects retain_face_embeddings true and unknown external fallback", () => {
    const bad = parsePersonConsistencyPolicy({
      ...POLICY,
      evidence: { ...POLICY.evidence, retain_face_embeddings: true }
    });
    expect(bad.ok).toBe(false);

    const project = projectSchema.safeParse({
      slug: "pc",
      name: "pc",
      manifest: "manifest.json",
      edit: { backend: "remotion" },
      quality: {
        person_consistency: {
          ...POLICY,
          fallback: "external"
        }
      }
    });
    expect(project.success).toBe(false);
  });

  it("forbids Gate 2 auto-pass when person consistency is enabled", () => {
    const issues = validatePersonConsistencyAgainstAutoPass({
      quality: { person_consistency: POLICY },
      gates: { gate_2: { auto_pass: "qc_ok_no_new_assets" } }
    });
    expect(issues[0]?.code).toBe("person_qa.auto_pass_forbidden");

    const parsed = projectSchema.safeParse({
      slug: "pc",
      name: "pc",
      manifest: "manifest.json",
      edit: { backend: "remotion" },
      quality: { person_consistency: POLICY },
      gates: { gate_2: { auto_pass: "qc_ok_no_new_assets" } }
    });
    expect(parsed.success).toBe(false);

    const auto = evaluateGate2AutoPassWithPersonQa({
      project: { quality: { person_consistency: POLICY } },
      basePassed: true
    });
    expect(auto).toEqual({ passed: false, reason: "semantic_qa_enabled" });
  });
});

describe("strict/loose trait mapping and H3 subject expectations", () => {
  it("maps strict to required and loose to advisory; omits unspecified traits", () => {
    const traits = mapPreservationToTraitRequirements({
      identity: "strict",
      clothing: "loose"
    });
    expect(traits).toEqual([
      { trait: "identity", level: "required", preservation: "strict" },
      { trait: "clothing", level: "advisory", preservation: "loose" }
    ]);
    expect(mapPreservationToTraitRequirements(undefined)).toEqual([]);
  });

  it("does not imply face recognition when preservation missing or consistency disabled", () => {
    const compiled = compilePersonConsistencyRequirements({
      policy: POLICY,
      stage: "gate_2",
      subjects: [
        { id: "a", preservation: { identity: "strict" } },
        { id: "b", consistency: { enabled: true } },
        {
          id: "c",
          source_asset: "ref",
          consistency: { enabled: true },
          preservation: { identity: "strict", hairstyle: "loose" }
        }
      ],
      shots: [{ id: "s1", start_ms: 0, end_ms: 1000 }],
      assets: [{ id: "ref", path: "assets/ref.png", sha256: HEX }]
    });
    expect(compiled.ok).toBe(true);
    const active = compiled.compiled!.active_subjects;
    expect(active.map((s) => s.subject_id)).toEqual(["c"]);
    expect(active[0].basis).toBe("reference");
    expect(active[0].required_traits).toEqual(["identity"]);
    expect(active[0].advisory_traits).toEqual(["hairstyle"]);
  });

  it("accepts H3 subject consistency and shot subject_expectations", () => {
    const ir = h3CreativeIrSchema.safeParse({
      version: 1,
      target: {
        model: "minimax-h3",
        mode: "text-to-video",
        duration: 6,
        quality: "768p",
        aspect: "16:9",
        audio: false
      },
      subjects: [
        {
          id: "hero",
          description: "person",
          source_asset: "face",
          preservation: { identity: "strict" },
          consistency: {
            enabled: true,
            reference_region: { x: 0.1, y: 0.1, width: 0.4, height: 0.5 }
          }
        }
      ],
      assets: [{ id: "face", type: "image", path: "assets/face.png", role: "subject_reference" }],
      shots: [
        {
          id: "shot_1",
          start_ms: 0,
          end_ms: 3000,
          visual: "a person walks",
          subject_expectations: [
            {
              subject_id: "hero",
              visibility: "visible",
              face_visibility: "required"
            }
          ]
        }
      ],
      sound: { soundscape: "quiet room", music: { enabled: false } }
    });
    expect(ir.success).toBe(true);
  });

  it("blocks multi-face reference without reference_region (no largest-face guess)", () => {
    const compiled = compilePersonConsistencyRequirements({
      policy: POLICY,
      stage: "gate_2",
      subjects: [
        {
          id: "hero",
          source_asset: "crowd",
          consistency: { enabled: true },
          preservation: { identity: "strict" }
        }
      ],
      shots: [{ id: "s1", start_ms: 0, end_ms: 1000 }],
      multiFaceReferenceSubjects: new Set(["hero"])
    });
    expect(compiled.ok).toBe(true);
    expect(compiled.compiled!.active_subjects[0].reference_ambiguous).toBe(true);
    expect(compiled.compiled!.active_subjects[0].blocked_reasons).toContain("reference_ambiguous");
  });
});

describe("deterministic sampling", () => {
  it("includes shot boundaries and uniform frames up to frames_per_shot", () => {
    const plan = buildSamplingPlan(
      [
        { id: "s1", start_ms: 0, end_ms: 1000 },
        { id: "s2", start_ms: 1000, end_ms: 3000 }
      ],
      4
    );
    const s1 = plan.filter((f) => f.shot_id === "s1");
    expect(s1[0]).toMatchObject({ role: "boundary_start", timestamp_ms: 0 });
    expect(s1.some((f) => f.role === "boundary_end")).toBe(true);
    expect(s1.length).toBeLessThanOrEqual(4);
    expect(s1.map((f) => f.timestamp_ms)).toEqual([...s1.map((f) => f.timestamp_ms)].sort((a, b) => a - b));

    // Deterministic across calls
    expect(buildSamplingPlan([{ id: "s1", start_ms: 0, end_ms: 1000 }], 3)).toEqual(
      buildSamplingPlan([{ id: "s1", start_ms: 0, end_ms: 1000 }], 3)
    );
  });
});

describe("fixture adapter: occlusion, no face, multi person, embeddings", () => {
  it("treats no face as not-evaluable identity, not failure", async () => {
    const compiled = compilePersonConsistencyRequirements({
      policy: POLICY,
      stage: "gate_2",
      subjects: [
        {
          id: "hero",
          consistency: { enabled: true },
          preservation: { identity: "strict", clothing: "strict" }
        }
      ],
      shots: [{ id: "s1", start_ms: 0, end_ms: 1000 }]
    });
    const input = {
      stage: "gate_2" as const,
      input_digest: compiled.compiled!.input_digest,
      sampling_plan: compiled.compiled!.sampling_plan,
      subjects: [
        {
          subject_id: "hero",
          required_traits: ["identity", "clothing"] as const,
          advisory_traits: [] as const,
          basis: "relative-only" as const
        }
      ],
      media: {}
    };
    const built = buildFixtureReport({
      input,
      reportRelativePath: "qa/person-consistency/gate2/report.json",
      seeds: [
        {
          subject_id: "hero",
          observations: [
            {
              timestamp_ms: 0,
              shot_id: "s1",
              visibility: "occluded",
              face_evaluable: false,
              reason: "face occluded by prop"
            },
            {
              timestamp_ms: 500,
              shot_id: "s1",
              visibility: "offscreen",
              face_evaluable: false,
              reason: "subject offscreen"
            }
          ]
        }
      ]
    });
    expect(built.ok).toBe(true);
    const identity = built.report!.subjects[0].traits.find((t) => t.trait === "identity");
    expect(identity?.status).toBe("not-evaluable");
    expect(built.report!.status).toBe("not_evaluable");
    expect(JSON.stringify(built.report)).not.toMatch(/embedding/i);
  });

  it("does not auto-decide on ambiguous multi-person track assignment", () => {
    const input = {
      stage: "gate_2" as const,
      input_digest: HEX,
      sampling_plan: [{ shot_id: "s1", timestamp_ms: 0, role: "boundary_start" as const }],
      subjects: [
        {
          subject_id: "hero",
          required_traits: ["identity"] as ("identity")[],
          advisory_traits: [] as ("identity")[],
          basis: "relative-only" as const
        }
      ],
      media: {}
    };
    const built = buildFixtureReport({
      input,
      reportRelativePath: "qa/person-consistency/gate2/report.json",
      seeds: [
        {
          subject_id: "hero",
          ambiguity_codes: ["ambiguous_assignment", "track_crossing"],
          observations: [
            {
              timestamp_ms: 0,
              shot_id: "s1",
              visibility: "visible",
              face_evaluable: true,
              reason: "two tracks crossed",
              track_id: "t1"
            },
            {
              timestamp_ms: 100,
              shot_id: "s1",
              visibility: "visible",
              face_evaluable: true,
              reason: "second track",
              track_id: "t2"
            }
          ]
        }
      ]
    });
    expect(built.ok).toBe(true);
    expect(built.report!.status).toBe("review");
    expect(built.report!.ambiguities.join(" ")).toMatch(/ambiguous_assignment/);
  });

  it("never leaves required possible-drift as overall status ok (no false pass)", () => {
    const input = {
      stage: "gate_2" as const,
      input_digest: HEX,
      sampling_plan: [{ shot_id: "s1", timestamp_ms: 0, role: "boundary_start" as const }],
      subjects: [
        {
          subject_id: "hero",
          required_traits: ["identity"] as ("identity")[],
          advisory_traits: [] as ("identity")[],
          basis: "relative-only" as const
        }
      ],
      media: {}
    };
    const built = buildFixtureReport({
      input,
      reportRelativePath: "qa/person-consistency/gate2/report.json",
      seeds: [
        {
          subject_id: "hero",
          trait_statuses: { identity: "possible-drift" },
          observations: [
            {
              timestamp_ms: 0,
              shot_id: "s1",
              visibility: "visible",
              face_evaluable: true,
              reason: "identity drifted"
            }
          ]
        }
      ]
    });
    expect(built.ok).toBe(true);
    expect(built.report!.status).toBe("review");
    expect(built.report!.subjects[0].traits[0].status).toBe("possible-drift");

    // Schema rejects forged ok + possible-drift payloads.
    const forged = parsePersonConsistencyReport({
      ...baseReport(),
      status: "ok",
      subjects: [
        {
          ...baseReport().subjects[0],
          traits: [{ trait: "identity", status: "possible-drift", level: "required" }]
        }
      ]
    });
    expect(forged.ok).toBe(false);
  });

  it("rejects capability missing, unknown fields, and embedding vectors", () => {
    const capability = fixtureCapability();
    capability.traits = ["clothing"];
    expect(checkRequiredTraitsSupported(capability, ["identity"])[0]?.code).toBe(
      "person_qa.capability_missing"
    );

    const withEmbedding = parsePersonConsistencyReport({
      ...baseReport(),
      subjects: [
        {
          ...baseReport().subjects[0],
          embedding: [0.1, 0.2, 0.3]
        }
      ]
    });
    expect(withEmbedding.ok).toBe(false);

    const unknownField = parseSemanticQaAdapterInput({
      stage: "gate_2",
      input_digest: HEX,
      sampling_plan: [],
      subjects: [],
      media: {},
      mystery: true
    });
    expect(unknownField.ok).toBe(false);

    const badCap = parseSemanticQaCapability({
      ...fixtureCapability(),
      retains_biometric_embeddings: true
    });
    expect(badCap.ok).toBe(false);
  });
});

describe("report integrity: missing/stale/tampered/path escape/symlink", () => {
  it("fails closed on missing, digest mismatch, tamper, path escape, symlink, contact sheet missing", async () => {
    const root = await mkdir(join(tmpdir(), `pc-qa-${Date.now()}`), { recursive: true }).then(() =>
      join(tmpdir(), `pc-qa-${Date.now()}`)
    );
    const runDir = join(root, "run");
    await mkdir(join(runDir, "qa", "person-consistency", "gate2"), { recursive: true });

    const missing = await loadPersonConsistencyReport({
      runDir,
      relativePath: "qa/person-consistency/gate2/report.json"
    });
    expect(missing.ok).toBe(false);
    expect(missing.issues[0]?.code).toBe("person_qa.report_missing");

    const report = baseReport({ input_digest: HEX });
    const reportPath = join(runDir, "qa", "person-consistency", "gate2", "report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    const mismatch = await loadPersonConsistencyReport({
      runDir,
      relativePath: "qa/person-consistency/gate2/report.json",
      expectedInputDigest: "b".repeat(64)
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.issues[0]?.code).toBe("person_qa.input_digest_mismatch");

    const tampered = {
      ...report,
      report_digest: "c".repeat(64)
    };
    await writeFile(reportPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const tamper = await loadPersonConsistencyReport({
      runDir,
      relativePath: "qa/person-consistency/gate2/report.json"
    });
    expect(tamper.ok).toBe(false);
    expect(tamper.issues[0]?.code).toBe("person_qa.report_tampered");

    const escape = await resolveSafeRunArtifactPath(runDir, "../secret/report.json");
    expect(escape.ok).toBe(false);
    expect(escape.issues[0]?.code).toBe("person_qa.path_escape");

    const abs = await resolveSafeRunArtifactPath(runDir, "/tmp/evil.json");
    expect(abs.ok).toBe(false);

    // Symlink contact sheet
    const sheetPath = join(runDir, "qa", "person-consistency", "gate2", "contact-sheet.webp");
    const external = join(root, "external.webp");
    await writeFile(external, "webp-bytes");
    await symlink(external, sheetPath);
    const symlinkResult = await validateContactSheetArtifact({
      runDir,
      relativePath: "qa/person-consistency/gate2/contact-sheet.webp"
    });
    expect(symlinkResult.ok).toBe(false);
    expect(symlinkResult.issues[0]?.code).toBe("person_qa.symlink_forbidden");

    const missingSheet = await validateContactSheetArtifact({
      runDir,
      relativePath: "qa/person-consistency/gate2/missing-sheet.webp"
    });
    expect(missingSheet.ok).toBe(false);
    expect(missingSheet.issues[0]?.code).toBe("person_qa.contact_sheet_missing");
  });
});

describe("external safety", () => {
  it("blocks external by default, missing approval/cost, network scope mismatch, and local fallback", () => {
    expect(isExternalAdapterConnected()).toBe(false);
    const preview = buildExternalPayloadPreview({
      provider: "example-vendor",
      region: "us",
      retention: "none",
      frames: [{ sha256: HEX, bytes: 1024 }],
      network_scope: "sampled-frames"
    });

    const disabled = assertExternalExecutionAllowed({
      policy: POLICY,
      preview,
      adapterNetworkScope: "sampled-frames"
    });
    expect(disabled.ok).toBe(false);
    expect(disabled.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        "person_qa.external_disabled",
        "person_qa.external_approval_missing",
        "person_qa.external_cost_missing"
      ])
    );

    const allowedPolicy: PersonConsistencyPolicyV1 = {
      ...POLICY,
      external: { allowed: true }
    };
    const scope = assertExternalExecutionAllowed({
      policy: allowedPolicy,
      preview: { ...preview, estimated_cost: { currency: "USD", amount: 1 } },
      adapterNetworkScope: "none",
      approval: {
        approval_digest: HEX,
        approved_at: "2026-01-01T00:00:00.000Z",
        actor: "coordinator",
        preview_digest: "d".repeat(64),
        provider: "example-vendor"
      }
    });
    expect(scope.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        "person_qa.external_network_scope_mismatch",
        "person_qa.external_approval_mismatch"
      ])
    );

    const fallback = assertExternalExecutionAllowed({
      policy: allowedPolicy,
      preview: {
        ...preview,
        estimated_cost: { currency: "USD", amount: 1 },
        network_scope: "none"
      },
      adapterNetworkScope: "none",
      localFailed: true
    });
    expect(fallback.issues.some((i) => i.code === "person_qa.external_fallback_forbidden")).toBe(
      true
    );
  });
});

describe("Gate digests, human decision, finalize revalidation, QA-disabled regression", () => {
  it("requires human decision reason and forbids auto-accept of blocked/review/not_evaluable", () => {
    const missing = parsePersonQaHumanDecision({ decision: "accept", reason: "  " });
    expect(missing.ok).toBe(false);

    const okDecision = parsePersonQaHumanDecision({
      decision: "accept",
      reason: "matches reference identity and wardrobe"
    });
    expect(okDecision.ok).toBe(true);

    const blocked = baseReport({ status: "blocked", blocked_reasons: ["reference_ambiguous"] });
    expect(
      validatePersonQaDecisionAgainstReport(okDecision.decision!, blocked)[0]?.code
    ).toBe("person_qa.auto_accept_forbidden");

    const notEval = baseReport({ status: "not_evaluable" });
    expect(
      validatePersonQaDecisionAgainstReport(
        { decision: "accept", reason: "looks fine" },
        notEval
      )[0]?.code
    ).toBe("person_qa.auto_accept_forbidden");

    expect(
      validatePersonQaDecisionAgainstReport(
        { decision: "accept-not-evaluable", reason: "face never visible; accept coverage gap" },
        notEval
      )
    ).toEqual([]);
  });

  it("includes technical QC digest, semantic report digest, decision, and reason in gate approval", () => {
    const technical = { ok: true, issues: [] };
    const human = {
      decision: "accept" as const,
      reason: "identity stable across sampled frames"
    };
    const { approvalDigest, personQaPayload } = buildGateApprovalWithPersonQa({
      baseApprovalPayload: { backend: "remotion", gate2_qc: technical },
      technicalQc: technical,
      reportSha256: HEX,
      reportStatus: "ok",
      stage: "gate_2",
      humanDecision: human
    });
    expect(approvalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(personQaPayload.technical_qc_digest).toBe(digestTechnicalQc(technical));
    expect(personQaPayload.semantic_report_digest).toBe(HEX);
    expect(personQaPayload.human_decision).toBe("accept");
    expect(personQaPayload.reason).toBe(human.reason);

    // Different reason => different digest
    const other = buildGateApprovalWithPersonQa({
      baseApprovalPayload: { backend: "remotion", gate2_qc: technical },
      technicalQc: technical,
      reportSha256: HEX,
      reportStatus: "ok",
      stage: "gate_2",
      humanDecision: { decision: "accept", reason: "different reason" }
    });
    expect(other.approvalDigest).not.toBe(approvalDigest);
  });

  it("restores Gate 2 person-QA decision from binding so approve/render digests match", async () => {
    const technical = { ok: true, issues: [], issues_count: 0 };
    const basePayload = { backend: "remotion", gate2_qc: technical };
    const human = {
      decision: "accept" as const,
      reason: "identity stable across sampled frames"
    };
    const approveDigest = buildGateApprovalWithPersonQa({
      baseApprovalPayload: basePayload,
      technicalQc: technical,
      reportSha256: HEX,
      reportStatus: "ok",
      stage: "gate_2",
      humanDecision: human
    }).approvalDigest;

    // Without the decision (legacy render path) digest diverges even if report is unchanged.
    const previewOnly = createHash("sha256")
      .update(JSON.stringify({
        ...basePayload,
        person_consistency_report_sha256: HEX
      }))
      .digest("hex");
    // Preview-style binding is intentionally a different payload shape.
    expect(previewOnly).not.toBe(approveDigest);

    const root = join(tmpdir(), `pc-gate2-bind-${Date.now()}`);
    const runDir = join(root, "run");
    await mkdir(join(runDir, "qa", "person-consistency", "gate2"), { recursive: true });
    const binding = buildPersonQaApprovalBinding({
      stage: "gate_2",
      reportRelativePath: "qa/person-consistency/gate2/report.json",
      reportSha256: HEX,
      reportStatus: "ok",
      humanDecision: human,
      technicalQc: technical,
      baseApprovalPayload: basePayload
    });
    expect(binding.person_qa_approval_digest).toBe(approveDigest);
    const written = await writePersonQaApprovalBinding({ runDir, binding });
    expect(written.ok).toBe(true);
    const loaded = await loadPersonQaApprovalBinding({ runDir, stage: "gate_2" });
    expect(loaded.ok).toBe(true);
    const restored = buildGateApprovalWithPersonQa({
      baseApprovalPayload: basePayload,
      technicalQc: technical,
      reportSha256: HEX,
      reportStatus: "ok",
      stage: "gate_2",
      humanDecision: loaded.binding!.human_decision
    });
    expect(restored.approvalDigest).toBe(approveDigest);
  });

  it("does not allow outer Gate approved with person-qa-decision revise", () => {
    expect(
      issuesForOuterGateWithPersonQaDecision("approved", {
        decision: "revise",
        reason: "identity drifted; regenerate"
      })[0]?.code
    ).toBe("person_qa.revise_blocks_outer_approval");

    expect(
      issuesForOuterGateWithPersonQaDecision("revise", {
        decision: "revise",
        reason: "identity drifted; regenerate"
      })
    ).toEqual([]);

    expect(
      issuesForOuterGateWithPersonQaDecision("approved", {
        decision: "accept",
        reason: "stable identity"
      })
    ).toEqual([]);
  });

  it("revalidates report digest for finalize and preserves QA-disabled behavior", async () => {
    const root = join(tmpdir(), `pc-finalize-${Date.now()}`);
    const runDir = join(root, "run");
    await mkdir(join(runDir, "qa", "person-consistency", "gate3"), { recursive: true });
    const report = baseReport({ stage: "gate_3" });
    const relativePath = "qa/person-consistency/gate3/report.json";
    const absolute = join(runDir, relativePath);
    await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`);
    const reportSha256 = createHash("sha256")
      .update(await (await import("node:fs/promises")).readFile(absolute))
      .digest("hex");

    const project = {
      quality: { person_consistency: POLICY }
    };
    expect(personConsistencyRequiredForStage(project, "gate_3")).toBe(true);

    const revalidated = await revalidatePersonConsistencyForFinalize({
      project,
      stage: "gate_3",
      runDir,
      reportRelativePath: relativePath,
      expectedReportSha256: reportSha256
    });
    expect(revalidated.ok).toBe(true);

    const stale = await revalidatePersonConsistencyForFinalize({
      project,
      stage: "gate_3",
      runDir,
      reportRelativePath: relativePath,
      expectedReportSha256: "e".repeat(64)
    });
    expect(stale.ok).toBe(false);

    // QA disabled: revalidation is a no-op success
    const disabled = await revalidatePersonConsistencyForFinalize({
      project: {},
      stage: "gate_3",
      runDir,
      reportRelativePath: relativePath,
      expectedReportSha256: "f".repeat(64)
    });
    expect(disabled.ok).toBe(true);

    // Finalize path: requires approval binding when QA enabled.
    const missingBinding = await revalidatePersonConsistencyOnFinalize({
      project,
      runDir,
      finalOutputSha256: HEX
    });
    expect(missingBinding.ok).toBe(false);
    expect(missingBinding.issues.some((i) => i.code === "person_qa.binding_missing")).toBe(true);

    const contactRelative = "qa/person-consistency/gate3/contact-sheet.webp";
    const contactAbsolute = join(runDir, contactRelative);
    await writeFile(contactAbsolute, "contact-sheet-v1");
    const contactSha256 = createHash("sha256")
      .update(await (await import("node:fs/promises")).readFile(contactAbsolute))
      .digest("hex");

    const binding = buildPersonQaApprovalBinding({
      stage: "gate_3",
      finalOutputSha256: HEX,
      reportRelativePath: relativePath,
      reportSha256: reportSha256,
      reportStatus: "ok",
      contactSheetRelativePath: contactRelative,
      contactSheetSha256: contactSha256,
      humanDecision: {
        decision: "accept",
        reason: "identity stable on contact sheet"
      },
      technicalQc: { final_output_sha256: HEX },
      baseApprovalPayload: { final_output_sha256: HEX }
    });
    const written = await writePersonQaApprovalBinding({ runDir, binding });
    expect(written.ok).toBe(true);

    const onFinalize = await revalidatePersonConsistencyOnFinalize({
      project,
      runDir,
      finalOutputSha256: HEX
    });
    expect(onFinalize.ok).toBe(true);
    expect(onFinalize.report_sha256).toBe(reportSha256);

    // Contact sheet swap after approval must fail finalize even if report is unchanged.
    await writeFile(contactAbsolute, "contact-sheet-tampered");
    const swapped = await revalidatePersonConsistencyOnFinalize({
      project,
      runDir,
      finalOutputSha256: HEX
    });
    expect(swapped.ok).toBe(false);
    expect(swapped.issues.some((i) => i.code === "person_qa.contact_sheet_stale")).toBe(true);

    // Direct finalize helper also rejects mismatched expected contact-sheet hash.
    await writeFile(contactAbsolute, "contact-sheet-v1");
    const directMismatch = await revalidatePersonConsistencyForFinalize({
      project,
      stage: "gate_3",
      runDir,
      reportRelativePath: relativePath,
      expectedReportSha256: reportSha256,
      contactSheetRelativePath: contactRelative,
      expectedContactSheetSha256: "b".repeat(64)
    });
    expect(directMismatch.ok).toBe(false);
    expect(directMismatch.issues.some((i) => i.code === "person_qa.contact_sheet_stale")).toBe(true);

    // QA disabled: finalize revalidation is no-op success
    const disabledOnFinalize = await revalidatePersonConsistencyOnFinalize({
      project: {},
      runDir,
      finalOutputSha256: "f".repeat(64)
    });
    expect(disabledOnFinalize.ok).toBe(true);
  });

  it("forbids accept-not-evaluable on review when required traits are evaluable", () => {
    const reviewWithDrift = baseReport({
      status: "review",
      subjects: [
        {
          ...baseReport().subjects[0],
          traits: [{ trait: "identity", status: "possible-drift", level: "required" }]
        }
      ]
    });
    expect(
      validatePersonQaDecisionAgainstReport(
        { decision: "accept-not-evaluable", reason: "skip drift" },
        reviewWithDrift
      )[0]?.code
    ).toBe("person_qa.accept_not_evaluable_invalid");
  });
});

describe("viewer person-consistency data model / a11y contract", () => {
  it("exposes status, basis, traits, coverage, ambiguity, contact sheet, keyboard targets", () => {
    const report = baseReport({
      status: "review",
      ambiguities: ["subject:hero:track_crossing"],
      artifacts: {
        report_relative_path: "qa/person-consistency/gate2/report.json",
        contact_sheet_relative_path: "qa/person-consistency/gate2/contact-sheet.webp"
      }
    });
    const evidence = toViewerPersonConsistencyEvidence(report, {
      reportHref: "qa/person-consistency/gate2/report.json",
      contactSheetHref: "qa/person-consistency/gate2/contact-sheet.webp"
    });
    expect(evidence.status).toBe("review");
    expect(evidence.basis_summary).toContain("reference");
    expect(evidence.subjects[0].traits[0].trait).toBe("identity");
    expect(evidence.contact_sheet_alt).toMatch(/hero/);
    expect(evidence.contact_sheet_alt).toMatch(/評価|レビュー|状態/);
    expect(evidence.keyboard_targets.some((t) => t.id === "person-qa-contact-sheet")).toBe(true);
    expect(evidence.keyboard_targets.some((t) => t.id === "person-qa-subject-hero")).toBe(true);
    // Color is not the only channel: status_label is textual
    expect(evidence.status_label.length).toBeGreaterThan(2);
    expect(evidence.a11y.summary_text).toMatch(/人物|対象|曖昧/);

    const project: Project = {
      slug: "viewer-pc",
      name: "viewer-pc",
      run_id: "viewer-pc-run",
      manifest: "manifest.yaml",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: { adapter: "mock-agent", requests: [] }
    };
    const plan: ExecutionPlan = {
      run_id: "viewer-pc-run",
      slug: "viewer-pc",
      name: "viewer-pc",
      backend: "remotion",
      target_duration_seconds: 10,
      total_clip_duration_seconds: 10,
      estimated_credits: 0,
      clips: [],
      agent_handoffs: [],
      steps: [
        { name: "validate", status: "pending" },
        { name: "creative-review", status: "pending" },
        { name: "gate-1", status: "gate" },
        { name: "assemble-manifest", status: "pending" },
        { name: "gate-2", status: "gate" },
        { name: "render", status: "pending" },
        { name: "gate-3", status: "gate" }
      ]
    };
    const workflow = createViewerWorkflow(project, plan, undefined, {
      personConsistencyGate2: evidence
    });
    const gate2 = workflow.nodes.find((n) => n.id === "gate-2" || n.technicalName === "gate-2" || n.name.includes("Gate 2"));
    // Details should surface person facts when provided via artifacts
    const details = gate2?.details;
    if (details) {
      const allFacts = [
        ...(details.inputs ?? []).flatMap((i) => i.facts ?? []),
        ...(details.outputs ?? []).flatMap((o) => o.facts ?? [])
      ].join("\n");
      expect(allFacts).toMatch(/人物一貫性|reference|hero/);
    }
  });
});

describe("adapter resolution and manual import", () => {
  it("resolves fixture/manual only; unknown external stays unconnected", async () => {
    const unknown = resolveSemanticQaAdapter("face-api-cloud");
    expect(unknown.ok).toBe(false);
    expect(unknown.issues[0]?.code).toBe("person_qa.adapter_unknown");

    const compiled = compilePersonConsistencyRequirements({
      policy: POLICY,
      stage: "gate_2",
      subjects: [
        {
          id: "hero",
          consistency: { enabled: true },
          preservation: { identity: "strict" }
        }
      ],
      shots: [{ id: "s1", start_ms: 0, end_ms: 500 }]
    });
    const fixture = resolveSemanticQaAdapter("fixture", {
      seeds: [
        {
          subject_id: "hero",
          observations: [
            {
              timestamp_ms: 0,
              shot_id: "s1",
              visibility: "visible",
              face_evaluable: true,
              reason: "fixture face"
            }
          ]
        }
      ],
      reportRelativePath: "qa/person-consistency/gate2/report.json"
    });
    expect(fixture.ok).toBe(true);
    const payload = await fixture.adapter!.analyze({
      stage: "gate_2",
      input_digest: compiled.compiled!.input_digest,
      sampling_plan: compiled.compiled!.sampling_plan,
      subjects: [
        {
          subject_id: "hero",
          required_traits: ["identity"],
          advisory_traits: [],
          basis: "relative-only"
        }
      ],
      media: {}
    });
    expect(payload.ok).toBe(true);
    expect(JSON.stringify(payload.payload)).not.toMatch(/api[_-]?key|token|cookie/i);
  });
});
