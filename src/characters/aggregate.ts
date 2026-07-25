import type {
  AggregatedCharacter,
  CharacterProvenance,
  CharacterSourceRef
} from "./types.js";

/**
 * Group scanned character sources for gallery display.
 * Selection for "use" must target a concrete sourceKey (+ speaker id), not the merge.
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
 * - local: image-family stem + normalized character label
 *   (e.g. neru-closed / neru.png / ネル先生 / ネル → one card when art family matches)
 * - weak generic image names (neutral.png) fall back to speaker id + label
 *   so unrelated Host/ナレーター cards do not merge.
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
  const stem = primaryImageFamilyStem(source);
  if (!stem || stem === "missing" || isWeakImageStem(stem)) {
    return `local:${source.id}\0${label}`;
  }
  return `local:${stem}\0${label}`;
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
 * Detect storyboard / review / non-portrait assets that were stored as speakers.
 * These must not appear in the character gallery.
 */
export function isReferenceAssetSource(source: CharacterSourceRef): boolean {
  const paths = source.poses.map((pose) => pose.imagePath ?? "");
  if (paths.some((path) => /(^|\/)review\//.test(path) || /\/references\//.test(path))) {
    return true;
  }
  if (source.poses.some((pose) => /^frame[-_]/.test(pose.imageId) || /^frame[-_]/.test(pose.name))) {
    return true;
  }
  const storyboardPose = /^(hook|grow|safe|rules|agents|frame)([-_]|$)/i;
  if (source.poses.length > 0 && source.poses.every((pose) => storyboardPose.test(pose.name))) {
    return true;
  }
  return false;
}

/** Primary pose path basename with mouth/pose suffixes stripped (neru-closed → neru). */
export function primaryImageFamilyStem(source: CharacterSourceRef): string {
  const primary =
    source.poses.find((pose) => pose.name === "neutral" && pose.imagePath && !pose.missing)
    ?? source.poses.find((pose) => Boolean(pose.imagePath) && !pose.missing)
    ?? source.poses.find((pose) => Boolean(pose.imagePath));
  if (!primary?.imagePath) return "missing";
  const file = primary.imagePath.split("/").pop() ?? primary.imagePath;
  const stem = file.replace(/\.[^.]+$/, "").toLowerCase();
  return stripPoseSuffix(stem);
}

function stripPoseSuffix(stem: string): string {
  const stripped = stem
    .replace(/[-_]mouth([-_]?(closed|open|half))?$/i, "")
    .replace(/[-_](closed|open|half|neutral|smile|explain|serious|wave|happy|sad)$/i, "");
  return stripped || stem;
}

function isWeakImageStem(stem: string): boolean {
  return /^(neutral|pose|image|img|speaker|char|character|host|default|portrait|avatar|icon|ref|reference|frame)$/i
    .test(stem);
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
