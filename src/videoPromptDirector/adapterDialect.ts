import { sha256Canonical } from "../integrity/canonical.js";
import type { VideoPromptIrV2 } from "./schemaV2.js";
import { issue, type H3Issue } from "./validation/types.js";

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
  canonicalPrompt: string
): AdapterDialectResult {
  const labels = buildAdapterLabelMap(ir);
  const issues: H3Issue[] = [];
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
  labels: AdapterLabelMap
): H3Issue[] {
  const issues: H3Issue[] = [];
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
