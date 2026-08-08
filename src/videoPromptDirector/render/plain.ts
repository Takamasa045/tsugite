/**
 * Generic plain-prompt renderer for non-H3 model profiles.
 * Does not import H3 grammar (Picture/FL2VA/L2VA) or H3 Picture label mapping.
 * Imports only neutralHelpers — not shared/h3Grammar (structural isolation).
 */

import type { H3CreativeIr } from "../schema.js";
import type { H3LabelMap } from "../assetLabels.js";
import {
  formatCutTimestamp,
  renderCameraSentence,
  renderDialogueBlock
} from "./neutralHelpers.js";

export type PlainRenderResult = {
  format: "base";
  sections: Record<string, string>;
  text: string;
  labels: H3LabelMap;
};

/**
 * Deterministic plain multi-shot prompt for T2V/I2V planning.
 * Asset roles are described by role name only (neutral labels).
 */
export function renderPlainPrompt(ir: H3CreativeIr): PlainRenderResult {
  const shotLines = ir.shots.map((shot, index) => {
    const number = index + 1;
    const parts: string[] = [shot.visual.trim()];
    if (shot.camera) parts.push(renderCameraSentence(shot.camera));
    if (shot.dialogue) parts.push(renderDialogueBlock(shot.dialogue, ir.subjects));
    if (shot.on_screen_text !== undefined) parts.push(`On-screen text: ${shot.on_screen_text}`);
    if (shot.lyrics !== undefined) parts.push(`Lyrics: ${shot.lyrics}`);
    const body = parts.join(" ");
    if (number === 1) return `[Shot 1] ${body}`;
    return `[Shot ${number}] At ${formatCutTimestamp(shot.start_ms)}, ${body}`;
  });

  const assetLines = ir.assets.map((asset) => {
    return `- role=${asset.role} type=${asset.type} path=${asset.path}`;
  });

  // Neutral labels only — no Picture/Video/Audio H3 dialect.
  const labels: H3LabelMap = {
    assets: {},
    subjects: {},
    byType: { image: [], video: [], audio: [] },
    orderedAssets: [],
    orderedSubjects: []
  };
  for (const [index, asset] of ir.assets.entries()) {
    const n = index + 1;
    const entry = {
      assetId: asset.id,
      type: asset.type,
      index: n,
      h3: `asset:${asset.role}`,
      adapter: `@${asset.role}${n}`
    };
    labels.assets[asset.id] = entry;
    labels.byType[asset.type].push(entry);
    labels.orderedAssets.push(entry);
  }
  for (const [index, subject] of ir.subjects.entries()) {
    const entry = {
      subjectId: subject.id,
      h3: `subject:${subject.id}`,
      index: index + 1
    };
    labels.subjects[subject.id] = entry;
    labels.orderedSubjects.push(entry);
  }

  const sections: Record<string, string> = {
    model: ir.target.model,
    mode: ir.target.mode,
    duration: String(ir.target.duration),
    quality: ir.target.quality,
    aspect: ir.target.aspect,
    shots: shotLines.join("\n\n"),
    assets: assetLines.length > 0 ? assetLines.join("\n") : "none",
    soundscape: ir.sound.soundscape,
    music: ir.sound.music.enabled ? (ir.sound.music.description ?? "enabled") : "N/A"
  };

  const text = [
    `model: ${sections.model}`,
    `mode: ${sections.mode}`,
    `duration: ${sections.duration}`,
    `quality: ${sections.quality}`,
    `aspect: ${sections.aspect}`,
    "",
    "shots:",
    sections.shots,
    "",
    "assets:",
    sections.assets,
    "",
    "soundscape:",
    sections.soundscape,
    "",
    "music:",
    sections.music
  ].join("\n");

  return {
    format: "base",
    sections,
    text,
    labels
  };
}
