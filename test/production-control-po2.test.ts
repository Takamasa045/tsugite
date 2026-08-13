import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { manifestSchema } from "../src/manifest/schema.js";
import {
  buildContractFragmentIndex,
  ContractRegistry,
  buildDependencyIndex,
  buildProgramBinding,
  buildProductionControlShadowSummary,
  compileProductionContract,
  compileTaskTree,
  computeInvalidation,
  contractFragmentIndexSchema,
  contractSetSchema,
  contractSetDigest,
  createContractSet,
  createBranchSelection,
  createDefaultTaskTreeTemplate,
  createRoleEnvelope,
  createSeriesProductionGraph,
  assertBranchSelectionRequired,
  directConsumersForArtifact,
  directConsumersForFragment,
  downstreamClosure,
  digestRefKey,
  dependencyIndexDigest,
  dependencyIndexSchema,
  generationUnitProgramSourceSchema,
  programBindingSchema,
  programBindingDigest,
  programBindingRoute,
  productionContractSchema,
  productionContractDigest,
  roleEnvelopeDigest,
  roleEnvelopeSchema,
  seriesGraphDigest,
  seriesProductionGraphSchema,
  taskEndpoints,
  taskNodeSchema,
  taskById,
  taskTreeTemplateSchema,
  validateTaskTreeSpec,
  type ContractFragmentRef,
  type DigestRef,
  type TaskTreeTemplate
} from "../src/productionControl/index.js";
import { assertNoCircularProgramBinding, assertProgramBindingMatchesSource } from "../src/productionControl/programBinding.js";
import { createPlan } from "../src/orchestrator/plan.js";
import { createReviewDocument, legacyProjectProjection, legacyReviewDocumentProjection, renderReviewHtml } from "../src/orchestrator/review.js";
import { loadProject } from "../src/project/loadProject.js";
import { sha256Bytes, sha256Canonical, withoutField } from "../src/productionControl/canonical.js";
import {
  identityDefinitionSchema,
  identityDefinitionSubjectDigest,
  identityVerificationSchema,
  identityVerificationSubjectDigest,
  migrateIdentityLock,
  migrateIdentityLockPhaseAtoE
} from "../src/personConsistency/index.js";

const ZERO = "0".repeat(64);

function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "po2-fixture",
    name: "PO2 fixture",
    run_id: "po2-fixture",
    manifest: "manifest.json",
    dist_dir: "dist",
    edit: { backend: "remotion" },
    ...overrides
  };
}

function fragment(slot: ContractFragmentRef["slot"], id: string, kind: ContractFragmentRef["kind"] = "section"): ContractFragmentRef {
  return {
    slot,
    contract_id: `${slot}-contract`,
    revision: 0,
    kind,
    fragment_id: id,
    digest: ZERO
  };
}

function taskTemplate(overrides: Partial<Extract<TaskTreeTemplate["root"], { node_type: "task" }>> = {}) {
  return {
    node_type: "task" as const,
    node_id: "task-a",
    kind: "source-and-rights",
    role: "director",
    effect: "read" as const,
    dependencies: [],
    required_contract_fragments: [],
    required_artifacts: [],
    output_schema: "source-output",
    risk_class: "low" as const,
    invalidation_tags: [],
    ...overrides
  };
}

function missionTemplate(
  children: TaskTreeTemplate["root"] extends infer _T ? TaskTreeTemplate["root"][] : never,
  kind: "sequence" | "parallel" | "bounded_map" | "choose_one" = "parallel",
  map_keys?: string[],
  node_id = "root"
): TaskTreeTemplate["root"] {
  return {
    node_type: "mission",
    node_id,
    template_kind: kind,
    children: children as never,
    ...(map_keys ? { map_keys } : {})
  } as TaskTreeTemplate["root"];
}

describe("PO-2 contract and task-tree contracts", () => {
  it("compiles deterministic strict ProductionContract and ContractSet", () => {
    const first = compileProductionContract({ project: project(), brief: "private brief is digested, not persisted" });
    const second = compileProductionContract({ project: project(), brief: "private brief is digested, not persisted" });
    expect(first).toEqual(second);
    expect(productionContractDigest(first)).toBe(first.root_digest);
    expect(() => productionContractSchema.parse({ ...first, unexpected: true })).toThrow();
    const set = createContractSet({
      production_id: first.production_id,
      revision: 0,
      contracts: [{ slot: "music", contract_id: "music-0", contract_revision: 0, artifact_id: "music-artifact", digest: ZERO }]
    });
    expect(contractSetDigest(set)).toBe(set.digest);
    expect(() => createContractSet({
      production_id: first.production_id,
      revision: 0,
      contracts: [{ slot: "identity" as never, contract_id: "identity-0", contract_revision: 0, artifact_id: "identity-artifact", digest: ZERO }]
    })).toThrow();
    expect(() => createContractSet({
      production_id: first.production_id,
      revision: 0,
      contracts: [
        { slot: "music", contract_id: "music-0", contract_revision: 0, artifact_id: "a", digest: ZERO },
        { slot: "music", contract_id: "music-1", contract_revision: 1, artifact_id: "b", digest: ZERO }
      ]
    })).toThrow();
  });

  it("keeps slot derivation and shadow failure paths deterministic", () => {
    const richProject = project({
      audio: { source: "local" },
      quality: { person_consistency: { enabled: true } },
      generation: {
        connection: "connection-1",
        adapter: "adapter-1",
        requests: [
          null,
          {
            first_frame: "asset-1",
            audio_role: "music",
            h3: {
              subjects: [{ id: "hero" }],
              shots: [{ lyrics: "cue-1" }]
            }
          }
        ]
      }
    });
    const rich = compileProductionContract({
      project: richProject,
      objective: "objective",
      project_yaml_digest: ZERO,
      duration_ms: 1_000,
      aspect: "16x9",
      locale: "ja",
      must_include: ["hero"],
      prohibited: ["secret"],
      compiler_version: "compiler-v1"
    });
    expect(rich.contract_slots).toMatchObject({
      assets: { requirement: "required" },
      identity: { requirement: "required" },
      music: { requirement: "required" },
      lyrics: { requirement: "required" }
    });
    expect(rich.deliverables).toHaveLength(2);

    const empty = compileProductionContract({
      project: {
        ...project(),
        generation: { requests: [null, { h3: { subjects: [] }, video_prompt: [] }] }
      },
      projectYamlDigest: ZERO
    });
    expect(empty.contract_slots).toMatchObject({
      assets: { requirement: "optional" },
      identity: { requirement: "optional" },
      music: { requirement: "optional" },
      lyrics: { requirement: "optional" }
    });
    expect(buildProductionControlShadowSummary({ slug: "unsafe/path" }).status).toBe("blocked");
    expect(() => productionContractDigest({ ...rich, root_digest: ZERO })).toThrow();
  });

  it("binds privacy-safe project semantics into project, contract, and tree digests", () => {
    const baseProject = project({
      quality: { person_consistency: { enabled: true, minimum_distinct_outputs: 2 } },
      story: { premise: "A lantern waits by the pier" },
      generation: {
        requests: [{
          id: "shot-1",
          operation: "video",
          h3: {
            subjects: [{ id: "hero", locked_blocks: { appearance: { text: "blue coat", sha256: ZERO } } }],
            shots: [{ id: "shot-a", visual: "hero walks to the lamp", constraints: ["slow"] }]
          },
          prompt: "private raw prompt",
          path: "/Users/private/asset.mp4",
          params: { api_key: "do-not-store", provider_body: { prompt: "do-not-store" }, safe_parameter: 1 }
        }]
      }
    });
    const changedProject = {
      ...baseProject,
      generation: {
        requests: [{
          ...((baseProject.generation as Record<string, unknown>).requests as Array<Record<string, unknown>>)[0],
          h3: {
            subjects: [{ id: "hero-changed" }],
            shots: [{ id: "shot-a", visual: "hero waits at the pier", constraints: ["slow"] }]
          }
        }]
      }
    };
    const first = compileProductionContract({ project: baseProject });
    const second = compileProductionContract({ project: changedProject });
    expect(second.project.project_yaml_digest).not.toBe(first.project.project_yaml_digest);
    expect(second.root_digest).not.toBe(first.root_digest);
    expect(compileProductionContract({
      project: { ...baseProject, quality: { person_consistency: { enabled: true, minimum_distinct_outputs: 3 } } }
    }).root_digest).not.toBe(first.root_digest);
    expect(compileProductionContract({
      project: { ...baseProject, story: { premise: "A different premise" } }
    }).root_digest).not.toBe(first.root_digest);
    expect(compileProductionContract({
      project: { ...baseProject, edit: { backend: "fixture" } }
    }).root_digest).not.toBe(first.root_digest);
    // The exact TaskTree schema has no contract digest field; its digest changes
    // with structure, while the ProductionContract root binds project semantics.
    expect(buildProductionControlShadowSummary(baseProject).tree_digest)
      .toBe(buildProductionControlShadowSummary(changedProject).tree_digest);
    const serialized = JSON.stringify({ contract: first, summary: buildProductionControlShadowSummary(baseProject) });
    expect(serialized).not.toContain("private raw prompt");
    expect(serialized).not.toContain("do-not-store");
    expect(serialized).not.toContain("/Users/");
    expect(() => compileProductionContract({ project: baseProject, project_yaml_digest: "not-a-digest" })).toThrow();
    expect(compileProductionContract({ project: baseProject, project_yaml_digest: ZERO }).project.project_yaml_digest).toBe(ZERO);
  });

  it("does not infer not_applicable for absent legacy identity or music", () => {
    const unknown = compileProductionContract({ project: project() });
    expect(unknown.contract_slots.identity).toMatchObject({ requirement: "optional" });
    expect(unknown.contract_slots.music).toMatchObject({ requirement: "optional" });
    const declared = compileProductionContract({
      project: project({ contract_slots: { identity: "not_applicable", music: "not_applicable" } })
    });
    expect(declared.contract_slots.identity).toMatchObject({ requirement: "not_applicable" });
    expect(declared.contract_slots.music).toMatchObject({ requirement: "not_applicable" });
    expect(declared.contract_slots.identity.reason).toContain("explicitly declares");
  });

  it("registers revisions, resolves explicit fragments, and builds scoped ContractSets", () => {
    const registry = new ContractRegistry();
    const whole = registry.register({
      slot: "music",
      contract_id: "music-0",
      revision: 0,
      artifact_id: "music-artifact",
      payload: { title: "music" }
    });
    registry.register({
      slot: "music",
      contract_id: "music-1",
      revision: 1,
      artifact_id: "music-artifact-v1",
      payload: { title: "music-v1" }
    });
    const identityDigest = sha256Canonical({
      slot: "identity-definition",
      contract_id: "identity-0",
      revision: 1,
      artifact_id: "identity-artifact",
      payload: { subject: "hero" }
    });
    const identity = registry.register({
      slot: "identity-definition",
      contract_id: "identity-0",
      revision: 1,
      artifact_id: "identity-artifact",
      payload: { subject: "hero" },
      digest: identityDigest,
      fragments: [{ kind: "subject", fragment_id: "hero", value: { id: "hero" } }]
    });
    expect(registry.get("music-0", 0)).toBe(whole);
    expect(registry.require("identity-0", 1)).toBe(identity);
    expect(registry.list().map((entry) => entry.contract_id)).toEqual(["identity-0", "music-0", "music-1"]);
    expect(registry.resolve(whole.fragment_index.fragments[0]!)).toBe(true);
    expect(registry.resolve({ ...identity.fragment_index.fragments[0]!, digest: ZERO })).toBe(false);
    expect(registry.resolve({ ...whole.fragment_index.fragments[0]!, contract_id: "missing" })).toBe(false);
    expect(() => registry.buildSet("production-1")).toThrow();
    const latestSet = registry.buildSet("production-1", 0, {
      slots: ["identity-definition", "music"],
      active_revisions: { "identity-definition": 1, music: 1 }
    });
    expect(latestSet.contracts.map((entry) => entry.slot)).toEqual(["identity-definition", "music"]);
    expect(latestSet.contracts.find((entry) => entry.slot === "music")?.contract_revision).toBe(1);
    expect(registry.buildSet("production-1", 2, { slots: ["music"], active_revisions: { music: 0 } }).contracts[0]?.contract_revision).toBe(0);
    expect(() => registry.buildSet("production-1", 2, { slots: ["music"], active_revisions: { music: 99 } })).toThrow();
    expect(() => registry.register({ ...whole, revision: 0 })).toThrow();
    expect(() => registry.require("missing", 0)).toThrow();
    const embeddedRegistry = new ContractRegistry();
    const embedded = embeddedRegistry.register({
      slot: "music",
      contract_id: "embedded-music",
      revision: 0,
      artifact_id: "embedded-artifact",
      payload: { root_digest: ZERO, title: "original" }
    });
    expect(embedded.digest).not.toBe(ZERO);
    expect(() => embeddedRegistry.register({
      slot: "music",
      contract_id: "embedded-music",
      revision: 1,
      artifact_id: "embedded-artifact",
      payload: { root_digest: ZERO, title: "changed" },
      digest: embedded.digest
    })).toThrow();
    expect(() => buildContractFragmentIndex({
      slot: "music",
      contract_id: "music-invalid",
      revision: -1,
      artifact_id: "artifact",
      payload: {}
    })).toThrow();
    expect(() => buildContractFragmentIndex({
      slot: "music",
      contract_id: "music-invalid",
      revision: 0,
      artifact_id: "artifact",
      payload: {},
      digest: ZERO
    })).toThrow();
  });

  it("uses whole-contract fallback and never infers fragments from string paths", () => {
    const whole = buildContractFragmentIndex({
      slot: "identity-definition",
      contract_id: "identity-0",
      revision: 0,
      artifact_id: "identity-artifact",
      payload: { subjects: [{ id: "hero" }] }
    });
    expect(whole.fragments).toHaveLength(1);
    expect(whole.fragments[0]?.kind).toBe("whole");
    expect(() => buildContractFragmentIndex({
      slot: "identity-definition",
      contract_id: "identity-0",
      revision: 0,
      artifact_id: "identity-artifact",
      payload: { subjects: [] },
      fragments: [
        { kind: "subject", fragment_id: "hero", value: { path: "subjects[0]" } },
        { kind: "subject", fragment_id: "hero", value: { id: "hero" } }
      ]
    })).toThrow();
    const proven = buildContractFragmentIndex({
      slot: "lyrics",
      contract_id: "lyrics-0",
      revision: 0,
      artifact_id: "lyrics-artifact",
      payload: { cues: [{ id: "cue-1" }] },
      fragments: [{ kind: "lyric-cue", fragment_id: "cue-1", value: { id: "cue-1" } }]
    });
    expect(proven.fragments[0]?.digest).toBe(sha256Canonical({ id: "cue-1" }));
  });

  it("enforces fragment index, ContractSet, and series graph invariants at schema parse", () => {
    const mismatchedFragments = {
      schema_version: 1 as const,
      slot: "lyrics" as const,
      contract_id: "lyrics-0",
      revision: 0,
      fragments: [{ ...fragment("music", "cue-a", "lyric-cue"), contract_id: "other", revision: 1 }],
    };
    expect(() => contractFragmentIndexSchema.parse({ ...mismatchedFragments, digest: sha256Canonical(mismatchedFragments) })).toThrow();
    const duplicateFragments = {
      schema_version: 1 as const,
      slot: "lyrics" as const,
      contract_id: "lyrics-0",
      revision: 0,
      fragments: [
        fragment("lyrics", "cue-a", "lyric-cue"),
        fragment("lyrics", "cue-a", "lyric-cue")
      ]
    };
    expect(() => contractFragmentIndexSchema.parse({ ...duplicateFragments, digest: sha256Canonical(duplicateFragments) })).toThrow();
    const duplicateSet = {
      schema_version: 1 as const,
      production_id: "production-1",
      revision: 0,
      contracts: [
        { slot: "music" as const, contract_id: "music-0", contract_revision: 0, artifact_id: "music-a", digest: ZERO },
        { slot: "music" as const, contract_id: "music-1", contract_revision: 1, artifact_id: "music-b", digest: "1".repeat(64) }
      ]
    };
    expect(() => contractSetSchema.parse({ ...duplicateSet, digest: sha256Canonical(duplicateSet) })).toThrow();
    const seriesBase = {
      schema_version: 1 as const,
      series_id: "series-1",
      child_productions: [
        { production_id: "p1", production_contract_digest: ZERO, gate_scope_id: "g1", budget_scope_id: "b1" },
        { production_id: "p2", production_contract_digest: "1".repeat(64), gate_scope_id: "g2", budget_scope_id: "b2" }
      ],
      dependencies: [{ before: "p1", after: "p2" }, { before: "p2", after: "p1" }]
    };
    expect(() => seriesProductionGraphSchema.parse({ ...seriesBase, digest: sha256Canonical(seriesBase) })).toThrow();
    expect(() => seriesProductionGraphSchema.parse({
      ...seriesBase,
      series_id: "unsafe/path",
      dependencies: [],
      digest: sha256Canonical({ ...seriesBase, series_id: "unsafe/path", dependencies: [] })
    })).toThrow();
  });

  it("rejects unknown role/kind, cycle, depth 7, 257 nodes, and unbounded map", () => {
    const contract = compileProductionContract({ project: project() });
    const unknownRole = taskTemplate({ role: "untrusted-role" });
    expect(() => compileTaskTree({ production: contract, template: { schema_version: 1, template_id: "unknown-role", root: missionTemplate([unknownRole]) } })).toThrow();
    const unknownKind = taskTemplate({ kind: "unknown-kind" });
    expect(() => compileTaskTree({ production: contract, template: { schema_version: 1, template_id: "unknown-kind", root: missionTemplate([unknownKind]) } })).toThrow();
    const cycle = missionTemplate([
      taskTemplate({ node_id: "task-a", dependencies: ["task-b"] }),
      taskTemplate({ node_id: "task-b", dependencies: ["task-a"] })
    ]);
    expect(() => compileTaskTree({ production: contract, template: { schema_version: 1, template_id: "cycle", root: cycle } })).toThrow();

    let nested: TaskTreeTemplate["root"] = taskTemplate({ node_id: "deep-task" });
    for (let index = 6; index >= 0; index -= 1) {
      nested = {
        node_type: "mission",
        node_id: `deep-${index}`,
        template_kind: "sequence",
        children: [nested]
      };
    }
    expect(() => compileTaskTree({ production: contract, template: { schema_version: 1, template_id: "depth", root: nested } })).toThrow();

    const manyChildren = Array.from({ length: 256 }, (_, index) => taskTemplate({ node_id: `task-${index}` }));
    expect(() => compileTaskTree({ production: contract, template: { schema_version: 1, template_id: "many", root: missionTemplate(manyChildren) } })).toThrow();
    const unbounded = missionTemplate([taskTemplate({ node_id: "map-item" })], "bounded_map");
    expect(() => compileTaskTree({ production: contract, template: { schema_version: 1, template_id: "unbounded", root: unbounded } })).toThrow();
  });

  it("enforces the role-effect matrix and derived authority flags at every boundary", () => {
    const contract = compileProductionContract({ project: project() });
    const storyEnvelope = createRoleEnvelope({
      envelope_id: "authority-envelope",
      production_id: contract.production_id,
      node_id: "story-node",
      attempt_id: "attempt-1",
      role: "story",
      effect: "propose",
      input_schema: "story-input",
      output_schema: "story-output",
      input: { value: "in" },
      output: { value: "out" }
    });
    const forbiddenRole = {
      ...storyEnvelope,
      effect: "paid" as const,
      authority: { ...storyEnvelope.authority, external_submit: true, paid_execution: true }
    };
    expect(() => roleEnvelopeSchema.parse({
      ...forbiddenRole,
      envelope_digest: sha256Canonical(withoutField(forbiddenRole, "envelope_digest"))
    })).toThrow();
    const inconsistentAuthority = {
      ...storyEnvelope,
      authority: { ...storyEnvelope.authority, external_submit: true }
    };
    expect(() => roleEnvelopeSchema.parse({
      ...inconsistentAuthority,
      envelope_digest: sha256Canonical(withoutField(inconsistentAuthority, "envelope_digest"))
    })).toThrow();
    const invalidTask = taskTemplate({ role: "director", effect: "paid" });
    expect(() => taskNodeSchema.parse({ ...invalidTask, parent_id: "root" })).toThrow();
    expect(() => compileTaskTree({
      production: contract,
      template: {
        schema_version: 1,
        template_id: "invalid-authority",
        root: missionTemplate([invalidTask])
      }
    })).toThrow();
  });

  it("keeps choose_one human-gated and isolates series Gate/budget scopes", () => {
    const contract = compileProductionContract({ project: project() });
    const choose = missionTemplate([
      taskTemplate({ node_id: "candidate-a" }),
      taskTemplate({ node_id: "candidate-b" })
    ], "choose_one");
    const tree = compileTaskTree({ production: contract, template: { schema_version: 1, template_id: "choose", root: choose } });
    expect(tree.nodes.find((node) => node.node_id === "root")).toMatchObject({ aggregation: { kind: "choose_one", selection: "human-branch-selection" } });
    const series = createSeriesProductionGraph({
      series_id: "series-1",
      child_productions: [
        { production_id: "p1", production_contract_digest: ZERO, gate_scope_id: "gate-p1", budget_scope_id: "budget-p1" },
        { production_id: "p2", production_contract_digest: ZERO, gate_scope_id: "gate-p2", budget_scope_id: "budget-p2" }
      ]
    });
    expect(seriesGraphDigest(series)).toBe(series.digest);
    expect(() => createSeriesProductionGraph({
      series_id: "series-1",
      child_productions: [
        { production_id: "p1", production_contract_digest: ZERO, gate_scope_id: "same", budget_scope_id: "b1" },
        { production_id: "p2", production_contract_digest: ZERO, gate_scope_id: "same", budget_scope_id: "b2" }
      ]
    })).toThrow();
  });

  it("compiles sequence/parallel/bounded-map semantics and validates human selection", () => {
    const contract = compileProductionContract({ project: project() });
    const sequential = compileTaskTree({
      production: contract,
      template: {
        schema_version: 1,
        template_id: "sequence",
        root: missionTemplate([
          taskTemplate({ node_id: "first" }),
          taskTemplate({ node_id: "second" })
        ], "sequence")
      }
    });
    expect(sequential.nodes.find((node) => node.node_id === "root")).toMatchObject({ aggregation: { kind: "ordered" } });
    expect(sequential.nodes.find((node) => node.node_id === "second")).toMatchObject({ dependencies: ["first"] });
    const parallel = compileTaskTree({
      production: contract,
      template: {
        schema_version: 1,
        template_id: "parallel",
        root: missionTemplate([taskTemplate({ node_id: "parallel-a" })], "parallel")
      }
    });
    expect(parallel.nodes.find((node) => node.node_id === "root")).toMatchObject({ aggregation: { kind: "all" } });
    const bounded = compileTaskTree({
      production: contract,
      template: {
        schema_version: 1,
        template_id: "bounded",
        root: missionTemplate([taskTemplate({ node_id: "map-a" }), taskTemplate({ node_id: "map-b" })], "bounded_map", ["map-a", "map-b"])
      }
    });
    expect(bounded.nodes.find((node) => node.node_id === "root")).toMatchObject({ aggregation: { kind: "bounded_map" } });

    const choose = compileTaskTree({
      production: contract,
      template: {
        schema_version: 1,
        template_id: "choose-selection",
        root: missionTemplate([
          taskTemplate({ node_id: "candidate-a" }),
          taskTemplate({ node_id: "candidate-b" })
        ], "choose_one")
      }
    });
    expect(() => assertBranchSelectionRequired(choose)).toThrow();
    const candidateA = { kind: "video", id: "candidate-a", digest: ZERO } as DigestRef;
    const candidateB = { kind: "video", id: "candidate-b", digest: ZERO } as DigestRef;
    const selection = createBranchSelection({
      production_id: contract.production_id,
      mission_node_id: "root",
      candidate_artifact_refs: [candidateA, candidateB],
      selected_artifact_ref: candidateB,
      decision: {
        decision_id: "decision-1",
        decision: "select-candidate-b",
        actor: "human",
        decided_at: "2026-08-11T00:00:00.000Z"
      }
    });
    assertBranchSelectionRequired(choose, selection);
    expect(() => assertBranchSelectionRequired(choose, { ...selection, production_id: "other" })).toThrow();
    expect(() => assertBranchSelectionRequired(choose, { ...selection, mission_node_id: "not-choice" })).toThrow();
    expect(() => assertBranchSelectionRequired(choose, {
      ...selection,
      selected_artifact_ref: { kind: "video", id: "not-candidate", digest: ZERO }
    })).toThrow();
    expect(() => createSeriesProductionGraph({
      series_id: "series-1",
      child_productions: [
        { production_id: "p1", production_contract_digest: ZERO, gate_scope_id: "g1", budget_scope_id: "b1" },
        { production_id: "p2", production_contract_digest: ZERO, gate_scope_id: "g2", budget_scope_id: "b2" }
      ],
      dependencies: [{ before: "p1", after: "p2" }]
    })).not.toThrow();
    expect(() => createSeriesProductionGraph({
      series_id: "series-1",
      child_productions: [{ production_id: "p1", production_contract_digest: ZERO, gate_scope_id: "g1", budget_scope_id: "b1" }],
      dependencies: [{ before: "p1", after: "p1" }]
    })).toThrow();
  });

  it("requires one human BranchSelection for every choose_one mission", () => {
    const contract = compileProductionContract({ project: project() });
    const multi = compileTaskTree({
      production: contract,
      template: {
        schema_version: 1,
        template_id: "multiple-choices",
        root: {
          node_type: "mission",
          node_id: "root",
          template_kind: "parallel",
          children: [
            missionTemplate([taskTemplate({ node_id: "a-1" }), taskTemplate({ node_id: "a-2" })], "choose_one", undefined, "choice-a"),
            missionTemplate([taskTemplate({ node_id: "b-1" }), taskTemplate({ node_id: "b-2" })], "choose_one", undefined, "choice-b")
          ]
        }
      }
    });
    const selection = (missionNodeId: string, selectedId: string): ReturnType<typeof createBranchSelection> => {
      const a = { kind: "video", id: `${missionNodeId}-candidate-a`, digest: ZERO } as DigestRef;
      const b = { kind: "video", id: `${missionNodeId}-candidate-b`, digest: "1".repeat(64) } as DigestRef;
      return createBranchSelection({
        production_id: contract.production_id,
        mission_node_id: missionNodeId,
        candidate_artifact_refs: [a, b],
        selected_artifact_ref: selectedId === a.id ? a : b,
        decision: {
          decision_id: `${missionNodeId}-decision`,
          decision: "human-selection",
          actor: "human",
          decided_at: "2026-08-11T00:00:00.000Z"
        }
      });
    };
    const first = selection("root", "root-candidate-a");
    const second = selection("root", "root-candidate-b");
    expect(() => assertBranchSelectionRequired(multi, first)).toThrow();
    expect(() => assertBranchSelectionRequired(multi, [first])).toThrow();
    expect(() => assertBranchSelectionRequired(multi, [first, second])).toThrow();
    const choiceNodes = multi.nodes.filter((node) => node.node_type === "mission" && node.aggregation.kind === "choose_one");
    const corrected = [
      selection(choiceNodes[0]!.node_id, `${choiceNodes[0]!.node_id}-candidate-a`),
      selection(choiceNodes[1]!.node_id, `${choiceNodes[1]!.node_id}-candidate-b`)
    ];
    expect(() => assertBranchSelectionRequired(multi, corrected)).not.toThrow();
    expect(() => assertBranchSelectionRequired(multi, [corrected[0]!, corrected[0]!])).toThrow();
    expect(() => assertBranchSelectionRequired(multi, {
      ...corrected[0]!,
      selected_artifact_ref: { ...corrected[0]!.selected_artifact_ref, digest: "f".repeat(64) }
    })).toThrow();
    const choiceTemplate = missionTemplate([
      taskTemplate({ node_id: "candidate-a" }),
      taskTemplate({ node_id: "candidate-b" })
    ], "choose_one", undefined, "choice");
    expect(taskEndpoints(choiceTemplate, new Map())).toEqual({ first: [], last: [] });
    expect(taskEndpoints(choiceTemplate, new Map([["choice", "candidate-b"]]))).toEqual({ first: ["candidate-b"], last: ["candidate-b"] });
    const sequenceWithChoice = compileTaskTree({
      production: contract,
      template: {
        schema_version: 1,
        template_id: "choice-sequence",
        root: missionTemplate([choiceTemplate, taskTemplate({ node_id: "after-choice" })], "sequence")
      }
    });
    expect(taskById(sequenceWithChoice, "after-choice")?.dependencies).toEqual([]);
  });
});

describe("PO-2 program binding and role authority", () => {
  const source = {
    schema_version: 1 as const,
    kind: "mv-generation-unit-source" as const,
    production_id: "production-1",
    unit_id: "unit-1",
    ordinal: 0,
    generation_unit_digest: ZERO,
    music: { contract_id: "music-1", revision: 2, contract_digest: ZERO, timing_digest: ZERO, master_audio_digest: ZERO },
    lyrics: { contract_id: "lyrics-1", revision: 1, contract_digest: ZERO, text_digest: ZERO, timing_digest: ZERO },
    program_start_ms: 48_000,
    program_end_ms: 58_000,
    section_id: "chorus-1",
    beat_anchor_refs: [{ ...fragment("music", "beat-1", "beat"), contract_id: "music-1", revision: 2 }],
    lyric_cue_refs: [{ ...fragment("lyrics", "cue-1", "lyric-cue"), contract_id: "lyrics-1", revision: 1 }],
    route: {
      ir_model: "video-model",
      provider_model: "provider-model",
      model_profile_digest: ZERO,
      connection_id: "connection-1",
      connection_digest: ZERO,
      adapter_id: "adapter-1",
      transport: "http",
      mode_binding: "text-to-video",
      route_digest: ZERO
    }
  };

  it("builds the exact one-way program binding and rejects circular references", () => {
    const binding = buildProgramBinding(source);
    expect(binding).toEqual({
      generation_unit_digest: ZERO,
      production_id: "production-1",
      music_contract_digest: ZERO,
      lyrics_contract_digest: ZERO,
      program_start_ms: 48_000,
      program_end_ms: 58_000,
      section_id: "chorus-1",
      beat_anchor_ids: ["beat-1"],
      lyric_cue_ids: ["cue-1"]
    });
    expect(programBindingSchema.parse(binding)).toEqual(binding);
    assertProgramBindingMatchesSource(binding, source);
    expect(() => programBindingSchema.parse({ ...binding, compilation_digest: ZERO })).toThrow();
    expect(programBindingDigest(binding)).toBe(sha256Canonical(binding));
    expect(programBindingRoute(source)).toEqual(source.route);
    expect(programBindingRoute(source).route_digest).toBe(ZERO);
    expect(() => assertNoCircularProgramBinding(null)).not.toThrow();
    expect(() => assertNoCircularProgramBinding([])).not.toThrow();
    expect(() => assertNoCircularProgramBinding(binding)).not.toThrow();
    expect(() => assertNoCircularProgramBinding({ ...binding, ir_digest: ZERO })).toThrow();
    expect(() => assertProgramBindingMatchesSource({ ...binding, program_start_ms: 49_000 }, source)).toThrow();

    const sourceWithoutLyrics = {
      ...source,
      lyrics: undefined,
      section_id: undefined,
      beat_anchor_refs: [],
      lyric_cue_refs: []
    };
    const parsedWithoutLyrics = generationUnitProgramSourceSchema.parse(sourceWithoutLyrics);
    const bindingWithoutLyrics = buildProgramBinding(parsedWithoutLyrics);
    expect(bindingWithoutLyrics).not.toHaveProperty("lyrics_contract_digest");
    expect(bindingWithoutLyrics).not.toHaveProperty("section_id");
    expect(() => generationUnitProgramSourceSchema.parse({
      ...source,
      music: { ...source.music, master_audio_digest: undefined }
    })).toThrow();
    expect(() => generationUnitProgramSourceSchema.parse({
      ...source,
      beat_anchor_refs: [{ ...source.beat_anchor_refs[0]!, contract_id: "other-music" }]
    })).toThrow();
    expect(() => generationUnitProgramSourceSchema.parse({
      ...source,
      beat_anchor_refs: [{ ...source.beat_anchor_refs[0]!, kind: "whole" }]
    })).toThrow();
    expect(() => generationUnitProgramSourceSchema.parse({
      ...source,
      lyric_cue_refs: [{ ...source.lyric_cue_refs[0]!, kind: "section" }]
    })).toThrow();
    expect(() => generationUnitProgramSourceSchema.parse({ ...source, program_end_ms: 1 })).toThrow();
  });

  it("keeps role outputs typed and state/Gate writes Coordinator-only", () => {
    const envelope = createRoleEnvelope({
      envelope_id: "env-1",
      production_id: "production-1",
      node_id: "story-node",
      attempt_id: "attempt-1",
      role: "story",
      effect: "propose",
      input_schema: "story-input",
      output_schema: "story-output",
      input: { brief_digest: ZERO },
      output: { candidate_id: "candidate-1" }
    });
    expect(roleEnvelopeSchema.parse(envelope).authority.state_write).toBe("coordinator-only");
    expect(roleEnvelopeDigest(envelope)).toBe(envelope.envelope_digest);
    const paid = createRoleEnvelope({
      ...envelope,
      role: "generator",
      effect: "paid",
      input: { safe: true },
      output: { safe: true }
    });
    expect(paid.authority).toMatchObject({ external_submit: true, paid_execution: true });
    const localWrite = createRoleEnvelope({
      ...envelope,
      role: "editor",
      effect: "local-write",
      input: { safe: true },
      output: { safe: true }
    });
    expect(localWrite.authority).toMatchObject({ external_submit: false, paid_execution: false });
    expect(() => roleEnvelopeDigest({ ...envelope, envelope_digest: ZERO })).toThrow();
    expect(() => createRoleEnvelope({ ...envelope, role: "unknown" } as never)).toThrow();
    expect(() => createRoleEnvelope({ ...envelope, role: "story", effect: "paid" } as never)).toThrow();
    expect(() => createRoleEnvelope({
      ...envelope,
      role: "story",
      effect: "paid",
      input: { safe: true },
      output: { safe: true }
    } as never)).toThrow();
    expect(() => createRoleEnvelope({
      ...envelope,
      input: { raw_prompt: "do not persist" },
      output: { safe: true }
    } as never)).toThrow();
  });
});

describe("PO-2 Identity migration and fragment invalidation", () => {
  const lockedText = "fixed appearance";
  const ir = {
    subjects: [{
      id: "hero",
      locked: true,
      locked_blocks: { appearance: { text: lockedText, sha256: sha256Bytes(new TextEncoder().encode(lockedText)) } },
      variants: [{ id: "clean", source_asset: "hero-sheet" }]
    }],
    scenes: [{ id: "scene-1", location_map: "lamp beside the pier", palette: "blue", active_subjects: ["hero"], props: [] }],
    shots: [{ id: "shot-1", subject_expectations: [{ subject_id: "hero", visibility: "visible", face_visibility: "required" }] }]
  };

  it("keeps IdentityDefinition separate from Verification and never infers confirmation", () => {
    const migrated = migrateIdentityLockPhaseAtoE({
      ir,
      production_id: "production-1",
      asset_digests: { "hero-sheet": ZERO }
    });
    expect(migrated.status).toBe("awaiting_human");
    expect(migrated.definition?.definition_status).toBe("awaiting_human");
    expect(migrated.definition?.definition_confirmation).toBeUndefined();
    expect(migrated.verification).toBeUndefined();
    expect(migrated.legacy_evidence.locked_flag_seen).toBe(true);
    expect(migrated.issues.some((issue) => issue.code === "identity.legacy_flag_not_authoritative")).toBe(true);
    expect(identityDefinitionSchema.parse(migrated.definition)).toBeTruthy();
    expect(migrateIdentityLock({ ir, production_id: "production-1" }).verification).toBeUndefined();
  });

  it("fails closed for a stale lock hash and missing verification evidence", () => {
    const result = migrateIdentityLockPhaseAtoE({
      ir: {
        ...ir,
        subjects: [{ ...ir.subjects[0], locked_blocks: { appearance: { text: lockedText, sha256: ZERO } } }]
      },
      production_id: "production-1",
      asset_digests: { "hero-sheet": ZERO }
    });
    expect(result.status).toBe("blocked");
    expect(result.issues.some((issue) => issue.code === "identity.lock_hash_mismatch")).toBe(true);
    expect(result.verification).toBeUndefined();
  });

  it("migrates explicit definition confirmation and evidence-backed verification statuses", () => {
    expect(migrateIdentityLockPhaseAtoE({ ir: {}, production_id: "production-1" }).status).toBe("not_applicable");
    const richIr = {
      subjects: [{
        id: "hero",
        locked: true,
        locked_blocks: {
          voice: { text: "calm voice", sha256: sha256Bytes(new TextEncoder().encode("calm voice")) },
          appearance: { text: lockedText, sha256: sha256Bytes(new TextEncoder().encode(lockedText)) },
          manner: { text: "slow gesture", sha256: sha256Bytes(new TextEncoder().encode("slow gesture")) }
        },
        variants: [{ id: "clean", source_asset: "hero-sheet" }, { id: "unknown", source_asset: "missing-sheet" }, null]
      }],
      scenes: [{
        id: "scene-1",
        location_map: "pier",
        palette: "blue",
        wardrobe: "coat",
        props: ["lamp", 1],
        time_of_day: "night",
        screen_direction: "left",
        active_subjects: ["hero", 1]
      }],
      shots: [
        { id: "shot-1", subject_expectations: [{ subject_id: "hero" }, null] },
        { id: "shot-2", subject_expectations: [{ subject_id: "hero" }] }
      ]
    };
    const assetDigests = { "hero-sheet": ZERO };
    const awaiting = migrateIdentityLockPhaseAtoE({ ir: richIr, production_id: "production-1", asset_digests: assetDigests });
    expect(awaiting.definition?.subjects[0]?.locked_blocks).toMatchObject({ voice: expect.anything(), appearance: expect.anything(), manner: expect.anything() });
    expect(awaiting.definition?.subjects[0]?.variants).toHaveLength(1);
    expect(awaiting.issues.some((issue) => issue.code === "identity.variant_asset_unknown")).toBe(true);
    expect(awaiting.definition?.scenes[0]).toMatchObject({ wardrobe: expect.anything(), time_of_day: "night", screen_direction: "left", active_subjects: ["hero"] });
    const { definition_digest: _awaitingDefinitionDigest, digest: _awaitingDigest, ...awaitingDefinitionContent } = awaiting.definition!;
    const confirmedDefinitionDigest = identityDefinitionSubjectDigest({
      ...awaitingDefinitionContent,
      definition_status: "confirmed"
    } as never);
    const definitionConfirmation = {
      decision_id: "definition-decision",
      decision: "confirm-identity-definition",
      actor: "human",
      decided_at: "2026-08-11T00:00:00.000Z",
      subject_digest: confirmedDefinitionDigest
    };
    const selectedOutputRefs = [
      { kind: "video", id: "output-1", digest: ZERO },
      { kind: "video", id: "output-2", digest: "1".repeat(64) }
    ] as DigestRef[];
    const evaluations = [
      {
        condition_id: "shot-shot-1",
        output_refs: [selectedOutputRefs[0]!],
        evidence_artifact_refs: [{ kind: "evidence", id: "evidence-1", digest: ZERO } as DigestRef],
        result: "pass" as const
      },
      {
        condition_id: "shot-shot-2",
        output_refs: [selectedOutputRefs[1]!],
        evidence_artifact_refs: [{ kind: "evidence", id: "evidence-2", digest: "2".repeat(64) } as DigestRef],
        result: "pass" as const
      }
    ];
    const verificationBase = {
      schema_version: 1 as const,
      production_id: "production-1",
      identity_definition_digest: confirmedDefinitionDigest,
      selected_output_refs: selectedOutputRefs,
      required_condition_ids: ["shot-shot-1", "shot-shot-2"],
      evaluated_condition_ids: ["shot-shot-1", "shot-shot-2"],
      evaluations,
      status: "verified" as const,
      coverage_basis: "multiple-conditions" as const,
      distinct_output_count: 2,
      distinct_condition_count: 2
    };
    const verificationDecision = {
      decision_id: "verification-decision",
      decision: "verify-identity",
      actor: "human",
      decided_at: "2026-08-11T00:00:00.000Z",
      subject_digest: identityVerificationSubjectDigest(verificationBase as never)
    };
    const migrated = migrateIdentityLockPhaseAtoE({
      ir: richIr,
      production_id: "production-1",
      asset_digests: assetDigests,
      definition_confirmation: definitionConfirmation,
      verification: { ...verificationBase, decision: verificationDecision }
    });
    expect(migrated.status).toBe("migrated");
    expect(migrated.definition?.definition_status).toBe("confirmed");
    expect(migrated.verification?.status).toBe("verified");
    expect(identityVerificationSchema.parse(migrated.verification)).toBeTruthy();

    const lowRequirements = {
      risk_class: "low" as const,
      conditions: [{ condition_id: "condition-1", description: "condition", subject_ids: ["hero"] }],
      minimum_distinct_outputs: 1,
      minimum_distinct_conditions: 1
    };
    const lowAwaiting = migrateIdentityLockPhaseAtoE({
      ir: richIr,
      production_id: "production-1",
      asset_digests: assetDigests,
      verification_requirements: lowRequirements
    });
    const residualBase = {
      schema_version: 1 as const,
      production_id: "production-1",
      identity_definition_digest: identityDefinitionSubjectDigest({
        ...(({ definition_digest: _definitionDigest, digest: _digest, ...content }) => content)(lowAwaiting.definition!),
        definition_status: "confirmed"
      } as never),
      selected_output_refs: [selectedOutputRefs[0]!],
      required_condition_ids: ["condition-1"],
      evaluated_condition_ids: ["condition-1"],
      evaluations: [{ ...evaluations[0]!, condition_id: "condition-1" }],
      status: "residual-risk-accepted" as const,
      risk_class: "low" as const,
      residual_drifts: ["minor wardrobe drift"],
      acceptance_scope: "single output"
    };
    const residual = migrateIdentityLockPhaseAtoE({
      ir: richIr,
      production_id: "production-1",
      asset_digests: assetDigests,
      verification_requirements: lowRequirements,
      definition_confirmation: {
        ...definitionConfirmation,
        subject_digest: identityDefinitionSubjectDigest({
          ...(({ definition_digest: _definitionDigest, digest: _digest, ...content }) => content)(lowAwaiting.definition!),
          definition_status: "confirmed"
        } as never)
      },
      verification: {
        ...residualBase,
        decision: { ...verificationDecision, subject_digest: identityVerificationSubjectDigest(residualBase as never) }
      }
    });
    expect(residual.status).toBe("migrated");
    expect(residual.verification?.status).toBe("residual-risk-accepted");
  });

  it("rejects single coverage, inflated counts, and omitted status at the verification boundary", () => {
    const outputA = { kind: "video", id: "output-a", digest: ZERO } as DigestRef;
    const outputB = { kind: "video", id: "output-b", digest: "1".repeat(64) } as DigestRef;
    const evaluationA = {
      condition_id: "condition-a",
      output_refs: [outputA],
      evidence_artifact_refs: [{ kind: "evidence", id: "evidence-a", digest: ZERO } as DigestRef],
      result: "pass" as const
    };
    const evaluationB = {
      condition_id: "condition-b",
      output_refs: [outputB],
      evidence_artifact_refs: [{ kind: "evidence", id: "evidence-b", digest: "2".repeat(64) } as DigestRef],
      result: "pass" as const
    };
    const makeReport = (base: Record<string, unknown>) => {
      const decision = {
        decision_id: "verification-decision",
        decision: "verify",
        actor: "human",
        decided_at: "2026-08-11T00:00:00.000Z",
        subject_digest: identityVerificationSubjectDigest(base as never)
      };
      const withSubject = { ...base, decision, verification_subject_digest: identityVerificationSubjectDigest(base as never) };
      return { ...withSubject, digest: sha256Canonical(withSubject) };
    };
    const validBase = {
      schema_version: 1 as const,
      production_id: "production-1",
      identity_definition_digest: ZERO,
      selected_output_refs: [outputA, outputB],
      required_condition_ids: ["condition-a", "condition-b"],
      evaluated_condition_ids: ["condition-a", "condition-b"],
      evaluations: [evaluationA, evaluationB],
      status: "verified" as const,
      coverage_basis: "multiple-conditions" as const,
      distinct_output_count: 2,
      distinct_condition_count: 2
    };
    expect(identityVerificationSchema.parse(makeReport(validBase))).toBeTruthy();
    const singleBase = {
      ...validBase,
      selected_output_refs: [outputA],
      required_condition_ids: ["condition-a"],
      evaluated_condition_ids: ["condition-a"],
      evaluations: [evaluationA],
      distinct_output_count: 1,
      distinct_condition_count: 1
    };
    expect(() => identityVerificationSchema.parse(makeReport(singleBase))).toThrow();
    expect(() => identityVerificationSchema.parse(makeReport({ ...validBase, distinct_output_count: 99 }))).toThrow();
    expect(() => identityVerificationSchema.parse({ ...makeReport(validBase), status: undefined })).toThrow();
    expect(() => identityVerificationSchema.parse(makeReport({
      ...validBase,
      coverage_basis: "multiple-shots",
      selected_output_refs: [outputA],
      evaluations: [{ ...evaluationA, output_refs: [outputA] }, { ...evaluationB, output_refs: [outputA] }],
      distinct_output_count: 1
    }))).toThrow();
    expect(() => identityVerificationSchema.parse(makeReport({
      ...validBase,
      coverage_basis: "multiple-conditions",
      required_condition_ids: ["condition-a"],
      evaluated_condition_ids: ["condition-a"],
      evaluations: [evaluationA],
      distinct_condition_count: 1
    }))).toThrow();
    expect(() => identityVerificationSchema.parse(makeReport({
      ...validBase,
      evaluations: [{ ...evaluationA, result: "drift" as const }, evaluationB]
    }))).toThrow();

    const noStatusInput = {
      ir: {
        subjects: [{ id: "hero", variants: [] }],
        scenes: [],
        shots: [{ id: "shot-1", subject_expectations: [{ subject_id: "hero" }] }]
      },
      production_id: "production-1",
      verification: {
        selected_output_refs: [outputA, outputB],
        required_condition_ids: ["shot-shot-1"],
        evaluated_condition_ids: ["shot-shot-1"],
        evaluations: [{ ...evaluationA, condition_id: "shot-shot-1" }],
        decision: {
          decision_id: "decision-1",
          decision: "verify",
          actor: "human",
          decided_at: "2026-08-11T00:00:00.000Z",
          subject_digest: ZERO
        }
      }
    };
    const noStatus = migrateIdentityLockPhaseAtoE(noStatusInput);
    expect(noStatus.verification).toBeUndefined();
    expect(noStatus.issues.some((issue) => issue.code === "identity.definition_confirmation_missing")).toBe(true);
    const { definition_digest: _definitionDigest, digest: _definitionEnvelopeDigest, ...awaitingContent } = noStatus.definition!;
    const confirmation = {
      decision_id: "definition-confirmation-no-status",
      decision: "confirm-definition",
      actor: "human",
      decided_at: "2026-08-11T00:00:00.000Z",
      subject_digest: identityDefinitionSubjectDigest({ ...awaitingContent, definition_status: "confirmed" } as never)
    };
    const confirmedNoStatus = migrateIdentityLockPhaseAtoE({
      ...noStatusInput,
      definition_confirmation: confirmation,
      verification: noStatusInput.verification
    });
    expect(confirmedNoStatus.verification).toBeUndefined();
    expect(confirmedNoStatus.issues.some((issue) => issue.code === "identity.verification_status_missing")).toBe(true);
  });

  it("invalidates only the changed fragment branch and downstream while preserving siblings", () => {
    const identity = fragment("identity-definition", "hero-appearance", "subject");
    const music = fragment("music", "music-whole", "whole");
    const base = {
      schema_version: 1 as const,
      production_id: "production-1",
      tree_revision: 0,
      root_node_id: "root",
      nodes: [
        { node_type: "mission" as const, node_id: "root", aggregation: { kind: "all" as const }, child_ids: ["a", "b"] },
        { node_type: "task" as const, node_id: "a", parent_id: "root", kind: "identity-definition", role: "identity", effect: "propose" as const, dependencies: [], required_contract_fragments: [identity], required_artifacts: [], output_schema: "identity-output", risk_class: "medium" as const, invalidation_tags: ["identity-definition"] },
        { node_type: "task" as const, node_id: "b", parent_id: "root", kind: "music-analysis", role: "music", effect: "read" as const, dependencies: [], required_contract_fragments: [music], required_artifacts: [], output_schema: "music-output", risk_class: "low" as const, invalidation_tags: ["music"] }
      ]
    };
    const tree = validateTaskTreeSpec({ ...base, digest: sha256Canonical(base) });
    const index = buildDependencyIndex(tree);
    const changed = { ...identity, digest: "f".repeat(64) };
    const report = computeInvalidation({ tree, index, changes: [{ kind: "contract-fragment", ref: changed }] });
    expect(report.stale_node_ids).toEqual(["a"]);
    expect(report.preserved_node_ids).toEqual(["b", "root"]);
    expect(digestRefKey({ kind: "artifact", id: "a", digest: ZERO } as DigestRef)).toContain("artifact");
    const fragmentKey = Object.keys(index.by_fragment)[0]!;
    const tamperedBase = { ...index, by_fragment: { ...index.by_fragment, [fragmentKey]: [] } };
    expect(() => dependencyIndexSchema.parse(tamperedBase)).toThrow();
    expect(() => dependencyIndexDigest(tamperedBase)).toThrow();
    const { digest: _indexDigest, ...tamperedWithoutDigest } = tamperedBase;
    const recomputedTampered = { ...tamperedBase, digest: sha256Canonical(tamperedWithoutDigest) };
    expect(() => computeInvalidation({ tree, index: recomputedTampered, changes: [{ kind: "contract-fragment", ref: identity }] })).toThrow();
  });

  it("keeps exact fragments isolated and reserves whole fallback for whole invalidation", () => {
    const lyricA = fragment("lyrics", "cue-a", "lyric-cue");
    const lyricB = fragment("lyrics", "cue-b", "lyric-cue");
    const base = {
      schema_version: 1 as const,
      production_id: "production-1",
      tree_revision: 0,
      root_node_id: "root",
      nodes: [
        { node_type: "mission" as const, node_id: "root", aggregation: { kind: "all" as const }, child_ids: ["cue-a-task", "cue-b-task", "cue-a-downstream"] },
        { node_type: "task" as const, node_id: "cue-a-task", parent_id: "root", kind: "lyrics-alignment", role: "music", effect: "propose" as const, dependencies: [], required_contract_fragments: [lyricA], required_artifacts: [], output_schema: "lyrics-a-output", risk_class: "low" as const, invalidation_tags: ["lyrics"] },
        { node_type: "task" as const, node_id: "cue-b-task", parent_id: "root", kind: "lyrics-alignment", role: "music", effect: "propose" as const, dependencies: [], required_contract_fragments: [lyricB], required_artifacts: [], output_schema: "lyrics-b-output", risk_class: "low" as const, invalidation_tags: ["lyrics"] },
        { node_type: "task" as const, node_id: "cue-a-downstream", parent_id: "root", kind: "output-qa", role: "critic", effect: "read" as const, dependencies: ["cue-a-task"], required_contract_fragments: [], required_artifacts: [], output_schema: "cue-a-downstream-output", risk_class: "low" as const, invalidation_tags: [] }
      ]
    };
    const tree = validateTaskTreeSpec({ ...base, digest: sha256Canonical(base) });
    const index = buildDependencyIndex(tree);
    const changedCueA = { ...lyricA, digest: "f".repeat(64) };
    expect(directConsumersForFragment(index, changedCueA)).toEqual(["cue-a-task"]);
    const exact = computeInvalidation({ tree, index, changes: [{ kind: "contract-fragment", ref: changedCueA }] });
    expect(exact.stale_node_ids).toEqual(["cue-a-downstream", "cue-a-task"]);
    expect(exact.preserved_node_ids).toEqual(["cue-b-task", "root"]);
    const whole = { ...lyricA, kind: "whole" as const, fragment_id: "lyrics-contract.whole.0" };
    expect(directConsumersForFragment(index, whole)).toEqual(["cue-a-task", "cue-b-task"]);
    const wholeReport = computeInvalidation({ tree, index, changes: [{ kind: "contract-fragment", ref: whole }] });
    expect(wholeReport.stale_node_ids).toEqual(["cue-a-downstream", "cue-a-task", "cue-b-task"]);
  });

  it("indexes artifacts and applies selected-output, decision, and risk tag boundaries", () => {
    const contract = compileProductionContract({ project: project() });
    const selected = { kind: "video", id: "selected-output", digest: ZERO } as DigestRef;
    const tree = compileTaskTree({
      production: contract,
      template: {
        schema_version: 1,
        template_id: "invalidation-tags",
        root: missionTemplate([
          taskTemplate({ node_id: "source" }),
          taskTemplate({ node_id: "evidence", invalidation_tags: ["evidence"] }),
          taskTemplate({ node_id: "risk", required_artifacts: [selected], invalidation_tags: ["risk", "residual-risk"] })
        ], "sequence")
      }
    });
    const index = buildDependencyIndex(tree);
    expect(dependencyIndexDigest(index)).toBe(index.digest);
    expect(directConsumersForArtifact(index, selected)).toEqual(["risk"]);
    expect(downstreamClosure(index, ["source"])).toEqual(["evidence", "risk", "source"]);
    expect(taskById(tree, "evidence")?.node_id).toBe("evidence");
    expect(taskById(tree, "production")).toBeUndefined();
    const report = computeInvalidation({
      tree,
      index,
      changes: [
        { kind: "selected-output", ref: selected },
        { kind: "human-decision", ref: { kind: "decision", id: "decision-1", digest: ZERO } },
        { kind: "residual-risk", ref: { kind: "risk", id: "risk-1", digest: ZERO } }
      ],
      gate_bindings: [
        { binding_id: "gate-1-binding", gate: "gate-1", node_ids: ["source"] },
        { binding_id: "gate-2-binding", gate: "gate-2", node_ids: ["risk"] },
        { binding_id: "gate-3-binding", gate: "gate-3", node_ids: ["evidence"] }
      ],
      credits_at_risk: "unknown"
    });
    expect(report.estimated_rework.credits_at_risk).toBe("unknown");
    expect(report.stale_node_ids).toEqual(["evidence", "risk"]);
    expect(report.stale_gate_bindings).toEqual(["gate-1-binding", "gate-2-binding", "gate-3-binding"]);
    expect(report.preserved_node_ids).toContain("source");
    expect(() => computeInvalidation({ tree, index, changes: [] })).toThrow();
    expect(() => computeInvalidation({ tree, index: { ...index, tree_digest: ZERO }, changes: [{ kind: "risk", ref: selected }] })).toThrow();
    expect(() => dependencyIndexDigest({ ...index, digest: ZERO })).toThrow();
  });
});

describe("PO-2 shadow compatibility", () => {
  it("keeps shadow summary out of legacy plan JSON and exposes it read-only", async () => {
    const loaded = await loadProject("examples/local-fixture/project.yaml");
    const manifest = manifestSchema.parse(JSON.parse(await readFile("examples/local-fixture/manifest.json", "utf8")));
    const legacy = createPlan(loaded, manifest);
    const shadowProject = { ...loaded, orchestration: { mode: "shadow" as const } };
    const shadow = createPlan(shadowProject, manifest);
    expect(JSON.stringify(shadow)).toBe(JSON.stringify(legacy));
    expect(shadow.production_control_shadow?.mode).toBe("shadow");
    expect(shadow.production_control_shadow?.status).toBe("available");
    expect(buildProductionControlShadowSummary(shadowProject).status).toBe("available");
    const legacyReview = createReviewDocument(loaded, manifest, legacy);
    const shadowReview = createReviewDocument(shadowProject, manifest, shadow);
    expect(legacyProjectProjection(shadowProject)).toEqual(legacyProjectProjection(loaded));
    expect(legacyReviewDocumentProjection(shadowReview)).toEqual(legacyReviewDocumentProjection(legacyReview));
    expect(renderReviewHtml(shadowReview)).toContain('data-testid="production-control-shadow"');
    expect(renderReviewHtml(legacyReview)).not.toContain('data-testid="production-control-shadow"');
  });
});
