import { sha256Canonical, sha256Text } from "../../integrity/canonical.js";
import { buildAdapterLabelMap, type AdapterLabelMap } from "../adapterDialect.js";
import {
  buildSemanticBlocks,
  type SemanticBlockOptions,
  type SemanticPromptBlock,
  type SemanticPromptAst,
  resolveVocalEventText
} from "../semanticBlocks.js";
import type { H3Issue } from "../validation/types.js";
import { issue } from "../validation/types.js";
import type { ShotV2, VideoPromptIrV2, VocalEventV2 } from "../schemaV2.js";

export const H3_GRAMMAR_V3_VERSION = "3" as const;
export const H3_BASE_SECTION_ORDER_V3 = [
  "integrated_multimodal_description",
  "overall_soundscape",
  "non_diegetic_music"
] as const;
export const H3_REFERENCE_SECTION_ORDER_V3 = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music"
] as const;

export type H3GrammarProfileV3 = {
  profile_id: string;
  source_commit: string;
  source_digest: string;
  section_order: readonly string[];
  features: {
    scenetrans: boolean;
    cutoff: boolean;
    group_speaker: boolean;
    exact_dialogue: boolean;
  };
  serialization_rules_digest: string;
  digest: string;
};

export type H3GrammarV3Result = {
  format: "base" | "reference";
  sections: Record<string, string>;
  text: string;
  labels: AdapterLabelMap;
  blocks: SemanticPromptBlock[];
  issues: H3Issue[];
  grammar_profile: H3GrammarProfileV3;
};

export type H3GrammarV3Options = SemanticBlockOptions & {
  grammar_profile?: H3GrammarProfileV3;
};

export const DEFAULT_H3_GRAMMAR_PROFILE_V3: H3GrammarProfileV3 = {
  profile_id: "minimax-h3-v3",
  source_commit: "pinned-local-profile",
  source_digest: sha256Text("minimax-h3-v3"),
  section_order: H3_BASE_SECTION_ORDER_V3,
  features: { scenetrans: true, cutoff: true, group_speaker: true, exact_dialogue: true },
  serialization_rules_digest: sha256Text("h3-grammar-v3-serialization"),
  digest: sha256Canonical({
    profile_id: "minimax-h3-v3",
    source_commit: "pinned-local-profile",
    source_digest: sha256Text("minimax-h3-v3"),
    section_order: H3_BASE_SECTION_ORDER_V3,
    features: { scenetrans: true, cutoff: true, group_speaker: true, exact_dialogue: true },
    serialization_rules_digest: sha256Text("h3-grammar-v3-serialization")
  })
};

export function h3GrammarProfileDigest(profile: H3GrammarProfileV3 | Omit<H3GrammarProfileV3, "digest">): string {
  const { digest: _digest, ...withoutDigest } = profile as H3GrammarProfileV3;
  return sha256Canonical(withoutDigest);
}

export function renderH3GrammarV3(
  input: VideoPromptIrV2 | SemanticPromptAst,
  options: H3GrammarV3Options = {}
): H3GrammarV3Result {
  if (isSemanticPromptAst(input)) return renderSemanticPromptAst(input, options);
  return renderH3GrammarV3Legacy(input, options);
}

/**
 * Generic renderer for a non-H3 model. It consumes only the materialized
 * semantic AST and deliberately emits no H3 section headers or media labels.
 */
export function renderProviderNeutralPrompt(ast: SemanticPromptAst): H3GrammarV3Result {
  const orderedSections = ast.format === "reference"
    ? [
        ast.sections.subject_definitions,
        ast.sections.summary,
        ast.sections.retention_analysis,
        ast.sections.integrated_multimodal_description,
        ast.sections.overall_soundscape,
        ast.sections.non_diegetic_music
      ]
    : [
        ast.sections.integrated_multimodal_description,
        ast.sections.overall_soundscape,
        ast.sections.non_diegetic_music
      ];
  const neutralize = (value: string): string => replaceOutsideExactText(value, (segment) => {
    let output = segment;
    for (const label of ast.labels.assets) output = output.replaceAll(label.canonical, label.asset_id);
    for (const subject of ast.labels.subjects) output = output.replaceAll(subject.canonical, subject.subject_id);
    return output;
  });
  const sections = Object.fromEntries(
    orderedSections.map((section, index) => [`semantic_${index + 1}`, neutralize(section ?? "")])
  );
  const text = orderedSections.filter((section): section is string => Boolean(section)).map(neutralize).join("\n\n");
  const issues: H3Issue[] = [];
  for (const required of ast.must_include) {
    if (!text.includes(required)) issues.push(issue("VPD-C001", `must_include value '${required}' was not reflected in the prompt`, "error", ["creative", "must_include"]));
  }
  for (const prohibited of ast.prohibited) {
    if (text.includes(prohibited)) issues.push(issue("VPD-C001", `prohibited value '${prohibited}' was reflected in the prompt`, "error", ["creative", "prohibited"]));
  }
  return {
    format: ast.format,
    sections,
    text,
    labels: ast.labels,
    blocks: ast.blocks,
    issues,
    grammar_profile: DEFAULT_H3_GRAMMAR_PROFILE_V3
  };
}

function replaceOutsideExactText(value: string, replacement: (segment: string) => string): string {
  const exact = /<d>[\s\S]*?<\/d>/g;
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(exact)) {
    const start = match.index ?? 0;
    output += replacement(value.slice(cursor, start));
    output += match[0];
    cursor = start + match[0].length;
  }
  return output + replacement(value.slice(cursor));
}

function renderSemanticPromptAst(
  ast: SemanticPromptAst,
  options: H3GrammarV3Options
): H3GrammarV3Result {
  const profile = options.grammar_profile ?? DEFAULT_H3_GRAMMAR_PROFILE_V3;
  const issues: H3Issue[] = [];
  if (h3GrammarProfileDigest(profile) !== profile.digest) {
    issues.push(issue("VPD-C003", "H3 grammar profile digest is stale", "error", ["grammar_profile", "digest"]));
  }
  const baseProfileOrder = profile.section_order.length === H3_BASE_SECTION_ORDER_V3.length
    && profile.section_order.every((section, index) => section === H3_BASE_SECTION_ORDER_V3[index]);
  const referenceProfileOrder = profile.section_order.length === H3_REFERENCE_SECTION_ORDER_V3.length
    && profile.section_order.every((section, index) => section === H3_REFERENCE_SECTION_ORDER_V3[index]);
  if (!baseProfileOrder && !(ast.format === "reference" && referenceProfileOrder)) {
    issues.push(issue("VPD-C002", "selected grammar profile section order does not match the requested mode", "error", ["grammar_profile", "section_order"]));
  }
  const sections: Record<string, string> = ast.format === "reference"
    ? {
        subject_definitions: ast.sections.subject_definitions ?? "",
        summary: ast.sections.summary ?? "",
        retention_analysis: ast.sections.retention_analysis ?? "",
        detailed_description: ast.sections.integrated_multimodal_description,
        overall_soundscape: ast.sections.overall_soundscape,
        non_diegetic_music: ast.sections.non_diegetic_music
      }
    : {
        integrated_multimodal_description: ast.sections.integrated_multimodal_description,
        overall_soundscape: ast.sections.overall_soundscape,
        non_diegetic_music: ast.sections.non_diegetic_music
      };
  const order = ast.format === "reference" ? H3_REFERENCE_SECTION_ORDER_V3 : H3_BASE_SECTION_ORDER_V3;
  const text = order.map((key) => `${key}:\n${sections[key] ?? ""}`).join("\n\n");
  for (const required of ast.must_include) {
    if (!text.includes(required)) issues.push(issue("VPD-C001", `must_include value '${required}' was not reflected in the prompt`, "error", ["creative", "must_include"]));
  }
  for (const prohibited of ast.prohibited) {
    if (text.includes(prohibited)) issues.push(issue("VPD-C001", `prohibited value '${prohibited}' was reflected in the prompt`, "error", ["creative", "prohibited"]));
  }
  issues.push(...validateGrammarShape(text, ast.format));
  return { format: ast.format, sections, text, labels: ast.labels, blocks: ast.blocks, issues, grammar_profile: profile };
}

function isSemanticPromptAst(value: VideoPromptIrV2 | SemanticPromptAst): value is SemanticPromptAst {
  return "sections" in value && "blocks" in value && "labels" in value;
}

function renderH3GrammarV3Legacy(
  ir: VideoPromptIrV2,
  options: H3GrammarV3Options = {}
): H3GrammarV3Result {
  const blocksResult = buildSemanticBlocks(ir, options);
  const labels = buildAdapterLabelMap(ir);
  const profile = options.grammar_profile ?? DEFAULT_H3_GRAMMAR_PROFILE_V3;
  const issues = [...blocksResult.issues];
  if (h3GrammarProfileDigest(profile) !== profile.digest) {
    issues.push(issue("VPD-C003", "H3 grammar profile digest is stale", "error", ["grammar_profile", "digest"]));
  }
  const description = ir.shots.map((shot, index) => renderShot(shot, index, ir, options, labels, issues)).join("\n\n");
  const alignment = renderAlignment(ir, labels);
  const integrated = alignment ? `${alignment}\n\n${description}` : description;

  let sections: Record<string, string>;
  let format: "base" | "reference";
  if (ir.target.mode === "reference") {
    format = "reference";
    sections = {
      subject_definitions: renderSubjectDefinitions(ir, labels),
      summary: ir.creative.intent ?? `A ${ir.target.duration_ms / 1_000}-second reference sequence with ${ir.shots.length} shot(s).`,
      retention_analysis: renderRetention(ir, labels),
      detailed_description: integrated,
      overall_soundscape: ir.audio.soundscape ?? "N/A",
      non_diegetic_music: ir.audio.non_diegetic_music ?? "N/A"
    };
  } else {
    format = "base";
    sections = {
      integrated_multimodal_description: integrated,
      overall_soundscape: ir.audio.soundscape ?? "N/A",
      non_diegetic_music: ir.audio.non_diegetic_music ?? "N/A"
    };
  }

  const order = format === "reference" ? H3_REFERENCE_SECTION_ORDER_V3 : H3_BASE_SECTION_ORDER_V3;
  const text = order.map((key) => `${key}:\n${sections[key] ?? ""}`).join("\n\n");
  for (const required of ir.creative.must_include) {
    if (!text.includes(required)) issues.push(issue("VPD-C001", `must_include value '${required}' was not reflected in the prompt`, "error", ["creative", "must_include"]));
  }
  for (const prohibited of ir.creative.prohibited) {
    if (text.includes(prohibited)) issues.push(issue("VPD-C001", `prohibited value '${prohibited}' was reflected in the prompt`, "error", ["creative", "prohibited"]));
  }
  issues.push(...validateGrammarShape(text, format, ir));
  return { format, sections, text, labels, blocks: blocksResult.blocks, issues, grammar_profile: profile };
}

export function validateGrammarShape(
  text: string,
  format: "base" | "reference",
  ir?: VideoPromptIrV2
): H3Issue[] {
  const order = format === "reference" ? H3_REFERENCE_SECTION_ORDER_V3 : H3_BASE_SECTION_ORDER_V3;
  const issues: H3Issue[] = [];
  const positions = order.map((section) => text.indexOf(`${section}:`));
  if (positions.some((position) => position < 0) || positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) {
    issues.push(issue("VPD-C002", "H3 grammar top-level section order is invalid", "error", ["prompt"]));
  }
  for (const section of order) {
    if ((text.match(new RegExp(`^${section}:`, "gm")) ?? []).length !== 1) {
      issues.push(issue("VPD-C002", `H3 grammar section '${section}' must occur exactly once`, "error", ["prompt"]));
    }
  }
  if (format === "base" && ir && ["first-frame", "first-last", "last-frame"].includes(ir.target.mode)) {
    const description = text.slice(text.indexOf("integrated_multimodal_description:"));
    if (!description.includes("reference") && !description.includes("aligns")) {
      issues.push(issue("VPD-C002", "mode alignment must live inside integrated_multimodal_description", "error", ["prompt"]));
    }
  }
  return issues;
}

function renderShot(
  shot: ShotV2,
  index: number,
  ir: VideoPromptIrV2,
  options: H3GrammarV3Options,
  labels: AdapterLabelMap,
  issues: H3Issue[]
): string {
  const parts: string[] = [];
  const scene = shot.scene_id ? ir.scenes.find((item) => item.id === shot.scene_id) : undefined;
  if (scene) {
    parts.push(`LOCATION MAP:\n${scene.location_map}`);
    if (scene.palette !== undefined) parts.push(`LIGHTING:\n${scene.palette}`);
  }
  if (shot.composition) parts.push(shot.composition);
  for (const beat of shot.action_beats) parts.push(beat.description);
  if (shot.camera) {
    parts.push([shot.camera.type, shot.camera.direction, shot.camera.amplitude, shot.camera.speed].filter(Boolean).join(" "));
    if (shot.camera.optics) parts.push([shot.camera.optics.fov_degrees === undefined ? undefined : `FOV ${shot.camera.optics.fov_degrees} degrees`, shot.camera.optics.lens_mm === undefined ? undefined : `lens ${shot.camera.optics.lens_mm}mm`].filter(Boolean).join(", "));
  }
  for (const cast of shot.cast) {
    const subjectIndex = ir.subjects.findIndex((subject) => subject.id === cast.subject_id);
    if (subjectIndex >= 0) {
      const subject = ir.subjects[subjectIndex]!;
      parts.push(`<Subject ${subjectIndex + 1}> is present${cast.variant_id ? ` in variant ${cast.variant_id}` : ""}.`);
      for (const field of ["voice", "appearance", "manner"] as const) {
        const locked = subject.locked_blocks?.[field];
        if (locked) parts.push(`${field.toUpperCase()} (locked):\n${locked.text}`);
      }
    }
  }
  for (const event of shot.vocal_events) {
    const resolved = resolveVocalEventText(event, ir, options, `shots.${index}.vocal_events`);
    issues.push(...resolved.issues);
    if (resolved.text === undefined) continue;
    parts.push(renderVocalEvent(event, resolved.text, ir));
    if (event.continuity === "continues-out") {
      if (options.grammar_profile && !options.grammar_profile.features.scenetrans) issues.push(issue("VPD-C002", "selected grammar profile cannot serialize <scenetrans>", "error", ["shots", index, "vocal_events"]));
      else parts.push("<scenetrans>");
    }
    if (event.continuity === "cutoff") {
      if (options.grammar_profile && !options.grammar_profile.features.cutoff) issues.push(issue("VPD-C002", "selected grammar profile cannot serialize <cutoff>", "error", ["shots", index, "vocal_events"]));
      else parts.push("<cutoff>");
    }
  }
  for (const event of shot.visible_text_events) {
    if (event.render_target === "model") parts.push(`On-screen text: ${event.text}`);
  }
  const body = parts.filter((part) => part.length > 0).join(" ");
  if (index === 0) return `[Shot 1] ${body}`;
  return `[Shot ${index + 1}] At ${formatTimestamp(shot.start_ms)}, the camera cuts to ${decapitalize(body)}`;
}

function renderVocalEvent(event: VocalEventV2, text: string, ir: VideoPromptIrV2): string {
  const subject = ir.subjects.find((candidate) => candidate.speaker_id === event.speaker_ids[0]);
  const description = subject ? `The ${subject.description} (${event.speaker_ids[0]})` : `The speaker (${event.speaker_ids[0]})`;
  const tag = `<d>[${event.language_id}]${text}</d>`;
  if (event.kind === "voiceover") return `${description} says in an off-screen voiceover:\n${tag}\nwhile his lips remain completely closed.`;
  if (event.kind === "singing") return `${description} sings:\n${tag}`;
  return `${description} says:\n${tag}`;
}

function renderSubjectDefinitions(ir: VideoPromptIrV2, labels: AdapterLabelMap): string {
  const lines: string[] = [];
  for (const [index, subject] of ir.subjects.entries()) {
    const label = `<Subject ${index + 1}>`;
    const asset = subject.source_asset_id ? labels.assets.find((candidate) => candidate.asset_id === subject.source_asset_id) : undefined;
    lines.push(`${label} is the ${subject.description}${asset ? ` shown in ${asset.canonical}.` : "."}`);
    if (subject.locked_blocks?.voice) lines.push(`VOICE:\n${subject.locked_blocks.voice.text}`);
    if (subject.locked_blocks?.appearance) lines.push(`CHARACTER APPEARANCE:\n${subject.locked_blocks.appearance.text}`);
    if (subject.locked_blocks?.manner) lines.push(`CHARACTER MANNER:\n${subject.locked_blocks.manner.text}`);
  }
  if (lines.length === 0) lines.push(...labels.assets.map((asset) => `${asset.canonical} is ${asset.adapter}.`));
  return lines.join("\n");
}

function renderRetention(ir: VideoPromptIrV2, labels: AdapterLabelMap): string {
  if (ir.subjects.length === 0) return "Retain referenced subject appearance, clothing, and spatial relationships across the clip.";
  return ir.subjects.map((subject, index) => {
    const retention = subject.preservation
      ? [subject.preservation.identity ? `identity=${subject.preservation.identity}` : undefined, subject.preservation.clothing ? `clothing=${subject.preservation.clothing}` : undefined, subject.preservation.hairstyle ? `hairstyle=${subject.preservation.hairstyle}` : undefined].filter(Boolean).join(", ")
      : "identity and clothing remain consistent";
    return `Retain <Subject ${index + 1}> (${retention}).`;
  }).join(" ");
}

function renderAlignment(ir: VideoPromptIrV2, labels: AdapterLabelMap): string | undefined {
  if (ir.target.mode === "first-frame") {
    const asset = ir.assets.find((candidate) => candidate.role === "first_frame");
    return asset ? `For the target video, at 0.00 seconds into the target video,\n${labels.assets.find((item) => item.asset_id === asset.id)?.canonical ?? "<Picture 1>"} (from [Shot 1]) is fully referenced.` : undefined;
  }
  if (ir.target.mode === "first-last") {
    const first = ir.assets.find((candidate) => candidate.role === "first_frame");
    const last = ir.assets.find((candidate) => candidate.role === "last_frame");
    if (!first || !last) return undefined;
    return `How the reference pictures align with the target video — ${labels.assets.find((item) => item.asset_id === first.id)?.canonical ?? "<Picture 1>"} (from [Shot 1]) aligns with the 0.00-second mark of the target video. ${labels.assets.find((item) => item.asset_id === last.id)?.canonical ?? "<Picture 2>"} (from [Shot ${ir.shots.length}]) aligns with the ${(ir.target.duration_ms / 1000).toFixed(2)}-second mark of the target video.`;
  }
  if (ir.target.mode === "last-frame") {
    const last = ir.assets.find((candidate) => candidate.role === "last_frame");
    return last ? `How the reference pictures align with the target video — ${labels.assets.find((item) => item.asset_id === last.id)?.canonical ?? "<Picture 1>"} (from [Shot ${ir.shots.length}]) aligns with the ${(ir.target.duration_ms / 1000).toFixed(2)}-second mark of the target video.` : undefined;
  }
  return undefined;
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
