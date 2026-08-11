/**
 * Scene layer helpers: shared location/palette blocks for multi-shot continuity.
 * Engine-neutral — used by schema resolution, render inject, and Auditor.
 */

import type { H3CreativeIr, H3Scene, H3Shot } from "./schema.js";
import { issue, type H3Issue } from "./validation/types.js";

export const SCENE_LOCATION_MAP_MISMATCH_CODE = "scene.location_map_mismatch";
export const SCENE_UNDECLARED_SUBJECT_CODE = "scene.undeclared_subject";

export type { H3Scene };

export function resolveShotScene(
  ir: H3CreativeIr,
  shot: H3Shot
): H3Scene | undefined {
  if (!shot.scene) return undefined;
  const scenes = ir.scenes ?? [];
  return scenes.find((scene) => scene.id === shot.scene);
}

/** Verbatim LOCATION block label + text (no trim / normalize). */
export function formatSceneLocationBlock(locationMap: string): string {
  return `LOCATION MAP:\n${locationMap}`;
}

/** Verbatim LIGHTING block from scene palette. */
export function formatScenePaletteBlock(palette: string): string {
  return `LIGHTING:\n${palette}`;
}

/** Ordered prefix segments to prepend to a shot body. */
export function buildScenePrefixParts(scene: H3Scene): string[] {
  const parts = [formatSceneLocationBlock(scene.location_map)];
  if (scene.palette !== undefined) {
    parts.push(formatScenePaletteBlock(scene.palette));
  }
  return parts;
}

/**
 * Extract the LOCATION MAP block text from a rendered shot body.
 * Expects the block produced by formatSceneLocationBlock (verbatim),
 * optionally followed by space-joined LIGHTING / CHARACTER / visual segments.
 */
export function extractLocationMapBlock(body: string): string | undefined {
  const marker = "LOCATION MAP:\n";
  const start = body.indexOf(marker);
  if (start < 0) return undefined;
  const after = body.slice(start);
  // Stop before the next known injected section or at end.
  const boundary = after.search(/\s(?:LIGHTING:\n|CHARACTER APPEARANCE:\n|CHARACTER MANNER:\n|VOICE:\n)/);
  if (boundary >= 0) {
    return after.slice(0, boundary);
  }
  return after;
}

/**
 * Auditor checks for scenes (renderer-independent).
 * - location_map_mismatch: injected LOCATION MAP missing or inconsistent across shots of same scene
 * - undeclared_subject: dialogue / subject_expectations outside active_subjects (when non-empty)
 */
export function validateScenes(
  ir: H3CreativeIr,
  options: {
    /** Per-shot rendered body strings (same order as ir.shots). When omitted, only IR checks run. */
    shotBodies?: string[];
  } = {}
): H3Issue[] {
  const issues: H3Issue[] = [];
  const scenes = ir.scenes ?? [];
  if (scenes.length === 0) return issues;

  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));

  // undeclared_subject (IR-level)
  for (const [shotIndex, shot] of ir.shots.entries()) {
    if (!shot.scene) continue;
    const scene = sceneById.get(shot.scene);
    if (!scene) continue; // unknown scene is schema error
    if (scene.active_subjects.length === 0) continue;

    const allowed = new Set(scene.active_subjects);
    if (shot.dialogue?.speaker && !allowed.has(shot.dialogue.speaker)) {
      issues.push(
        issue(
          SCENE_UNDECLARED_SUBJECT_CODE,
          `subject '${shot.dialogue.speaker}' is not in scene '${scene.id}' active_subjects`,
          "warning",
          ["shots", shotIndex, "dialogue", "speaker"]
        )
      );
    }
    for (const [expIndex, expectation] of (shot.subject_expectations ?? []).entries()) {
      if (!allowed.has(expectation.subject_id)) {
        issues.push(
          issue(
            SCENE_UNDECLARED_SUBJECT_CODE,
            `subject '${expectation.subject_id}' is not in scene '${scene.id}' active_subjects`,
            "warning",
            ["shots", shotIndex, "subject_expectations", expIndex, "subject_id"]
          )
        );
      }
    }
  }

  // location_map_mismatch — needs rendered bodies
  if (!options.shotBodies) return issues;

  const locationByScene = new Map<string, { block: string; shotIndex: number }>();
  for (const [shotIndex, shot] of ir.shots.entries()) {
    if (!shot.scene) continue;
    const scene = sceneById.get(shot.scene);
    if (!scene) continue;
    const body = options.shotBodies[shotIndex] ?? "";
    const expected = formatSceneLocationBlock(scene.location_map);
    if (!body.includes(expected)) {
      issues.push(
        issue(
          SCENE_LOCATION_MAP_MISMATCH_CODE,
          `shot '${shot.id}' is missing or altered scene '${scene.id}' LOCATION MAP after inject`,
          "warning",
          ["shots", shotIndex, "scene"]
        )
      );
      continue;
    }
    const extracted = extractLocationMapBlock(body) ?? expected;
    const previous = locationByScene.get(scene.id);
    if (previous && previous.block !== extracted) {
      issues.push(
        issue(
          SCENE_LOCATION_MAP_MISMATCH_CODE,
          `scene '${scene.id}' LOCATION MAP differs between shots (index ${previous.shotIndex} vs ${shotIndex})`,
          "warning",
          ["shots", shotIndex, "scene"]
        )
      );
    } else if (!previous) {
      locationByScene.set(scene.id, { block: extracted, shotIndex });
    }
  }

  return issues;
}
