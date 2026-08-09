/**
 * Neutral render helpers shared by plain and H3 renderers.
 * No Picture / FL2VA / L2VA grammar and no H3 asset label mapping.
 */

import type { H3Camera, H3Dialogue, H3Subject } from "../schema.js";

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

export function renderDialogueBlock(
  dialogue: H3Dialogue,
  subjects: H3Subject[]
): string {
  const speakerId = resolveSpeakerId(dialogue, subjects) ?? "S1";
  const subject = dialogue.speaker
    ? subjects.find((item) => item.id === dialogue.speaker)
    : undefined;
  const speakerDescription = dialogue.speaker_description
    ?? defaultSpeakerDescription(subject, dialogue, speakerId);

  // Dialogue / lyrics / on-screen text stay byte-for-byte.
  const tag = `<d>[${dialogue.language}]${dialogue.text}</d>`;

  if (dialogue.voiceover) {
    return [
      `${speakerDescription} says in an off-screen voiceover:`,
      tag,
      "while his lips remain completely closed."
    ].join("\n");
  }

  return `${speakerDescription} says:\n${tag}`;
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
