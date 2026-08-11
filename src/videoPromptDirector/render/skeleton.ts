/**
 * Opt-in skeleton renderer for plain-prompt profiles that declare prompt_skeleton.
 * Maps IR fields into a fixed advisory block order without paraphrasing locked text.
 */

import type { ModelPromptProfile } from "../modelProfile.js";
import type { H3CreativeIr } from "../schema.js";
import {
  buildScenePrefixParts,
  resolveShotScene
} from "../scenes.js";
import {
  formatCutTimestamp,
  renderCameraSentence,
  renderDialogueBlock,
  renderShotActingLocks
} from "./neutralHelpers.js";
import type { H3LabelMap } from "../assetLabels.js";
import type { H3RenderResult } from "./shared.js";

/** Default longform-story-v1 order (matches knowledge/prompt-skeletons). */
export const DEFAULT_SKELETON_BLOCKS = [
  "SCENE_CONTEXT",
  "ACTIVE_REFERENCES",
  "LOCATION_MAP",
  "FIRST_FRAME_BLOCKING",
  "OPTICS",
  "CAMERA",
  "ACTION_TIMING",
  "PHYSICS",
  "LIGHTING",
  "AUDIO",
  "CHARACTER_ACTING",
  "STYLE",
  "QUALITY",
  "POSITIVE_CONSTRAINTS"
] as const;

export type SkeletonBlockId = (typeof DEFAULT_SKELETON_BLOCKS)[number] | string;

export function resolveSkeletonBlockOrder(
  profile: Pick<ModelPromptProfile, "prompt_skeleton">
): string[] {
  const declared = profile.prompt_skeleton?.blocks;
  if (declared && declared.length > 0) return [...declared];
  return [...DEFAULT_SKELETON_BLOCKS];
}

function emptyLabels(): H3LabelMap {
  return {
    assets: {},
    subjects: {},
    byType: { image: [], video: [], audio: [] },
    orderedAssets: [],
    orderedSubjects: []
  };
}

function buildBlockContent(ir: H3CreativeIr): Record<string, string> {
  const sceneLines: string[] = [];
  const locationLines: string[] = [];
  const lightingLines: string[] = [];
  const cameraLines: string[] = [];
  const actionLines: string[] = [];
  const audioLines: string[] = [];
  const actingLines: string[] = [];

  for (const [index, shot] of ir.shots.entries()) {
    const n = index + 1;
    const scene = resolveShotScene(ir, shot);
    if (scene) {
      sceneLines.push(`[Shot ${n}] scene=${scene.id}`);
      for (const part of buildScenePrefixParts(scene)) {
        if (part.startsWith("LOCATION MAP:")) {
          locationLines.push(`[Shot ${n}]\n${part}`);
        } else if (part.startsWith("LIGHTING:")) {
          lightingLines.push(`[Shot ${n}]\n${part}`);
        }
      }
    }
    actionLines.push(
      n === 1
        ? `[Shot 1] ${shot.visual}`
        : `[Shot ${n}] At ${formatCutTimestamp(shot.start_ms)}, ${shot.visual}`
    );
    if (shot.camera) {
      cameraLines.push(`[Shot ${n}] ${renderCameraSentence(shot.camera)}`);
    }
    if (shot.dialogue) {
      audioLines.push(renderDialogueBlock(shot.dialogue, ir.subjects));
    }
    actingLines.push(...renderShotActingLocks(shot, ir.subjects));
  }

  const assetLines = ir.assets.map(
    (asset) => `- role=${asset.role} type=${asset.type} path=${asset.path}`
  );

  const blocks: Record<string, string> = {
    SCENE_CONTEXT: sceneLines.join("\n\n") || ir.creative?.intent || "N/A",
    ACTIVE_REFERENCES: assetLines.length > 0 ? assetLines.join("\n") : "none",
    LOCATION_MAP: locationLines.join("\n\n") || "N/A",
    FIRST_FRAME_BLOCKING:
      ir.target.mode === "first-frame" || ir.target.mode === "first-last"
        ? `mode=${ir.target.mode}; first/last frames as bound assets`
        : "N/A",
    OPTICS: "N/A",
    CAMERA: cameraLines.join("\n") || "N/A",
    ACTION_TIMING: actionLines.join("\n\n"),
    PHYSICS: "N/A",
    LIGHTING:
      lightingLines.join("\n\n")
      || ir.creative?.style?.lighting
      || "N/A",
    AUDIO: [
      ir.sound.soundscape,
      ...audioLines,
      ir.sound.music.enabled
        ? (ir.sound.music.description ?? "music enabled")
        : "music N/A"
    ]
      .filter(Boolean)
      .join("\n\n"),
    CHARACTER_ACTING: actingLines.join("\n") || "N/A",
    STYLE: [
      ir.creative?.style?.medium,
      ir.creative?.style?.tone,
      ...(ir.creative?.style?.palette ?? [])
    ]
      .filter(Boolean)
      .join("; ") || "N/A",
    QUALITY: ir.target.quality,
    POSITIVE_CONSTRAINTS: (ir.creative?.must_include ?? []).join("; ") || "N/A"
  };
  return blocks;
}

/**
 * Emit skeleton-ordered sections. Empty/"N/A" blocks are still emitted for stable order.
 */
export function renderSkeletonPrompt(
  ir: H3CreativeIr,
  profile: Pick<ModelPromptProfile, "prompt_skeleton" | "renderer" | "id">
): H3RenderResult {
  const order = resolveSkeletonBlockOrder(profile);
  const content = buildBlockContent(ir);
  const sections: Record<string, string> = {};
  const lines: string[] = [
    `model: ${ir.target.model}`,
    `mode: ${ir.target.mode}`,
    `duration: ${ir.target.duration}`,
    `skeleton: ${profile.prompt_skeleton?.id ?? "custom"}`,
    ""
  ];
  for (const blockId of order) {
    const body = content[blockId] ?? "N/A";
    sections[blockId] = body;
    lines.push(`${blockId}:`);
    lines.push(body);
    lines.push("");
  }
  return {
    format: "base",
    sections,
    text: lines.join("\n").replace(/\n+$/, "\n"),
    labels: emptyLabels()
  };
}
