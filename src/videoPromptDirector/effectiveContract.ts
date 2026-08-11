import { z } from "zod";
import { sha256Canonical } from "../integrity/canonical.js";
import {
  connectionCapabilityDigest,
  type ConnectionCapabilityProfile,
  type ExactModelRoute
} from "./connectionCapability.js";
import { modelProfileDigest, type ModelPromptProfile } from "./modelProfile.js";
import { issue, type H3Issue } from "./validation/types.js";
import { routeIdentitySchema, type RouteIdentityV1 } from "../productionControl/programBinding.js";
import { digestSchema, safeIdSchema } from "../productionControl/schema.js";
import type { VideoPromptModeV2 } from "./schemaV2.js";

export type CapabilityClaim<T> = {
  value: T;
  authority: "hard" | "advisory";
  source: string;
  source_digest: string;
  verified_at: string;
  review_after?: string;
};

export type BudgetLimit = {
  limit: number;
  unit: "unicode-code-points" | "utf8-bytes" | "tokens";
  source: "official-api" | "adapter" | "advisory-catalog";
  verified_at: string;
  source_digest?: string;
};

export type PromptBudget = {
  hard: BudgetLimit | null;
  soft: BudgetLimit | null;
  unknown: boolean;
};

export type EffectiveCapabilityEvidence = {
  duration: "hard" | "unknown";
  aspect: "hard" | "unknown";
  resolution: "hard" | "unknown";
  mode: "hard" | "unknown";
  reference: "hard" | "unknown";
  group_speaker: "hard" | "unknown";
  exact_text: "hard" | "unknown";
};

export type EffectiveGenerationContractV1 = {
  schema_version: 1;
  route: RouteIdentityV1;
  mode: VideoPromptModeV2;
  effective: {
    durations_ms: number[] | "unknown";
    aspects: string[] | "unknown";
    resolutions: string[] | "unknown";
    reference_caps: string[] | "unknown";
    prompt_budget: PromptBudget;
  };
  advisory_warnings: Array<{ claim_ref: string; message: string }>;
  digests: {
    knowledge?: string;
    model_profile: string;
    connection_profile: string;
    adapter_route: string;
  };
  freshness: {
    status: "fresh" | "stale" | "unknown";
    review_after?: string;
  };
  overrides: string[];
  execution: {
    status: "planning-only" | "execution-capable";
    capability_evidence: EffectiveCapabilityEvidence;
  };
  digest: string;
};

export type RouteIdentityInput = {
  ir_model: string;
  provider_model: string;
  model_profile_digest: string;
  connection_id: string;
  connection_digest: string;
  adapter_id: string;
  transport: string;
  mode_binding: string;
};

export type EffectiveContractInput = {
  mode: VideoPromptModeV2;
  model_profile?: ModelPromptProfile;
  model_profile_digest?: string;
  connection_profile?: ConnectionCapabilityProfile;
  connection_profile_digest?: string;
  route?: RouteIdentityV1;
  adapter_route_digest?: string;
  budget?: PromptBudget;
  freshness?: EffectiveGenerationContractV1["freshness"];
  knowledge_digest?: string;
  now?: string;
  execution_capable?: boolean;
  capability_evidence?: Partial<EffectiveCapabilityEvidence>;
};

const budgetLimitSchema = z.object({
  limit: z.number().int().positive(),
  unit: z.enum(["unicode-code-points", "utf8-bytes", "tokens"]),
  source: z.enum(["official-api", "adapter", "advisory-catalog"]),
  verified_at: z.string().min(1),
  source_digest: digestSchema.optional()
}).strict();

const promptBudgetSchema = z.object({
  hard: budgetLimitSchema.nullable(),
  soft: budgetLimitSchema.nullable(),
  unknown: z.boolean()
}).strict();

export const effectiveGenerationContractSchema = z.object({
  schema_version: z.literal(1),
  route: routeIdentitySchema,
  mode: z.enum(["text-to-video", "first-frame", "first-last", "last-frame", "reference"]),
  effective: z.object({
    durations_ms: z.union([z.array(z.number().int().positive()), z.literal("unknown")]),
    aspects: z.union([z.array(z.string().min(1)), z.literal("unknown")]),
    resolutions: z.union([z.array(z.string().min(1)), z.literal("unknown")]),
    reference_caps: z.union([z.array(z.string().min(1)), z.literal("unknown")]),
    prompt_budget: promptBudgetSchema
  }).strict(),
  advisory_warnings: z.array(z.object({ claim_ref: safeIdSchema, message: z.string() }).strict()),
  digests: z.object({
    knowledge: digestSchema.optional(),
    model_profile: digestSchema,
    connection_profile: digestSchema,
    adapter_route: digestSchema
  }).strict(),
  freshness: z.object({ status: z.enum(["fresh", "stale", "unknown"]), review_after: z.string().optional() }).strict(),
  overrides: z.array(z.string()),
  execution: z.object({
    status: z.enum(["planning-only", "execution-capable"]),
    capability_evidence: z.object({
      duration: z.enum(["hard", "unknown"]),
      aspect: z.enum(["hard", "unknown"]),
      resolution: z.enum(["hard", "unknown"]),
      mode: z.enum(["hard", "unknown"]),
      reference: z.enum(["hard", "unknown"]),
      group_speaker: z.enum(["hard", "unknown"]),
      exact_text: z.enum(["hard", "unknown"])
    }).strict()
  }).strict(),
  digest: digestSchema
}).strict().superRefine((contract, context) => {
  const { digest, ...withoutDigest } = contract;
  if (sha256Canonical(withoutDigest) !== digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "effective generation contract digest mismatch" });
  }
});

export function assertEffectiveGenerationContract(
  value: unknown,
  expected: {
    route: RouteIdentityV1;
    mode: VideoPromptModeV2;
    model_profile_digest?: string;
    connection_digest?: string;
    intent?: "planning" | "execute";
  }
): { ok: true; contract: EffectiveGenerationContractV1; issues: H3Issue[] } | { ok: false; issues: H3Issue[] } {
  let contract: EffectiveGenerationContractV1;
  try {
    contract = effectiveGenerationContractSchema.parse(value) as EffectiveGenerationContractV1;
  } catch {
    return { ok: false, issues: [issue("VPD-K002", "effective generation contract is not a strict contract", "error", ["effective_contract"])] };
  }
  const issues: H3Issue[] = [];
  const { digest: _digest, ...withoutDigest } = contract;
  if (sha256Canonical(withoutDigest) !== contract.digest) issues.push(issue("VPD-K002", "effective generation contract digest is stale", "error", ["effective_contract", "digest"]));
  issues.push(...assertRouteIdentity(contract.route, {
    model: expected.route.ir_model,
    mode: expected.mode,
    model_profile_digest: expected.model_profile_digest ?? expected.route.model_profile_digest,
    connection_digest: expected.connection_digest ?? expected.route.connection_digest
  }));
  if (sha256Canonical(contract.route) !== sha256Canonical(expected.route)) issues.push(issue("VPD-R001", "effective generation contract route does not match the requested route", "error", ["effective_contract", "route"]));
  if (contract.mode !== expected.mode) issues.push(issue("VPD-R001", "effective generation contract mode does not match the IR target", "error", ["effective_contract", "mode"]));
  if (contract.digests.model_profile !== contract.route.model_profile_digest) issues.push(issue("VPD-K002", "effective contract model profile digest does not match its route", "error", ["effective_contract", "digests", "model_profile"]));
  if (contract.digests.connection_profile !== contract.route.connection_digest) issues.push(issue("VPD-K002", "effective contract connection capability digest does not match its route", "error", ["effective_contract", "digests", "connection_profile"]));
  if (contract.digests.adapter_route !== contract.route.route_digest) issues.push(issue("VPD-R001", "effective contract adapter route digest does not match its route", "error", ["effective_contract", "digests", "adapter_route"]));
  if (expected.intent === "execute") {
    if (contract.execution.status !== "execution-capable") issues.push(issue("VPD-K003", "effective contract is planning-only and cannot authorize execution", "error", ["effective_contract", "execution", "status"]));
    if (contract.freshness.status !== "fresh") issues.push(issue("VPD-K003", "execution requires fresh model/profile/capability evidence", "error", ["effective_contract", "freshness"]));
    for (const [name, value] of Object.entries(contract.execution.capability_evidence)) {
      if (value !== "hard") issues.push(issue("VPD-K003", `execution capability '${name}' is not proven by hard evidence`, "error", ["effective_contract", "execution", "capability_evidence", name]));
    }
    if (contract.effective.prompt_budget.unknown || (!contract.effective.prompt_budget.hard && !contract.effective.prompt_budget.soft)) {
      issues.push(issue("VPD-K003", "execution requires a known pinned prompt budget", "error", ["effective_contract", "effective", "prompt_budget"]));
    }
  }
  if (issues.some((item) => item.severity === "error")) return { ok: false, issues };
  return { ok: true, contract, issues };
}

export function createRouteIdentity(
  input: RouteIdentityInput
): RouteIdentityV1 {
  return routeIdentitySchema.parse({ ...input, route_digest: sha256Canonical(input) });
}

export function routeIdentityDigest(route: RouteIdentityV1): string {
  const { route_digest: _routeDigest, ...identity } = route;
  return sha256Canonical(identity);
}

export function assertRouteIdentity(
  route: RouteIdentityV1,
  expected: { model?: string; mode?: string; model_profile_digest?: string; connection_digest?: string } = {}
): H3Issue[] {
  const issues: H3Issue[] = [];
  try {
    routeIdentitySchema.parse(route);
  } catch {
    issues.push(issue("VPD-R001", "route identity is not a strict RouteIdentity contract", "error", ["route"]));
    return issues;
  }
  if (routeIdentityDigest(route) !== route.route_digest) {
    issues.push(issue("VPD-R001", "route identity digest is stale", "error", ["route", "route_digest"]));
  }
  if (expected.model !== undefined && route.ir_model !== expected.model) {
    issues.push(issue("VPD-R001", "route identity model does not match the IR target", "error", ["route", "ir_model"]));
  }
  if (expected.mode !== undefined && route.mode_binding !== expected.mode) {
    issues.push(issue("VPD-R001", "route identity mode binding does not match the IR target", "error", ["route", "mode_binding"]));
  }
  if (expected.model_profile_digest !== undefined && route.model_profile_digest !== expected.model_profile_digest) {
    issues.push(issue("VPD-K002", "route identity is bound to a different model profile digest", "error", ["route", "model_profile_digest"]));
  }
  if (expected.connection_digest !== undefined && route.connection_digest !== expected.connection_digest) {
    issues.push(issue("VPD-K002", "route identity is bound to a different connection capability digest", "error", ["route", "connection_digest"]));
  }
  return issues;
}

export function routeFromProfiles(input: {
  model: string;
  mode: VideoPromptModeV2;
  model_profile: ModelPromptProfile;
  connection_profile: ConnectionCapabilityProfile;
  model_profile_digest?: string;
  connection_profile_digest?: string;
}): { ok: true; route: RouteIdentityV1 } | { ok: false; issues: H3Issue[] } {
  const modelDigest = input.model_profile_digest ?? modelProfileDigest(input.model_profile);
  const connectionDigest = input.connection_profile_digest ?? connectionCapabilityDigest(input.connection_profile);
  const route = input.connection_profile.exact_model_routes.find((candidate) => candidate.model === input.model);
  if (!route) {
    return { ok: false, issues: [issue("VPD-R001", "connection capability has no exact model route", "error", ["route"])] };
  }
  if (!input.connection_profile.adapter_id) {
    return { ok: false, issues: [issue("VPD-R001", "connection capability route has no adapter identity", "error", ["route", "adapter_id"])] };
  }
  try {
    return {
      ok: true,
      route: createRouteIdentity({
        ir_model: input.model,
        provider_model: route.provider_model,
        model_profile_digest: modelDigest,
        connection_id: input.connection_profile.connection_id,
        connection_digest: connectionDigest,
        adapter_id: input.connection_profile.adapter_id,
        transport: input.connection_profile.transport,
        mode_binding: input.mode
      })
    };
  } catch {
    return { ok: false, issues: [issue("VPD-R001", "could not construct a strict route identity", "error", ["route"])] };
  }
}

export function createEffectiveGenerationContract(
  input: EffectiveContractInput
): { ok: true; contract: EffectiveGenerationContractV1; issues: H3Issue[] } | { ok: false; issues: H3Issue[] } {
  const issues: H3Issue[] = [];
  const modelDigest = input.model_profile_digest ?? input.route?.model_profile_digest ?? (input.model_profile ? modelProfileDigest(input.model_profile) : undefined);
  const connectionDigest = input.connection_profile_digest ?? input.route?.connection_digest ?? (input.connection_profile ? connectionCapabilityDigest(input.connection_profile) : undefined);
  const route = input.route;
  if (!route || !modelDigest || !connectionDigest) {
    return { ok: false, issues: [issue("VPD-K002", "effective generation contract requires model, connection, and route digests", "error", ["route"])] };
  }
  issues.push(...assertRouteIdentity(route, {
    model: input.model_profile?.id,
    mode: input.mode,
    model_profile_digest: modelDigest,
    connection_digest: connectionDigest
  }));
  if (issues.some((item) => item.severity === "error")) return { ok: false, issues };

  const freshness = input.freshness ?? inferFreshness(input, input.now ?? new Date().toISOString());
  if (freshness.status === "stale") issues.push(issue("VPD-K001", "model/profile/capability freshness has expired", "error", ["freshness"]));

  const budget = input.budget ?? { hard: null, soft: null, unknown: true };
  issues.push(...validatePromptBudget(budget));
  if (issues.some((item) => item.severity === "error")) return { ok: false, issues };

  const profileRoute = input.connection_profile?.exact_model_routes.find((item) => item.model === route.ir_model);
  const derivedEvidence: EffectiveCapabilityEvidence = {
    duration: input.model_profile ? "hard" : "unknown",
    aspect: input.model_profile ? "hard" : "unknown",
    resolution: input.model_profile ? "hard" : "unknown",
    mode: profileRoute?.modes.includes(input.mode) ? "hard" : "unknown",
    reference: profileRoute?.modes.includes(input.mode) ? "hard" : "unknown",
    group_speaker: "unknown",
    exact_text: "unknown",
    ...input.capability_evidence
  };
  const executionStatus = input.execution_capable ? "execution-capable" as const : "planning-only" as const;
  const contractWithoutDigest = {
    schema_version: 1 as const,
    route,
    mode: input.mode,
    effective: {
      durations_ms: input.model_profile ? input.model_profile.durations.map((seconds) => Math.round(seconds * 1_000)) : "unknown" as const,
      aspects: input.model_profile?.aspects ?? "unknown" as const,
      resolutions: input.model_profile?.resolutions ?? "unknown" as const,
      reference_caps: profileRoute?.modes ?? "unknown" as const,
      prompt_budget: budget
    },
    advisory_warnings: [],
    digests: {
      ...(input.knowledge_digest ? { knowledge: input.knowledge_digest } : {}),
      model_profile: modelDigest,
      connection_profile: connectionDigest,
      adapter_route: input.adapter_route_digest ?? route.route_digest
    },
    freshness,
    overrides: [] as string[],
    execution: {
      status: executionStatus,
      capability_evidence: derivedEvidence
    }
  };
  const contract: EffectiveGenerationContractV1 = {
    ...contractWithoutDigest,
    digest: sha256Canonical(contractWithoutDigest)
  };
  return { ok: true, contract, issues };
}

export function validatePromptBudget(budget: PromptBudget): H3Issue[] {
  const issues: H3Issue[] = [];
  for (const [key, value] of [["hard", budget.hard], ["soft", budget.soft]] as const) {
    if (!value) continue;
    if (!Number.isSafeInteger(value.limit) || value.limit <= 0) {
      issues.push(issue("VPD-B001", `${key} prompt budget must be a positive safe integer`, "error", ["budget", key]));
    }
  }
  if (budget.hard && budget.soft && budget.soft.limit > budget.hard.limit) {
    issues.push(issue("VPD-B001", "soft prompt budget cannot exceed the hard prompt budget", "error", ["budget"]));
  }
  if (budget.unknown && !budget.hard && !budget.soft) return issues;
  return issues;
}

export function validatePromptLength(
  text: string,
  budget: PromptBudget
): H3Issue[] {
  const issues: H3Issue[] = [];
  if (budget.unknown && !budget.hard && !budget.soft) return issues;
  const unit = budget.hard?.unit ?? budget.soft?.unit;
  const length = unit === "utf8-bytes"
    ? Buffer.byteLength(text, "utf8")
    : unit === "tokens"
      ? undefined
      : [...text].length;
  if (length === undefined) {
    issues.push(issue("VPD-B003", "token prompt budget cannot be measured without a pinned tokenizer", "error", ["budget"]));
    return issues;
  }
  if (budget.hard && length > budget.hard.limit) {
    issues.push(issue("VPD-B001", `prompt exceeds hard budget (${length} > ${budget.hard.limit})`, "error", ["prompt"]));
  } else if (budget.soft && length > budget.soft.limit) {
    issues.push(issue("VPD-B002", `prompt exceeds soft budget (${length} > ${budget.soft.limit})`, "warning", ["prompt"]));
  }
  return issues;
}

export function assertHomogeneousRouteIdentity(routes: readonly RouteIdentityV1[]): H3Issue[] {
  if (routes.length < 2) return [];
  const first = routes[0]!;
  const keys = (route: RouteIdentityV1) => [
    route.ir_model,
    route.provider_model,
    route.model_profile_digest,
    route.connection_id,
    route.connection_digest,
    route.adapter_id,
    route.transport,
    route.mode_binding,
    route.route_digest
  ].join("\u0000");
  return routes.every((route) => keys(route) === keys(first))
    ? []
    : [issue("VPD-R001", "a generation batch cannot mix RouteIdentity values", "error", ["route"])] ;
}

function inferFreshness(input: EffectiveContractInput, now: string): EffectiveGenerationContractV1["freshness"] {
  const reviewAfter = input.model_profile?.source.review_after;
  if (!reviewAfter) return { status: "unknown" };
  return reviewAfter > now ? { status: "fresh", review_after: reviewAfter } : { status: "stale", review_after: reviewAfter };
}

export function assertExactModelRoute(
  route: ExactModelRoute,
  model: string,
  mode: VideoPromptModeV2
): H3Issue[] {
  if (route.model !== model || !route.modes.includes(mode)) {
    return [issue("VPD-R001", "exact model route does not support the requested model/mode", "error", ["route"])] ;
  }
  return [];
}
