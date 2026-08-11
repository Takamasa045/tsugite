import { sha256Canonical } from "../integrity/canonical.js";
import { loadAdapterDefinition } from "../adapters/registry.js";
import type { RouteIdentityV1 } from "../productionControl/programBinding.js";
import type { ModelPromptProfile } from "./modelProfile.js";
import type { ConnectionCapabilityProfile } from "./connectionCapability.js";
import type { VideoPromptIrV2 } from "./schemaV2.js";
import { issue, type H3Issue } from "./validation/types.js";

export type AdapterDialectCapability = {
  adapter_id: string;
  renderer: "h3-grammar" | "plain-prompt";
  label_dialect: "picture" | "none";
  /** Digest of the loaded adapter profile body, excluding its runtime root. */
  source_digest: string;
};

declare const adapterDialectCapabilityBrand: unique symbol;
type TrustedAdapterDialectCapability = AdapterDialectCapability & {
  readonly [adapterDialectCapabilityBrand]: true;
};
const trustedAdapterDialectCapabilities = new WeakSet<object>();
const adapterDialectSnapshots = new WeakMap<object, string>();

export type RendererDialectCapability = AdapterDialectCapability;

export const ADAPTER_DIALECT_PROFILE_CODE = "VPD-R002";

/** Explicit compatibility-only dialect registry for hand-built unit fixtures. */
const FIXTURE_DIALECT_REGISTRY = new Map<string, AdapterDialectCapability>([
  ["fixture-adapter:minimax-h3", {
    adapter_id: "fixture-adapter",
    renderer: "h3-grammar",
    label_dialect: "picture",
    source_digest: adapterDialectProfileDigest({
      adapter_id: "fixture-adapter",
      renderer: "h3-grammar",
      label_dialect: "picture"
    })
  }]
]);

export function adapterDialectProfileDigest(
  profile: Omit<AdapterDialectCapability, "source_digest">
): string {
  return sha256Canonical(profile);
}

/** Load the capability from the selected adapter profile; there is no core adapter registry. */
export async function loadAdapterDialectCapability(
  adapterId: string,
  adapterDirs: readonly string[] = ["adapters"]
): Promise<
  | { ok: true; capability: AdapterDialectCapability; source: "adapter-profile" }
  | { ok: false; code: string; message: string }
> {
  let adapter;
  try {
    adapter = await loadAdapterDefinition(adapterId, [...adapterDirs]);
  } catch {
    return { ok: false, code: ADAPTER_DIALECT_PROFILE_CODE, message: "selected adapter profile is unavailable" };
  }
  if (!adapter.prompt_capability) {
    return { ok: false, code: ADAPTER_DIALECT_PROFILE_CODE, message: "selected adapter profile has no prompt capability" };
  }
  const profile = {
    adapter_id: adapter.name,
    renderer: adapter.prompt_capability.renderer,
    label_dialect: adapter.prompt_capability.label_dialect
  } as const;
  const sourceBody = { ...adapter } as Record<string, unknown>;
  delete sourceBody.root;
  return {
    ok: true,
    source: "adapter-profile",
    capability: (() => {
      const capability = deepFreeze({ ...profile, source_digest: sha256Canonical(sourceBody) }) as TrustedAdapterDialectCapability;
      trustedAdapterDialectCapabilities.add(capability);
      adapterDialectSnapshots.set(capability, sha256Canonical(capability));
      return capability;
    })()
  };
}

export function resolveRendererDialectCapability(input: {
  route: RouteIdentityV1;
  model_profile?: ModelPromptProfile;
  connection_profile?: ConnectionCapabilityProfile;
  adapter_dialect_capability?: AdapterDialectCapability;
}): RendererDialectCapability | undefined {
  const capability = input.adapter_dialect_capability;
  if (capability) {
    const { source_digest: _sourceDigest, ...profile } = capability;
    if (!trustedAdapterDialectCapabilities.has(capability as object)
      || profile.adapter_id !== input.route.adapter_id
      || !/^[a-f0-9]{64}$/.test(capability.source_digest)) return undefined;
    if (!snapshotMatches(capability)) return undefined;
    if (profile.renderer === "h3-grammar" && profile.label_dialect !== "picture") return undefined;
    if (profile.renderer === "plain-prompt" && profile.label_dialect !== "none") return undefined;
    return capability;
  }
  // Compatibility fixtures are deliberately confined to manual fixture routes;
  // production routes must carry a loaded adapter profile.
  if (!input.model_profile && !input.connection_profile) {
    return FIXTURE_DIALECT_REGISTRY.get(`${input.route.adapter_id}:${input.route.ir_model}`);
  }
  return undefined;
}

export type AdapterLabel = {
  asset_id: string;
  type: "image" | "video" | "audio";
  canonical: string;
  adapter: string;
};

export type AdapterLabelMap = {
  assets: AdapterLabel[];
  subjects: Array<{ subject_id: string; canonical: string }>;
  digest: string;
};

export type AdapterDialectResult = {
  canonical_prompt: string;
  adapter_prompt: string;
  labels: AdapterLabelMap;
  issues: H3Issue[];
};

export function buildAdapterLabelMap(ir: VideoPromptIrV2): AdapterLabelMap {
  const counts = { image: 0, video: 0, audio: 0 };
  const assets = ir.assets.map((asset) => {
    counts[asset.type] += 1;
    const index = counts[asset.type];
    const title = asset.type === "image" ? "Picture" : asset.type === "video" ? "Video" : "Audio";
    const prefix = asset.type === "image" ? "image" : asset.type === "video" ? "video" : "audio";
    return {
      asset_id: asset.id,
      type: asset.type,
      canonical: `<${title} ${index}>`,
      adapter: `@${prefix}${index}`
    };
  });
  const subjects = ir.subjects.map((subject, index) => ({
    subject_id: subject.id,
    canonical: `<Subject ${index + 1}>`
  }));
  const withoutDigest = { assets, subjects };
  return { ...withoutDigest, digest: sha256Canonical(withoutDigest) };
}

export function compileAdapterDialect(
  ir: VideoPromptIrV2,
  canonicalPrompt: string,
  capability?: AdapterDialectCapability
): AdapterDialectResult {
  const labels = buildAdapterLabelMap(ir);
  const issues: H3Issue[] = [];
  if (!capability) {
    issues.push(issue("VPD-R002", "adapter dialect requires a loaded digest-bound adapter profile", "error", ["route", "adapter_id"]));
    return { canonical_prompt: canonicalPrompt, adapter_prompt: canonicalPrompt, labels, issues };
  }
  if (capability.label_dialect === "none") {
    if (/<(?:Picture|Video|Audio|Subject) \d+>/.test(canonicalPrompt)) {
      issues.push(issue("VPD-R002", "generic adapter prompt cannot contain H3 canonical labels", "error", ["adapter_prompt"]));
    }
    return { canonical_prompt: canonicalPrompt, adapter_prompt: canonicalPrompt, labels, issues };
  }
  for (const label of labels.assets) {
    const escaped = escapeRegExp(label.canonical);
    const occurrences = canonicalPrompt.match(new RegExp(escaped, "g"))?.length ?? 0;
    if (occurrences === 0 && canonicalPrompt.includes(label.asset_id)) {
      issues.push(issue("VPD-R001", `asset '${label.asset_id}' is mentioned without its canonical label`, "error", ["assets", label.asset_id]));
    }
  }
  const protectedRanges = exactTextRanges(canonicalPrompt);
  const adapterPrompt = mapCanonicalLabels(canonicalPrompt, labels.assets, protectedRanges, (label) => {
    issues.push(issue("VPD-X001", `exact text contains canonical media label '${label.canonical}' and cannot be adapter-rewritten`, "error", ["prompt", "exact_text"]));
  });
  const unresolvedCanonical = adapterPrompt.match(/<(?:Picture|Video|Audio) \d+>/g);
  if (unresolvedCanonical && unresolvedCanonical.length > 0) {
    issues.push(issue("VPD-R001", "adapter dialect contains an unresolved canonical media label", "error", ["adapter_prompt"]));
  }
  return { canonical_prompt: canonicalPrompt, adapter_prompt: adapterPrompt, labels, issues };
}

export function validateAdapterDialect(
  canonicalPrompt: string,
  adapterPrompt: string,
  labels: AdapterLabelMap,
  capability?: AdapterDialectCapability
): H3Issue[] {
  const issues: H3Issue[] = [];
  if (!capability) return [issue("VPD-R002", "adapter dialect requires a loaded digest-bound adapter profile", "error", ["route", "adapter_id"])] ;
  if (capability.label_dialect === "none") {
    if (canonicalPrompt !== adapterPrompt || /<(?:Picture|Video|Audio|Subject) \d+>/.test(adapterPrompt)) {
      issues.push(issue("VPD-R001", "generic adapter prompt is not a provider-neutral serialization", "error", ["adapter_prompt"]));
    }
    if (sha256Canonical({ assets: labels.assets, subjects: labels.subjects }) !== labels.digest) issues.push(issue("VPD-R001", "adapter label map digest is stale", "error", ["labels"]));
    return issues;
  }
  const expectedAdapter = mapCanonicalLabels(canonicalPrompt, labels.assets, exactTextRanges(canonicalPrompt));
  if (expectedAdapter !== adapterPrompt) issues.push(issue("VPD-R001", "adapter prompt does not match the canonical label dialect mapping", "error", ["adapter_prompt"]));
  if (/<(?:Picture|Video|Audio) \d+>/.test(adapterPrompt)) issues.push(issue("VPD-R001", "adapter prompt contains an unresolved canonical media label", "error", ["adapter_prompt"]));
  if (sha256Canonical({ assets: labels.assets, subjects: labels.subjects }) !== labels.digest) issues.push(issue("VPD-R001", "adapter label map digest is stale", "error", ["labels"]));
  return issues;
}

function mapCanonicalLabels(
  prompt: string,
  labels: readonly AdapterLabel[],
  protectedRanges: readonly { start: number; end: number }[],
  onProtected?: (label: AdapterLabel) => void
): string {
  const byCanonical = new Map(labels.map((label) => [label.canonical, label]));
  const pattern = labels.length === 0
    ? undefined
    : new RegExp(labels.map((label) => escapeRegExp(label.canonical)).join("|"), "g");
  if (!pattern) return prompt;
  return prompt.replace(pattern, (match, offset: number) => {
    const label = byCanonical.get(match);
    if (!label) return match;
    if (protectedRanges.some((range) => offset >= range.start && offset < range.end)) {
      onProtected?.(label);
      return match;
    }
    return label.adapter;
  });
}

function exactTextRanges(prompt: string): Array<{ start: number; end: number }> {
  return Array.from(prompt.matchAll(/<d>[\s\S]*?<\/d>/g), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotMatches(value: object): boolean {
  try {
    return adapterDialectSnapshots.get(value) === sha256Canonical(value);
  } catch {
    return false;
  }
}
