/**
 * Deterministic IR field digests for iteration multi-block lint (Phase E).
 * Block keys are IR paths until skeleton names are universally available.
 */

import { sha256Canonical, sha256Text } from "../integrity/canonical.js";
import type { H3CreativeIr } from "./schema.js";

export type PromptBlockDigests = Record<string, string>;

function digestValue(value: unknown): string {
  if (typeof value === "string") return sha256Text(value);
  return sha256Canonical(value);
}

/**
 * Partition IR into stable block digests for lineage comparison.
 * Includes per-shot fields and shared subjects/sound/scene.
 */
export function collectPromptBlockDigests(ir: H3CreativeIr): PromptBlockDigests {
  const digests: PromptBlockDigests = {};
  digests["subjects"] = digestValue(ir.subjects);
  digests["sound.soundscape"] = digestValue(ir.sound.soundscape);
  digests["sound.music"] = digestValue(ir.sound.music);
  if (ir.creative) digests["creative"] = digestValue(ir.creative);
  if (ir.scenes) digests["scenes"] = digestValue(ir.scenes);
  for (const shot of ir.shots) {
    const prefix = `shot.${shot.id}`;
    digests[`${prefix}.visual`] = digestValue(shot.visual);
    if (shot.camera) digests[`${prefix}.camera`] = digestValue(shot.camera);
    if (shot.dialogue) digests[`${prefix}.dialogue`] = digestValue(shot.dialogue);
    if (shot.scene) digests[`${prefix}.scene`] = digestValue(shot.scene);
    if (shot.cast) digests[`${prefix}.cast`] = digestValue(shot.cast);
    if (shot.composition) digests[`${prefix}.composition`] = digestValue(shot.composition);
    if (shot.on_screen_text !== undefined) {
      digests[`${prefix}.on_screen_text`] = digestValue(shot.on_screen_text);
    }
    if (shot.lyrics !== undefined) digests[`${prefix}.lyrics`] = digestValue(shot.lyrics);
  }
  return digests;
}

/** Count keys whose digests differ between previous and current (union of keys). */
export function countChangedBlocks(
  previous: PromptBlockDigests,
  current: PromptBlockDigests
): number {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  let changed = 0;
  for (const key of keys) {
    if (previous[key] !== current[key]) changed += 1;
  }
  return changed;
}
