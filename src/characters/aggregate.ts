import type {
  AggregatedCharacter,
  CharacterProvenance,
  CharacterSourceRef
} from "./types.js";

/**
 * Group scanned character sources for gallery display.
 * Selection for "use" must target a concrete sourceKey (+ speaker id), not the merge.
 * Reference/storyboard speakers are excluded entirely.
 */
export function aggregateCharacters(sources: CharacterSourceRef[]): AggregatedCharacter[] {
  const groups = new Map<string, CharacterSourceRef[]>();

  for (const source of sources) {
    if (isReferenceAssetSource(source)) continue;
    const key = groupKeyFor(source);
    const bucket = groups.get(key);
    if (bucket) bucket.push(source);
    else groups.set(key, [source]);
  }

  const aggregated: AggregatedCharacter[] = [];
  for (const [groupKey, members] of groups) {
    const sorted = [...members].sort(compareSourcesForRepresentative);
    const representative = sorted[0]!;
    aggregated.push({
      groupKey,
      id: representative.id,
      displayName: representative.displayName,
      sources: sorted,
      poseCount: representative.poses.length,
      hasMouthFrames: Boolean(representative.mouthFrames && representative.mouthFrames.length > 0),
      ...(representative.provenance ? { provenance: representative.provenance } : {})
    });
  }

  return aggregated.sort((left, right) => {
    const name = left.displayName.localeCompare(right.displayName);
    if (name !== 0) return name;
    return left.groupKey.localeCompare(right.groupKey);
  });
}

/**
 * Deterministic group key.
 * - provenance: kind+character(+run_id)
 * - local with primary image hash: same portrait bytes + honorific-stripped label
 * - local without hash: speaker id + label (safe fallback; no cross-id merge)
 */
export function groupKeyFor(source: CharacterSourceRef): string {
  const provenance = source.provenance;
  if (provenance && typeof provenance.kind === "string" && provenance.kind.length > 0) {
    const character = stringField(provenance, "character") ?? source.id;
    const runId = stringField(provenance, "run_id");
    if (runId !== undefined) {
      return `${provenance.kind}:${character}\0${runId}`;
    }
    return `${provenance.kind}:${character}\0${source.id}\0${normalizeCharacterLabel(source.displayName)}`;
  }

  const label = normalizeCharacterLabel(source.displayName);
  if (source.primaryImageSha256) {
    return `local:sha:${source.primaryImageSha256}\0${label}`;
  }
  return `local:id:${source.id}\0${label}`;
}

/**
 * Representative order inside a group:
 * poseCount desc → mouth_frames → project over template → newer mtime → path.
 */
export function compareSourcesForRepresentative(
  left: CharacterSourceRef,
  right: CharacterSourceRef
): number {
  const poseDiff = right.poses.length - left.poses.length;
  if (poseDiff !== 0) return poseDiff;

  const mouthDiff = Number(hasMouth(right)) - Number(hasMouth(left));
  if (mouthDiff !== 0) return mouthDiff;

  const kindDiff = kindRank(left.kind) - kindRank(right.kind);
  if (kindDiff !== 0) return kindDiff;

  const mtimeDiff = right.manifestModifiedAtMs - left.manifestModifiedAtMs;
  if (mtimeDiff !== 0) return mtimeDiff;

  const pathDiff = left.manifestPath.localeCompare(right.manifestPath);
  if (pathDiff !== 0) return pathDiff;

  return left.id.localeCompare(right.id);
}

/** NFKC + ひらがな→カタカナ + 空白除去。 */
export function normalizeDisplayName(name: string): string {
  const compact = name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
  return compact.replace(/[\u3041-\u3096]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 0x60)
  );
}

/** 表示名から敬称を除いて正規化（ネル先生 → ネル）。 */
export function normalizeCharacterLabel(name: string): string {
  const withoutHonorific = name
    .normalize("NFKC")
    .trim()
    .replace(/(先生|さん|くん|ちゃん|様|氏)+$/u, "");
  return normalizeDisplayName(withoutHonorific);
}

/**
 * Storyboard / review assets stored as speakers.
 * Must be path/pose-role based — never exclude only because an image id starts with "frame-".
 */
export function isReferenceAssetSource(source: CharacterSourceRef): boolean {
  const paths = source.poses.map((pose) => pose.imagePath ?? "");
  if (paths.some((path) => /(^|\/)review\//.test(path) || /\/references\//.test(path))) {
    return true;
  }
  // All poses are storyboard roles (digest-style speakers), not character portraits.
  const storyboardPose = /^(hook|grow|safe|rules|agents)([-_]|$)/i;
  if (source.poses.length > 0 && source.poses.every((pose) => storyboardPose.test(pose.name))) {
    return true;
  }
  return false;
}

function hasMouth(source: CharacterSourceRef): boolean {
  return Boolean(source.mouthFrames && source.mouthFrames.length > 0);
}

function kindRank(kind: CharacterSourceRef["kind"]): number {
  return kind === "project" ? 0 : 1;
}

function stringField(provenance: CharacterProvenance, key: string): string | undefined {
  const value = provenance[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
