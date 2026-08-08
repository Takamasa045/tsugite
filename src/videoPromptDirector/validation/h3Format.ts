import { mapH3AssetLabels } from "../assetLabels.js";
import {
  BASE_SECTION_ORDER,
  REFERENCE_SECTION_ORDER,
  formatCutTimestamp,
  resolveSpeakerId
} from "../render/shared.js";
import type { H3CreativeIr } from "../schema.js";
import { finalizeValidation, issue, type H3Issue, type H3ValidationResult } from "./types.js";

const DIALOGUE_TAG_RE = /<d>\[([^\]]+)\]([\s\S]*?)<\/d>/g;
/** Shot headers always begin a line; ignore inline mentions such as `(from [Shot 1])`. */
const SHOT_HEADER_RE = /^\[Shot\s+(\d+)\]([^\n]*)/gm;

/**
 * H3 format / creative IR static validation (H3-E001..E008).
 * Keeps route/model capability rules out of this module.
 */
export function validateH3Format(
  ir: H3CreativeIr,
  renderedText?: string
): H3ValidationResult {
  const issues: H3Issue[] = [];
  const text = renderedText ?? "";

  validateRequiredSections(ir, text, issues);
  validateShotHeaders(text, issues);
  validateShotTimeline(ir, issues);
  validateSpeakerStability(ir, issues);
  validateDialogueLock(ir, text, issues);
  validateDefinedReferences(ir, text, issues);

  return finalizeValidation(issues);
}

function validateRequiredSections(ir: H3CreativeIr, text: string, issues: H3Issue[]): void {
  const order = ir.target.mode === "reference" ? REFERENCE_SECTION_ORDER : BASE_SECTION_ORDER;
  if (!text.trim()) {
    issues.push(issue("H3-E001", "required H3 sections are missing", "error"));
    return;
  }
  for (const section of order) {
    if (!hasSectionHeader(text, section)) {
      issues.push(issue(
        "H3-E001",
        `required section '${section}' is missing`,
        "error",
        ["sections", section]
      ));
    }
  }
  // Ensure declared section order matches the canonical order for present headers.
  const present = order.filter((section) => hasSectionHeader(text, section));
  const positions = present.map((section) => text.indexOf(`${section}:`));
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i]! < positions[i - 1]!) {
      issues.push(issue(
        "H3-E001",
        `section order is invalid near '${present[i]}'`,
        "error",
        ["sections"]
      ));
      break;
    }
  }
}

function validateShotHeaders(text: string, issues: H3Issue[]): void {
  if (!text.trim()) return;
  const headers = [...text.matchAll(SHOT_HEADER_RE)];
  if (headers.length === 0) {
    // Reference mode may embed shot structure only in detailed_description; still required.
    if (text.includes("detailed_description:") || text.includes("integrated_multimodal_description:")) {
      issues.push(issue("H3-E003", "shot numbers are missing or not consecutive", "error", ["shots"]));
    }
    return;
  }

  for (const [index, match] of headers.entries()) {
    const number = Number(match[1]);
    const rest = match[2] ?? "";
    if (number !== index + 1) {
      issues.push(issue(
        "H3-E003",
        `shot numbers must be consecutive starting at 1 (found Shot ${number} at position ${index + 1})`,
        "error",
        ["shots", index]
      ));
    }
    if (number === 1 && /\bAt\s+\d{2}:\d{2}\.\d{3}\b/.test(rest)) {
      issues.push(issue(
        "H3-E002",
        "Shot 1 must not include a cut timestamp",
        "error",
        ["shots", 0]
      ));
    }
  }
}

function validateShotTimeline(ir: H3CreativeIr, issues: H3Issue[]): void {
  const durationMs = Math.round(ir.target.duration * 1000);

  for (const [index, shot] of ir.shots.entries()) {
    if (index === 0 && shot.start_ms !== 0) {
      issues.push(issue(
        "H3-E004",
        "first shot must start at 0 ms",
        "error",
        ["shots", index, "start_ms"]
      ));
    }
    if (shot.start_ms > durationMs || shot.end_ms > durationMs) {
      issues.push(issue(
        "H3-E005",
        `shot cut time exceeds target duration (${ir.target.duration}s)`,
        "error",
        ["shots", index, shot.end_ms > durationMs ? "end_ms" : "start_ms"]
      ));
    }
    if (index > 0) {
      const previous = ir.shots[index - 1]!;
      if (shot.start_ms <= previous.start_ms) {
        issues.push(issue(
          "H3-E004",
          `cut times must increase with shot order (shot ${index + 1})`,
          "error",
          ["shots", index, "start_ms"]
        ));
      }
    }
  }

  if (ir.shots.length === 0) {
    issues.push(issue("H3-E003", "shot numbers are not consecutive", "error", ["shots"]));
  }
}

function validateSpeakerStability(ir: H3CreativeIr, issues: H3Issue[]): void {
  const speakerBySubject = new Map<string, string>();
  for (const subject of ir.subjects) {
    if (subject.speaker_id) speakerBySubject.set(subject.id, subject.speaker_id);
  }

  const observed = new Map<string, string>();
  for (const [index, shot] of ir.shots.entries()) {
    const dialogue = shot.dialogue;
    if (!dialogue) continue;
    const speakerId = resolveSpeakerId(dialogue, ir.subjects);
    if (!speakerId) {
      issues.push(issue(
        "H3-E006",
        "dialogue speaker_id could not be resolved stably",
        "error",
        ["shots", index, "dialogue"]
      ));
      continue;
    }
    if (dialogue.speaker) {
      const declared = speakerBySubject.get(dialogue.speaker);
      if (declared && declared !== speakerId) {
        issues.push(issue(
          "H3-E006",
          `speaker_id for subject '${dialogue.speaker}' changed from ${declared} to ${speakerId}`,
          "error",
          ["shots", index, "dialogue", "speaker_id"]
        ));
      }
      const previous = observed.get(dialogue.speaker);
      if (previous && previous !== speakerId) {
        issues.push(issue(
          "H3-E006",
          `speaker_id for subject '${dialogue.speaker}' is not stable across shots`,
          "error",
          ["shots", index, "dialogue", "speaker_id"]
        ));
      }
      observed.set(dialogue.speaker, speakerId);
    }
    // Track bare speaker_id stability when no subject is linked.
    if (!dialogue.speaker) {
      const previous = observed.get(`id:${speakerId}`);
      if (previous && previous !== speakerId) {
        issues.push(issue(
          "H3-E006",
          `speaker_id '${speakerId}' is not stable across shots`,
          "error",
          ["shots", index, "dialogue", "speaker_id"]
        ));
      }
      observed.set(`id:${speakerId}`, speakerId);
    }
  }
}

function validateDialogueLock(ir: H3CreativeIr, text: string, issues: H3Issue[]): void {
  const locked = ir.shots
    .map((shot, index) => ({ shot, index }))
    .filter(({ shot }) => shot.dialogue?.lock_text);

  if (locked.length === 0 || !text.trim()) return;

  // Preserve multiplicity and order: each locked dialogue consumes one rendered tag.
  // Array.some over shared tags undercounts when identical locked lines are duplicated.
  const tags = [...text.matchAll(DIALOGUE_TAG_RE)].map((match) => ({
    language: match[1] ?? "",
    text: match[2] ?? "",
    consumed: false
  }));

  for (const { shot, index } of locked) {
    const dialogue = shot.dialogue!;
    const match = tags.find(
      (tag) =>
        !tag.consumed
        && tag.language === dialogue.language
        && tag.text === dialogue.text
    );
    if (!match) {
      issues.push(issue(
        "H3-E007",
        "locked dialogue text must be preserved byte-for-byte in the rendered prompt",
        "error",
        ["shots", index, "dialogue", "text"]
      ));
    } else {
      match.consumed = true;
    }
  }
}

function validateDefinedReferences(ir: H3CreativeIr, text: string, issues: H3Issue[]): void {
  const labels = mapH3AssetLabels(ir);
  const defined = new Set<string>([
    ...Object.values(labels.assets).flatMap((label) => [label.h3, label.adapter]),
    ...Object.values(labels.subjects).map((label) => label.h3)
  ]);

  // IR-level undefined asset/subject refs are schema-checked; here check prompt labels.
  if (!text.trim()) {
    for (const [index, subject] of ir.subjects.entries()) {
      if (subject.source_asset && !labels.assets[subject.source_asset]) {
        issues.push(issue(
          "H3-E008",
          `reference label for asset '${subject.source_asset}' is undefined`,
          "error",
          ["subjects", index, "source_asset"]
        ));
      }
    }
    return;
  }

  const referenced = [
    ...text.matchAll(/<Picture\s+\d+>/g),
    ...text.matchAll(/<Video\s+\d+>/g),
    ...text.matchAll(/<Audio\s+\d+>/g),
    ...text.matchAll(/<Subject\s+\d+>/g),
    ...text.matchAll(/@image\d+/g),
    ...text.matchAll(/@video\d+/g),
    ...text.matchAll(/@audio\d+/g)
  ].map((match) => match[0]);

  for (const ref of referenced) {
    if (!defined.has(ref)) {
      issues.push(issue(
        "H3-E008",
        `reference label '${ref}' is undefined`,
        "error",
        ["references"]
      ));
    }
  }
}

function hasSectionHeader(text: string, section: string): boolean {
  return new RegExp(`(^|\\n)${escapeRegExp(section)}:\\s*(\\n|$)`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exported for tests that need timestamp formatting parity checks. */
export function expectedLaterShotTimestamp(startMs: number): string {
  return formatCutTimestamp(startMs);
}
