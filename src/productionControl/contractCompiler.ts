import type { Project } from "../project/schema.js";
import {
  digestSchema,
  productionContractSchema,
  safeIdSchema,
  type ContractRequirement,
  type ProductionContract
} from "./schema.js";
import { assertSafeJsonValue, sha256Bytes, sha256Canonical, withoutField } from "./canonical.js";
import { pcError } from "./errors.js";
import { compileTaskTree } from "./taskTreeCompiler.js";
import { createDefaultTaskTreeTemplate } from "./taskTreeTemplates.js";
import type { TaskTreeSpec } from "./schema.js";

export const PRODUCTION_CONTRACT_COMPILER_VERSION = "po2-contract-compiler-v1" as const;
export const DEFAULT_PRODUCTION_LIMITS = {
  max_tree_depth: 6,
  max_nodes: 256,
  max_parallel_pure_tasks: 3,
  max_effectful_tasks: 1 as const
};

export type ProductionContractCompilerInput = {
  project: Project | Record<string, unknown>;
  brief?: string;
  objective?: string;
  production_id?: string;
  project_yaml_digest?: string;
  projectYamlDigest?: string;
  rule_set_digest?: string;
  duration_ms?: number;
  aspect?: string;
  locale?: string;
  must_include?: string[];
  prohibited?: string[];
  compiler_version?: string;
};

function projectValue(input: ProductionContractCompilerInput): Record<string, unknown> {
  if (!input.project || typeof input.project !== "object" || Array.isArray(input.project)) {
    throw pcError("PC_SCHEMA_INVALID", "production contract requires a project object");
  }
  return input.project as Record<string, unknown>;
}

type DigestProjectionDisposition = "drop" | "hash" | "recurse";

function digestProjectionDisposition(key: string): DigestProjectionDisposition {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
  if (/(?:^|_)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|authorization|cookie|credential|password|private[_-]?key|secret|provider[_-]?(?:body|request|response)|raw[_-]?provider)(?:$|_)/.test(normalized)) {
    return "drop";
  }
  if (normalized === "prompt" || normalized === "raw_prompt" || normalized.endsWith("_prompt")) return "hash";
  if (normalized === "path" || normalized.endsWith("_path") || normalized === "manifest" || normalized === "dist_dir" || normalized === "source_asset") {
    return "hash";
  }
  return "recurse";
}

function digestProjectionField(value: unknown): string {
  const projected = privacySafeDigestValue(value);
  if (typeof projected === "string") return sha256Bytes(new TextEncoder().encode(projected));
  return sha256Canonical(projected);
}

function digestProjectionKey(key: string): string {
  return `field_${sha256Bytes(new TextEncoder().encode(key))}`;
}

function privacySafeDigestValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => privacySafeDigestValue(entry))
      .filter((entry): entry is Exclude<typeof entry, undefined> => entry !== undefined);
  }
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      const disposition = digestProjectionDisposition(key);
      if (disposition === "drop") continue;
      if (disposition === "hash") {
        result[digestProjectionKey(key)] = digestProjectionField(entry);
        continue;
      }
      result[key] = privacySafeDigestValue(entry);
    }
    return result;
  }
  return value;
}

function safeProjectDigestProjection(project: Record<string, unknown>): Record<string, unknown> {
  const projection = privacySafeDigestValue(project);
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) {
    throw pcError("PC_SCHEMA_INVALID", "project digest projection must be an object");
  }
  assertSafeJsonValue(projection, "project digest projection");
  return projection as Record<string, unknown>;
}

function requirement(requirement: ContractRequirement["requirement"], reason: string): ContractRequirement {
  return { requirement, reason };
}

function hasIdentity(project: Record<string, unknown>): boolean {
  const quality = project.quality;
  if (quality && typeof quality === "object" && !Array.isArray(quality)) {
    const person = (quality as Record<string, unknown>).person_consistency;
    if (person && typeof person === "object" && !Array.isArray(person)
      && (person as Record<string, unknown>).enabled === true) return true;
  }
  const generation = project.generation;
  if (!generation || typeof generation !== "object" || Array.isArray(generation)) return false;
  const requests = (generation as Record<string, unknown>).requests;
  if (!Array.isArray(requests)) return false;
  return requests.some((request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) return false;
    const value = request as Record<string, unknown>;
    for (const key of ["h3", "video_prompt"]) {
      const ir = value[key];
      if (ir && typeof ir === "object" && !Array.isArray(ir)) {
        const subjects = (ir as Record<string, unknown>).subjects;
        if (Array.isArray(subjects) && subjects.length > 0) return true;
      }
    }
    return false;
  });
}

function hasInputAssets(project: Record<string, unknown>): boolean {
  const generation = project.generation;
  if (!generation || typeof generation !== "object" || Array.isArray(generation)) return false;
  const requests = (generation as Record<string, unknown>).requests;
  if (!Array.isArray(requests)) return false;
  return requests.some((request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) return false;
    const value = request as Record<string, unknown>;
    return ["first_frame", "last_frame", "reference_images", "input_images", "input_video", "input_videos", "input_audios"]
      .some((key) => value[key] !== undefined);
  });
}

function hasMusic(project: Record<string, unknown>): boolean {
  if (project.audio !== undefined) return true;
  const generation = project.generation;
  if (!generation || typeof generation !== "object" || Array.isArray(generation)) return false;
  const requests = (generation as Record<string, unknown>).requests;
  return Array.isArray(requests) && requests.some((request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) return false;
    const value = request as Record<string, unknown>;
    return value.audio_role === "music" || value.operation === "music";
  });
}

function hasLyrics(project: Record<string, unknown>): boolean {
  const generation = project.generation;
  if (!generation || typeof generation !== "object" || Array.isArray(generation)) return false;
  const requests = (generation as Record<string, unknown>).requests;
  return Array.isArray(requests) && requests.some((request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) return false;
    for (const key of ["h3", "video_prompt"]) {
      const ir = (request as Record<string, unknown>)[key];
      if (!ir || typeof ir !== "object" || Array.isArray(ir)) continue;
      const shots = (ir as Record<string, unknown>).shots;
      if (!Array.isArray(shots)) continue;
      if (shots.some((shot) => shot && typeof shot === "object" && !Array.isArray(shot)
        && ((shot as Record<string, unknown>).lyrics !== undefined
          || (shot as Record<string, unknown>).vocal_events !== undefined))) return true;
    }
    return false;
  });
}

function buildSlots(project: Record<string, unknown>): ProductionContract["contract_slots"] {
  const identity = hasIdentity(project);
  const music = hasMusic(project);
  const lyrics = hasLyrics(project);
  const assets = hasInputAssets(project);
  const declarations = project.contract_slots && typeof project.contract_slots === "object" && !Array.isArray(project.contract_slots)
    ? project.contract_slots as Record<string, unknown>
    : {};
  const declared = (slot: "assets" | "identity" | "music" | "lyrics"): ContractRequirement["requirement"] | undefined => {
    const value = declarations[slot];
    return value === "required" || value === "optional" || value === "not_applicable" ? value : undefined;
  };
  const declaredReason = (slot: "assets" | "identity" | "music" | "lyrics", value: ContractRequirement["requirement"]): string =>
    `project explicitly declares ${slot} as ${value}`;
  const identityDeclaration = declared("identity");
  const musicDeclaration = declared("music");
  const assetsDeclaration = declared("assets");
  const lyricsDeclaration = declared("lyrics");
  return {
    assets: assetsDeclaration
      ? requirement(assetsDeclaration, declaredReason("assets", assetsDeclaration))
      : assets
      ? requirement("required", "generation requests declare source assets")
      : requirement("optional", "no source asset binding is declared"),
    identity: identityDeclaration
      ? requirement(identityDeclaration, declaredReason("identity", identityDeclaration))
      : identity
      ? requirement("required", "identity-bearing subjects or person consistency are declared")
      : requirement("optional", "identity applicability is unknown without an explicit project declaration"),
    music: musicDeclaration
      ? requirement(musicDeclaration, declaredReason("music", musicDeclaration))
      : music
      ? requirement("required", "audio or music production is declared")
      : requirement("optional", "music applicability is unknown without an explicit project declaration"),
    lyrics: lyricsDeclaration
      ? requirement(lyricsDeclaration, declaredReason("lyrics", lyricsDeclaration))
      : lyrics
      ? requirement("required", "lyrics or vocal cues are declared")
      : requirement("optional", "lyrics timing is not declared")
  };
}

function buildDeliverables(project: Record<string, unknown>): ProductionContract["deliverables"] {
  const deliverables: ProductionContract["deliverables"] = [
    {
      id: "primary-output",
      kind: "video",
      required: true,
      acceptance_summary: "legacy project output remains the canonical deliverable"
    }
  ];
  if (project.audio !== undefined) {
    deliverables.push({
      id: "audio-source",
      kind: "audio",
      required: false,
      acceptance_summary: "audio source is retained as a project-local input or reference"
    });
  }
  return deliverables;
}

export function compileProductionContract(input: ProductionContractCompilerInput): ProductionContract {
  const project = projectValue(input);
  const slug = safeIdSchema.parse(project.slug);
  const productionId = safeIdSchema.parse(input.production_id ?? project.run_id ?? slug);
  const suppliedProjectDigest = input.project_yaml_digest ?? input.projectYamlDigest;
  const projectYamlDigest = suppliedProjectDigest === undefined
    ? sha256Canonical(safeProjectDigestProjection(project))
    : digestSchema.parse(suppliedProjectDigest);
  const briefDigest = sha256Canonical(input.brief ?? safeProjectDigestProjection(project));
  const ruleSetDigest = input.rule_set_digest ?? "0".repeat(64);
  const compilerVersion = input.compiler_version ?? PRODUCTION_CONTRACT_COMPILER_VERSION;
  const objective = input.objective ?? (typeof project.name === "string" ? project.name : slug);
  const constraints = {
    ...(input.duration_ms === undefined ? {} : { duration_ms: input.duration_ms }),
    ...(input.aspect === undefined ? {} : { aspect: input.aspect }),
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    must_include: [...(input.must_include ?? [])],
    prohibited: [...(input.prohibited ?? [])]
  };
  const base = {
    schema_version: 1 as const,
    production_id: productionId,
    project: { slug, project_yaml_digest: projectYamlDigest },
    objective,
    deliverables: buildDeliverables(project),
    constraints,
    authority: {
      gate_1: "human" as const,
      gate_2: "human-or-existing-safe-auto-pass" as const,
      gate_3: "human" as const,
      render: "explicit-human-command" as const,
      publish: "explicit-human-command" as const
    },
    contract_slots: buildSlots(project),
    limits: { ...DEFAULT_PRODUCTION_LIMITS },
    created_from: { brief_digest: briefDigest, compiler_version: compilerVersion },
    rule_set_digest: ruleSetDigest
  };
  assertSafeJsonValue(base, "production contract");
  const contract = {
    ...base,
    root_digest: sha256Canonical(base)
  };
  const parsed = productionContractSchema.safeParse(contract);
  if (!parsed.success) {
    throw pcError("PC_SCHEMA_INVALID", "compiled production contract is invalid");
  }
  return parsed.data;
}

export const compileProductionContractV1 = compileProductionContract;

export type ProductionControlShadowSummary = {
  mode: "shadow";
  status: "available" | "blocked";
  production_id: string;
  contract_digest?: string;
  tree_digest?: string;
  node_count?: number;
  awaiting_human_reasons: string[];
  issue_codes: string[];
};

export function buildProductionControlShadowSummary(project: Project | Record<string, unknown>): ProductionControlShadowSummary {
  try {
    const contract = compileProductionContract({ project });
    const tree: TaskTreeSpec = compileTaskTree({
      production: contract,
      template: createDefaultTaskTreeTemplate(contract)
    });
    const awaiting = ["Gate 1 remains a human decision", "identity definition confirmation is separate from output verification"];
    if (contract.contract_slots.identity.requirement === "not_applicable") awaiting.pop();
    return {
      mode: "shadow",
      status: "available",
      production_id: contract.production_id,
      contract_digest: contract.root_digest,
      tree_digest: tree.digest,
      node_count: tree.nodes.length,
      awaiting_human_reasons: awaiting,
      issue_codes: []
    };
  } catch (error) {
    return {
      mode: "shadow",
      status: "blocked",
      production_id: typeof project === "object" && project && "slug" in project && typeof project.slug === "string"
        ? project.slug
        : "unknown-production",
      awaiting_human_reasons: [],
      issue_codes: [error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "PC_CONTRACT_INVALID"]
    };
  }
}

export function productionContractDigest(contract: ProductionContract): string {
  const parsed = productionContractSchema.parse(contract);
  const withoutRoot = withoutField(parsed, "root_digest");
  if (sha256Canonical(withoutRoot) !== parsed.root_digest) {
    throw pcError("PC_CONTRACT_INVALID", "production contract root digest mismatch");
  }
  return parsed.root_digest;
}
