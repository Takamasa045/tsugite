/**
 * H3 grammar shared pieces (section orders, Picture alignment, label build).
 * Neutral helpers live in neutralHelpers.ts so plain-prompt need not import this file.
 */
import type { H3CreativeIr, H3Shot } from "../schema.js";
import { mapH3AssetLabels, type H3LabelMap } from "../assetLabels.js";
import {
  formatCutTimestamp,
  renderCameraSentence,
  renderDialogueBlock
} from "./neutralHelpers.js";

export {
  formatCutTimestamp,
  renderCameraSentence,
  renderDialogueBlock,
  resolveSpeakerId
} from "./neutralHelpers.js";

export const BASE_SECTION_ORDER = [
  "integrated_multimodal_description",
  "overall_soundscape",
  "non_diegetic_music"
] as const;

export const REFERENCE_SECTION_ORDER = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music"
] as const;

export type H3BaseSection = (typeof BASE_SECTION_ORDER)[number];
export type H3ReferenceSection = (typeof REFERENCE_SECTION_ORDER)[number];

export type H3RenderResult = {
  format: "base" | "reference";
  sections: Record<string, string>;
  text: string;
  labels: H3LabelMap;
};

export function renderMusicSection(ir: H3CreativeIr): string {
  if (!ir.sound.music.enabled) return "N/A";
  return ir.sound.music.description ?? "N/A";
}

export function renderSoundscapeSection(ir: H3CreativeIr): string {
  return ir.sound.soundscape;
}

/**
 * Build shot prose while preserving dialogue / lyrics / on-screen text byte-for-byte.
 * Generated English framing/visual prose may be lightly normalized; locked payloads may not.
 */
export function renderShotBody(shot: H3Shot, ir: H3CreativeIr): string {
  const parts: string[] = [normalizeVisualProse(shot.visual)];
  if (shot.camera) parts.push(renderCameraSentence(shot.camera));
  if (shot.dialogue) parts.push(renderDialogueBlock(shot.dialogue, ir.subjects));
  // Do not trim/rewrite on_screen_text or lyrics — including leading/trailing spaces and newlines.
  if (shot.on_screen_text !== undefined) parts.push(`On-screen text: ${shot.on_screen_text}`);
  if (shot.lyrics !== undefined) parts.push(`Lyrics: ${shot.lyrics}`);
  // Join segments only; never apply global trim or whitespace rewriting to the combined body.
  return parts.join(" ");
}

export function renderShotLine(shot: H3Shot, index: number, ir: H3CreativeIr): string {
  const number = index + 1;
  const body = renderShotBody(shot, ir);
  if (number === 1) {
    return `[Shot 1] ${body}`;
  }
  const stamp = formatCutTimestamp(shot.start_ms);
  const transition = shot.transition === "cut" || shot.transition === undefined
    ? `At ${stamp}, the camera cuts to`
    : `At ${stamp},`;
  // Avoid double-stating "the camera cuts" when the body already starts that way.
  if (/^the camera cuts/i.test(body)) {
    return `[Shot ${number}] At ${stamp}, ${body}`;
  }
  if (shot.transition === "none") {
    return `[Shot ${number}] At ${stamp}, ${body}`;
  }
  // Prefer the body's own opening when it already contains framing; otherwise prefix cut phrase.
  if (/^(a |an |the |live-action|close-up|medium|wide)/i.test(body)) {
    return `[Shot ${number}] At ${stamp}, the camera cuts to ${decapitalize(body)}`;
  }
  return `[Shot ${number}] ${transition} ${body}`;
}

export function renderIntegratedDescription(ir: H3CreativeIr): string {
  return ir.shots.map((shot, index) => renderShotLine(shot, index, ir)).join("\n\n");
}

/**
 * Official H3 picture alignment prose (FL2VA / L2VA).
 * End mark uses target.duration with two decimal places; shot index is 1-based.
 */
export function formatAlignmentSeconds(durationSeconds: number): string {
  return durationSeconds.toFixed(2);
}

export function renderFirstFrameAlignment(ir: H3CreativeIr, labels: H3LabelMap): string | undefined {
  if (ir.target.mode === "first-frame") {
    const first = ir.assets.find((asset) => asset.role === "first_frame");
    if (!first) return undefined;
    const picture = labels.assets[first.id]?.h3 ?? "<Picture 1>";
    return [
      "For the target video, at 0.00 seconds into the target video,",
      `${picture} (from [Shot 1]) is fully referenced.`
    ].join("\n");
  }

  if (ir.target.mode === "first-last") {
    const first = ir.assets.find((asset) => asset.role === "first_frame");
    const last = ir.assets.find((asset) => asset.role === "last_frame");
    if (!first || !last) return undefined;
    const firstPicture = labels.assets[first.id]?.h3 ?? "<Picture 1>";
    const lastPicture = labels.assets[last.id]?.h3 ?? "<Picture 2>";
    const lastShot = ir.shots.length;
    const endMark = formatAlignmentSeconds(ir.target.duration);
    return [
      "How the reference pictures align with the target video —",
      `${firstPicture} (from [Shot 1]) aligns with the 0.00-second mark of the target video.`,
      `${lastPicture} (from [Shot ${lastShot}]) aligns with the ${endMark}-second mark of the target video.`
    ].join(" ");
  }

  if (ir.target.mode === "last-frame") {
    const last = ir.assets.find((asset) => asset.role === "last_frame");
    if (!last) return undefined;
    const picture = labels.assets[last.id]?.h3 ?? "<Picture 1>";
    const lastShot = ir.shots.length;
    const endMark = formatAlignmentSeconds(ir.target.duration);
    return [
      "How the reference pictures align with the target video —",
      `${picture} (from [Shot ${lastShot}]) aligns with the ${endMark}-second mark of the target video.`
    ].join(" ");
  }

  return undefined;
}

export function joinSections(order: readonly string[], sections: Record<string, string>): string {
  // Do not trimEnd section bodies — trailing spaces in locked text must survive.
  return order
    .map((key) => `${key}:\n${sections[key] ?? ""}`)
    .join("\n\n");
}

export function buildLabels(ir: H3CreativeIr): H3LabelMap {
  return mapH3AssetLabels(ir);
}

/** Normalize only generated visual framing prose, never locked text payloads. */
function normalizeVisualProse(visual: string): string {
  return visual.trim();
}

function decapitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}
