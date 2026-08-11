/**
 * Neutral render helpers shared by plain and H3 renderers.
 * No Picture / FL2VA / L2VA grammar and no H3 asset label mapping.
 */

import {
  formatVoiceLockedBlock,
  renderSubjectActingLocks
} from "../lockedBlocks.js";
import type { H3Camera, H3Dialogue, H3Shot, H3Subject } from "../schema.js";

export function formatCutTimestamp(startMs: number): string {
  const totalMs = Math.max(0, Math.round(startMs));
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(ms, 3)}`;
}

export function resolveSpeakerId(
  dialogue: H3Dialogue,
  subjects: H3Subject[]
): string | undefined {
  if (dialogue.speaker_id) return dialogue.speaker_id;
  if (!dialogue.speaker) return undefined;
  return subjects.find((subject) => subject.id === dialogue.speaker)?.speaker_id;
}

export function resolveDialogueSubject(
  dialogue: H3Dialogue,
  subjects: H3Subject[]
): H3Subject | undefined {
  if (dialogue.speaker) {
    return subjects.find((item) => item.id === dialogue.speaker);
  }
  // Schema allows speaker_id-only dialogue; resolve unique speaker_id match.
  if (dialogue.speaker_id) {
    const matches = subjects.filter((item) => item.speaker_id === dialogue.speaker_id);
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

/**
 * Dialogue block with optional locked voice text injected verbatim (no paraphrase).
 * Without locked voice, output matches the pre-Phase-A format byte-for-byte.
 */
export function renderDialogueBlock(
  dialogue: H3Dialogue,
  subjects: H3Subject[]
): string {
  const speakerId = resolveSpeakerId(dialogue, subjects) ?? "S1";
  const subject = resolveDialogueSubject(dialogue, subjects);
  const speakerDescription = dialogue.speaker_description
    ?? defaultSpeakerDescription(subject, dialogue, speakerId);
  const voiceLock = subject?.locked_blocks?.voice
    ? formatVoiceLockedBlock(subject.locked_blocks.voice.text)
    : undefined;

  // Dialogue / lyrics / on-screen text stay byte-for-byte.
  const tag = `<d>[${dialogue.language}]${dialogue.text}</d>`;

  if (dialogue.voiceover) {
    if (!voiceLock) {
      return [
        `${speakerDescription} says in an off-screen voiceover:`,
        tag,
        "while his lips remain completely closed."
      ].join("\n");
    }
    return [
      speakerDescription,
      voiceLock,
      "says in an off-screen voiceover:",
      tag,
      "while his lips remain completely closed."
    ].join("\n");
  }

  if (!voiceLock) {
    return `${speakerDescription} says:\n${tag}`;
  }
  return [speakerDescription, voiceLock, "says:", tag].join("\n");
}

/** Appearance / manner locked lines for the dialogue speaker (if any). */
export function renderDialogueActingLocks(
  dialogue: H3Dialogue | undefined,
  subjects: H3Subject[]
): string[] {
  if (!dialogue) return [];
  return renderSubjectActingLocks(resolveDialogueSubject(dialogue, subjects));
}

/**
 * Appearance / manner locks for subjects that appear in a shot:
 * dialogue speaker, cast, and subject_expectations with visible/partial visibility.
 * Dedupes by subject id so multi-signals do not double-inject.
 */
export function renderShotActingLocks(
  shot: H3Shot,
  subjects: H3Subject[]
): string[] {
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));
  const orderedIds: string[] = [];
  const seen = new Set<string>();

  const pushSubject = (id: string | undefined) => {
    if (!id || seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    orderedIds.push(id);
  };

  if (shot.dialogue) {
    const subject = resolveDialogueSubject(shot.dialogue, subjects);
    pushSubject(subject?.id);
  }
  for (const entry of shot.cast ?? []) {
    pushSubject(entry.subject);
  }
  for (const expectation of shot.subject_expectations ?? []) {
    if (expectation.visibility === "visible" || expectation.visibility === "partial") {
      pushSubject(expectation.subject_id);
    }
  }

  const lines: string[] = [];
  for (const id of orderedIds) {
    lines.push(...renderSubjectActingLocks(byId.get(id)));
  }
  return lines;
}

function defaultSpeakerDescription(
  subject: H3Subject | undefined,
  dialogue: H3Dialogue,
  speakerId: string
): string {
  if (subject) {
    const voice = subject.voice?.description ? ` with a ${subject.voice.description}` : "";
    return `The ${subject.description}${voice} (${speakerId})`;
  }
  return `The speaker (${speakerId})`;
}

export function renderCameraSentence(camera: H3Camera): string {
  if (camera.sentence) return ensurePeriod(camera.sentence);
  const amplitude = camera.amplitude ? ` with ${camera.amplitude} amplitude` : "";
  const speed = camera.speed ? ` at ${camera.speed} speed` : "";
  const direction = camera.direction ? ` ${camera.direction}` : "";
  switch (camera.type) {
    case "push_in":
      return `The camera pushes in${amplitude}${speed}.`;
    case "push_out":
      return `The camera pushes out${amplitude}${speed}.`;
    case "zoom_in":
      return `The camera zooms in${amplitude}${speed}.`;
    case "zoom_out":
      return `The camera zooms out${amplitude}${speed}.`;
    case "pan":
      return `The camera pans${direction}${amplitude}${speed}.`;
    case "truck":
      return `The camera trucks${direction}${amplitude}${speed}.`;
    case "arc":
      return `The camera arcs around the subject${amplitude}${speed}.`;
    case "track":
      return `The camera tracks the subject${direction}${amplitude}${speed}.`;
    case "static":
    case "hold":
      return "The camera holds a static shot.";
    default:
      return "The camera holds a static shot.";
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function ensurePeriod(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
