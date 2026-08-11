import { Buffer } from "node:buffer";
import { sha256Canonical, sha256Text } from "../integrity/canonical.js";
import type { H3Issue } from "./validation/types.js";
import { issue } from "./validation/types.js";
import { buildAdapterLabelMap, type AdapterLabelMap } from "./adapterDialect.js";
import type {
  ShotV2,
  VideoPromptIrV2,
  VocalEventV2,
  VisibleTextEventV2
} from "./schemaV2.js";

export type SemanticBlockKind =
  | "MODE_ALIGNMENT"
  | "SCENE_CONTEXT"
  | "ACTIVE_REFERENCES"
  | "LOCATION_MAP"
  | "FIRST_FRAME_BLOCKING"
  | "OPTICS"
  | "CAMERA"
  | "ACTION_TIMING"
  | "PHYSICS"
  | "LIGHTING"
  | "AUDIO_EVENTS"
  | "CHARACTER_ACTING"
  | "VISIBLE_TEXT"
  | "STYLE"
  | "QUALITY"
  | "POSITIVE_CONSTRAINTS";

export type SemanticPromptBlock = {
  block_id: string;
  kind: SemanticBlockKind;
  source_paths: string[];
  text: string;
  digest: string;
  exact_text_digests: string[];
};

/** Fully materialized canonical serializer input. The renderer never re-walks IR. */
export type SemanticPromptAst = {
  format: "base" | "reference";
  mode: VideoPromptIrV2["target"]["mode"];
  duration_ms: number;
  sections: {
    integrated_multimodal_description: string;
    subject_definitions?: string;
    summary?: string;
    retention_analysis?: string;
    overall_soundscape: string;
    non_diegetic_music: string;
  };
  labels: AdapterLabelMap;
  blocks: SemanticPromptBlock[];
  must_include: string[];
  prohibited: string[];
};

export type LyricsCueSource = {
  cue_id: string;
  occurrence_id: string;
  timing: "timed" | "untimed";
  lyrics_contract_digest: string;
  source_span: {
    start_utf8_byte: number;
    end_utf8_byte: number;
    text_digest: string;
  };
};

export type LyricsSource = {
  canonical_text: string;
  text_digest: string;
  cues: LyricsCueSource[];
};

export type SemanticBlockOptions = {
  lyrics_source?: LyricsSource;
  require_exact_sync?: boolean;
  grammar_reserved_tokens?: readonly string[];
};

export const DEFAULT_RESERVED_EXACT_TEXT_TOKENS = [
  "</d>",
  "<scenetrans>",
  "<cutoff>",
  "<Picture ",
  "<Video ",
  "<Audio ",
  "<Subject ",
  "integrated_multimodal_description:",
  "overall_soundscape:",
  "non_diegetic_music:",
  "subject_definitions:",
  "summary:",
  "retention_analysis:",
  "detailed_description:"
] as const;

export type SemanticBlockResult = {
  blocks: SemanticPromptBlock[];
  issues: H3Issue[];
  resolved_text: Map<string, string>;
  ast: SemanticPromptAst;
};

export function buildSemanticBlocks(
  ir: VideoPromptIrV2,
  options: SemanticBlockOptions = {}
): SemanticBlockResult {
  const issues: H3Issue[] = [];
  const resolvedText = new Map<string, string>();
  const blocks: SemanticPromptBlock[] = [];
  const labels = new Map(ir.assets.map((asset, index) => [asset.id, assetLabel(asset.type, index, ir.assets.slice(0, index))]));
  const reservedTokens = [
    ...(options.grammar_reserved_tokens ?? DEFAULT_RESERVED_EXACT_TEXT_TOKENS),
    ...ir.assets.map((asset, index) => assetLabel(asset.type, index, ir.assets.slice(0, index)))
  ];

  const push = (
    blockId: string,
    kind: SemanticBlockKind,
    sourcePaths: string[],
    text: string,
    exactTextDigests: string[] = []
  ) => {
    blocks.push({
      block_id: blockId,
      kind,
      source_paths: sourcePaths,
      text,
      digest: sha256Text(text),
      exact_text_digests: exactTextDigests
    });
  };

  const modeAlignment = alignmentText(ir);
  if (modeAlignment) push("mode-alignment", "MODE_ALIGNMENT", ["target.mode", "target.duration_ms"], modeAlignment);

  for (const [subjectIndex, subject] of ir.subjects.entries()) {
    for (const field of ["voice", "appearance", "manner"] as const) {
      const locked = subject.locked_blocks?.[field];
      if (!locked) continue;
      const path = `subjects.${subjectIndex}.locked_blocks.${field}`;
      issues.push(...validateExactText(locked.text, locked.sha256, `${path}.text`, reservedTokens));
      push(`subject-${subject.id}-${field}`, "CHARACTER_ACTING", [path], `${field.toUpperCase()} (locked):\n${locked.text}`, [locked.sha256]);
    }
  }

  for (const [shotIndex, shot] of ir.shots.entries()) {
    const prefix = `shot-${shot.id}`;
    const scene = shot.scene_id ? ir.scenes.find((item) => item.id === shot.scene_id) : undefined;
    if (scene) {
      push(`${prefix}-scene`, "SCENE_CONTEXT", [`shots.${shotIndex}.scene_id`, `scenes.${ir.scenes.indexOf(scene)}`], sceneContext(scene));
      push(`${prefix}-location`, "LOCATION_MAP", [`scenes.${ir.scenes.indexOf(scene)}.location_map`], `LOCATION MAP:\n${scene.location_map}`);
      if (scene.palette !== undefined) {
        push(`${prefix}-lighting`, "LIGHTING", [`scenes.${ir.scenes.indexOf(scene)}.palette`], `LIGHTING:\n${scene.palette}`);
      }
    }

    const refs = shot.cast.map((entry) => `<Subject ${subjectIndex(ir, entry.subject_id)}> `
      + (entry.variant_id ? `variant=${entry.variant_id}` : "")).join("\n");
    if (refs) push(`${prefix}-references`, "ACTIVE_REFERENCES", [`shots.${shotIndex}.cast`], refs);

    const action = shot.action_beats.map((beat) => {
      const at = beat.at_ms === undefined ? "" : ` at ${formatSeconds(beat.at_ms)}s`;
      return `Action${at}: ${beat.description}`;
    }).join("\n");
    if (action) push(`${prefix}-action`, "ACTION_TIMING", [`shots.${shotIndex}.action_beats`], action);

    if (shot.camera) {
      push(`${prefix}-camera`, "CAMERA", [`shots.${shotIndex}.camera`], cameraText(shot.camera));
      if (shot.camera.optics) push(`${prefix}-optics`, "OPTICS", [`shots.${shotIndex}.camera.optics`], opticsText(shot.camera.optics));
    }

    const vocalLines: string[] = [];
    const exactDigests: string[] = [];
    for (const [eventIndex, event] of shot.vocal_events.entries()) {
      const resolved = resolveVocalEventText(event, ir, options, `shots.${shotIndex}.vocal_events.${eventIndex}`);
      issues.push(...resolved.issues);
      if (resolved.text !== undefined) {
        resolvedText.set(event.id, resolved.text);
        exactDigests.push(sha256Text(resolved.text));
        const timing = event.start_ms === undefined ? "" : ` ${formatSeconds(event.start_ms)}-${formatSeconds(event.end_ms!)}s`;
        const control = event.continuity === "continues-out" ? " <scenetrans>" : event.continuity === "cutoff" ? " <cutoff>" : "";
        vocalLines.push(`${event.kind}${timing} (${event.speaker_ids.join(", ")}) [${event.language_id}]: <d>[${event.language_id}]${resolved.text}</d>${control}`);
      }
    }
    if (vocalLines.length > 0) push(`${prefix}-audio-events`, "AUDIO_EVENTS", [`shots.${shotIndex}.vocal_events`], vocalLines.join("\n"), exactDigests);

    const visibleModelText: string[] = [];
    const visibleDigests: string[] = [];
    for (const [eventIndex, event] of shot.visible_text_events.entries()) {
      issues.push(...validateVisibleText(event, `shots.${shotIndex}.visible_text_events.${eventIndex}`, reservedTokens));
      if (event.render_target === "model") {
        visibleModelText.push(`On-screen text: ${event.text}`);
        visibleDigests.push(event.text_digest);
      }
    }
    if (visibleModelText.length > 0) push(`${prefix}-visible-text`, "VISIBLE_TEXT", [`shots.${shotIndex}.visible_text_events`], visibleModelText.join("\n"), visibleDigests);

    if (shot.constraints.positive.length > 0) {
      push(`${prefix}-positive`, "POSITIVE_CONSTRAINTS", [`shots.${shotIndex}.constraints.positive`], shot.constraints.positive.join("\n"));
    }

    // Keep a deterministic label-binding block so every referenced asset is in lineage.
    const assetRefs = ir.assets.map((asset) => `${labels.get(asset.id) ?? asset.id}=${asset.id}`).join("\n");
    if (assetRefs) push(`${prefix}-asset-labels`, "ACTIVE_REFERENCES", [`assets`], assetRefs);
  }

  if (ir.creative.style) {
    const style = [ir.creative.style.medium, ir.creative.style.tone, ir.creative.style.lighting, ...(ir.creative.style.palette ?? [])]
      .filter((value): value is string => Boolean(value)).join("; ");
    if (style) push("style", "STYLE", ["creative.style"], style);
  }
  if (ir.creative.must_include.length > 0) push("must-include", "POSITIVE_CONSTRAINTS", ["creative.must_include"], ir.creative.must_include.join("\n"));
  if (ir.target.quality) push("quality", "QUALITY", ["target.quality"], ir.target.quality);

  const adapterLabels = buildAdapterLabelMap(ir);
  const shotTexts = ir.shots.map((shot, shotIndex) => {
    const prefix = `shots.${shotIndex}`;
    const identityText = shot.cast.flatMap((cast) => blocks
      .filter((block) => block.block_id.startsWith(`subject-${cast.subject_id}-`))
      .map((block) => block.text)).join(" ");
    const text = [blocks
      .filter((block) => block.source_paths.some((path) => path === prefix || path.startsWith(`${prefix}.`)))
      .filter((block) => !block.block_id.endsWith("-asset-labels"))
      .map((block) => block.text)
      .join(" "), identityText].filter(Boolean).join(" ");
    return shotIndex === 0
      ? `[Shot 1] ${text}`
      : `[Shot ${shotIndex + 1}] At ${formatTimestamp(shot.start_ms)}, the camera cuts to ${decapitalize(text)}`;
  });
  const alignment = blocks.find((block) => block.block_id === "mode-alignment")?.text;
  const globalText = blocks
    .filter((block) => ["style", "quality", "must-include"].includes(block.block_id))
    .map((block) => block.text)
    .join("\n");
  const integrated = [alignment, shotTexts.join("\n\n"), globalText].filter(Boolean).join("\n\n");
  const subjectDefinitions = ir.subjects.map((subject, index) => {
    const lines = [`<Subject ${index + 1}> is the ${subject.description}.`];
    for (const field of ["voice", "appearance", "manner"] as const) {
      const locked = subject.locked_blocks?.[field];
      if (locked) lines.push(`${field.toUpperCase()}:\n${locked.text}`);
    }
    return lines.join("\n");
  }).join("\n");
  const retention = ir.subjects.length === 0
    ? "Retain referenced subject appearance, clothing, and spatial relationships across the clip."
    : ir.subjects.map((subject, index) => {
      const preservation = subject.preservation;
      const value = preservation
        ? [preservation.identity ? `identity=${preservation.identity}` : undefined, preservation.clothing ? `clothing=${preservation.clothing}` : undefined, preservation.hairstyle ? `hairstyle=${preservation.hairstyle}` : undefined].filter(Boolean).join(", ")
        : "identity and clothing remain consistent";
      return `Retain <Subject ${index + 1}> (${value}).`;
    }).join(" ");
  const ast: SemanticPromptAst = {
    format: ir.target.mode === "reference" ? "reference" : "base",
    mode: ir.target.mode,
    duration_ms: ir.target.duration_ms,
    sections: {
      integrated_multimodal_description: integrated,
      ...(ir.target.mode === "reference" ? {
        subject_definitions: subjectDefinitions || adapterLabels.assets.map((asset) => `${asset.canonical} is ${asset.adapter}.`).join("\n"),
        summary: ir.creative.intent ?? `A ${ir.target.duration_ms / 1_000}-second reference sequence with ${ir.shots.length} shot(s).`,
        retention_analysis: retention
      } : {}),
      overall_soundscape: ir.audio.soundscape ?? "N/A",
      non_diegetic_music: ir.audio.non_diegetic_music ?? "N/A"
    },
    labels: adapterLabels,
    blocks,
    must_include: [...ir.creative.must_include],
    prohibited: [...ir.creative.prohibited]
  };
  return { blocks, issues, resolved_text: resolvedText, ast };
}

export function validateExactText(value: string, expectedDigest: string, path: string, reservedTokens: readonly string[] = DEFAULT_RESERVED_EXACT_TEXT_TOKENS): H3Issue[] {
  const issues: H3Issue[] = [];
  if (sha256Text(value) !== expectedDigest) {
    issues.push(issue("VPD-L001", "exact source text digest does not match the byte-preserved text", "error", path.split(".")));
  }
  const token = reservedTokens.find((candidate) => value.includes(candidate));
  if (token) {
    issues.push(issue("VPD-X001", `exact text contains reserved grammar delimiter '${token}' and has no lossless escape`, "error", path.split(".")));
  }
  return issues;
}

export function resolveVocalEventText(
  event: VocalEventV2,
  ir: VideoPromptIrV2,
  options: SemanticBlockOptions,
  path: string
): { text?: string; issues: H3Issue[] } {
  const reserved = options.grammar_reserved_tokens ?? DEFAULT_RESERVED_EXACT_TEXT_TOKENS;
  if (event.content.source === "inline-exact" || event.content.source === "legacy-unaligned") {
    return { text: event.content.exact_text, issues: validateExactText(event.content.exact_text, event.content.text_digest, `${path}.content.exact_text`, reserved) };
  }

  const source = options.lyrics_source;
  if (!source) {
    return { issues: [issue("VPD-L002", "lyrics cue requires a canonical Lyrics source span; cue text cannot be copied into the IR", "error", path.split("."))] };
  }
  if (source.text_digest !== sha256Text(source.canonical_text)) {
    return { issues: [issue("VPD-L001", "canonical lyrics source digest is stale", "error", ["lyrics_source", "text_digest"])] };
  }
  const content = event.content;
  if (content.source !== "lyrics-cue") {
    return { issues: [issue("VPD-L002", "lyrics event content must use a lyrics-cue reference", "error", path.split("."))] };
  }
  const cue = source.cues.find((candidate) => candidate.cue_id === content.cue_id
    && candidate.occurrence_id === content.occurrence_id);
  if (!cue || cue.lyrics_contract_digest !== content.lyrics_contract_digest) {
    return { issues: [issue("VPD-L002", "lyrics cue or contract binding is missing", "error", path.split("."))] };
  }
  const timingIssues = options.require_exact_sync && cue.timing === "untimed"
    ? [issue("VPD-L003", "untimed lyrics cue cannot be used where exact synchronization is required", "error", path.split("."))]
    : [];
  const bytes = Buffer.from(source.canonical_text, "utf8");
  const { start_utf8_byte: start, end_utf8_byte: end } = cue.source_span;
  if (start < 0 || end <= start || end > bytes.length) {
    return { issues: [...timingIssues, issue("VPD-L001", "lyrics source span is outside the canonical UTF-8 source", "error", path.split("."))] };
  }
  const span = bytes.subarray(start, end);
  const text = span.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(span) || sha256Text(text) !== cue.source_span.text_digest || sha256Text(text) !== content.text_digest) {
    return { issues: [...timingIssues, issue("VPD-L001", "lyrics UTF-8 source span or text digest does not match", "error", path.split("."))] };
  }
  return { text, issues: [...timingIssues, ...validateExactText(text, content.text_digest, `${path}.content`, reserved)] };
}

function validateVisibleText(event: VisibleTextEventV2, path: string, reservedTokens: readonly string[]): H3Issue[] {
  const issues = validateExactText(event.text, event.text_digest, `${path}.text`, reservedTokens);
  if (event.render_target === "editor") return issues.filter((item) => item.code !== "VPD-X001");
  return issues;
}

function alignmentText(ir: VideoPromptIrV2): string | undefined {
  if (ir.target.mode === "first-frame") return "At 0.00 seconds, the first-frame reference is fully retained.";
  if (ir.target.mode === "first-last") return `The first-frame reference aligns at 0.00 seconds and the last-frame reference aligns at ${formatSeconds(ir.target.duration_ms)} seconds.`;
  if (ir.target.mode === "last-frame") return `The last-frame reference aligns at ${formatSeconds(ir.target.duration_ms)} seconds.`;
  return undefined;
}

function sceneContext(scene: VideoPromptIrV2["scenes"][number]): string {
  return [scene.location_map, scene.wardrobe, scene.props.join(", "), scene.time_of_day, scene.weather, scene.screen_direction]
    .filter((value): value is string => Boolean(value)).join("; ");
}

function cameraText(camera: NonNullable<ShotV2["camera"]>): string {
  return [camera.type, camera.direction, camera.amplitude, camera.speed].filter(Boolean).join(" ");
}

function opticsText(optics: NonNullable<NonNullable<ShotV2["camera"]>["optics"]>): string {
  return [optics.fov_degrees === undefined ? undefined : `FOV ${optics.fov_degrees} degrees`, optics.lens_mm === undefined ? undefined : `lens ${optics.lens_mm}mm`]
    .filter((value): value is string => Boolean(value)).join(", ");
}

function formatSeconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3);
}

function formatTimestamp(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const ms = milliseconds % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function decapitalize(value: string): string {
  return value ? value[0]!.toLowerCase() + value.slice(1) : value;
}

function subjectIndex(ir: VideoPromptIrV2, id: string): number {
  const index = ir.subjects.findIndex((subject) => subject.id === id);
  return index < 0 ? 0 : index + 1;
}

function assetLabel(type: string, index: number, prior: VideoPromptIrV2["assets"]): string {
  const sameTypeBefore = prior.filter((asset) => asset.type === type).length + 1;
  if (type === "image") return `<Picture ${sameTypeBefore}>`;
  if (type === "video") return `<Video ${sameTypeBefore}>`;
  return `<Audio ${sameTypeBefore}>`;
}

export function semanticBlockDigestMap(blocks: readonly SemanticPromptBlock[]): Record<string, string> {
  return Object.fromEntries(blocks.map((block) => [block.block_id, block.digest]));
}

export function semanticBlocksDigest(blocks: readonly SemanticPromptBlock[]): string {
  return sha256Canonical(blocks);
}
