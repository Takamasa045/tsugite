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

/** Deterministic group key: provenance identity when present, else local id+displayName. */
export function groupKeyFor(source: CharacterSourceRef): string {
  const provenance = source.provenance;
  if (provenance && typeof provenance.kind === "string" && provenance.kind.length > 0) {
    const character = stringField(provenance, "character") ?? source.id;
    const runId = stringField(provenance, "run_id");
    if (runId !== undefined) {
      return `${provenance.kind}:${character}\0${runId}`;
    }
    return `${provenance.kind}:${character}\0${source.id}\0${source.displayName}`;
  }
  return `local:${source.id}\0${source.displayName}`;
}

/**
 * Representative order inside a group:
 * poseCount desc → mouth_frames present → project over template → newer mtime → manifestPath.
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
