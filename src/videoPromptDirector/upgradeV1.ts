import { sha256Text } from "../integrity/canonical.js";
import type { H3CreativeIr, VideoCreativeIr } from "./schema.js";
import {
  parseVideoPromptIrV2,
  type ProgramBindingForV2,
  type VideoPromptIrV2
} from "./schemaV2.js";

export type V1UpgradeOptions = {
  program_kind?: "standalone" | "mv";
  program_binding?: ProgramBindingForV2;
};

export type V1UpgradeResult = {
  ir: VideoPromptIrV2;
  source_version: 1;
  source_model: string;
  source_sha256: string;
};

/**
 * Convert the existing v1 authoring shape without touching its source object.
 * The returned V2 value contains no compatibility-only fields and is safe to
 * pass to the same compiler as a native V2 request.
 */
export function upgradeVideoPromptV1ToV2(
  input: VideoCreativeIr,
  options: V1UpgradeOptions = {}
): V1UpgradeResult {
  return upgradeV1(input, options);
}

/** Pure legacy H3 reader/upgrader. It never rewrites project.yaml or the input. */
export function upgradeH3V1ToVideoPromptV2(
  input: H3CreativeIr,
  options: V1UpgradeOptions = {}
): V1UpgradeResult {
  return upgradeV1(input, options);
}

function upgradeV1(input: H3CreativeIr | VideoCreativeIr, options: V1UpgradeOptions): V1UpgradeResult {
  const target = input.target;
  const programKind = options.program_kind ?? "standalone";
  if (programKind === "mv" && !options.program_binding) {
    throw new Error("VPD-U001: mv V1 upgrade requires program_binding");
  }
  if (programKind === "standalone" && options.program_binding) {
    throw new Error("VPD-U001: standalone V1 upgrade must not receive program_binding");
  }

  const subjects = input.subjects.map((subject) => ({
    id: subject.id,
    description: subject.description,
    ...(subject.source_asset ? { source_asset_id: subject.source_asset } : {}),
    ...(subject.speaker_id ? { speaker_id: subject.speaker_id } : {}),
    ...(subject.voice ? {
      voice: {
        ...(subject.voice.source_asset ? { source_asset_id: subject.voice.source_asset } : {}),
        ...(subject.voice.description ? { description: subject.voice.description } : {}),
        ...(subject.voice.relationship ? { relationship: subject.voice.relationship } : {})
      }
    } : {}),
    ...(subject.locked_blocks ? {
      locked_blocks: {
        ...(subject.locked_blocks.voice ? { voice: { ...subject.locked_blocks.voice } } : {}),
        ...(subject.locked_blocks.appearance ? { appearance: { ...subject.locked_blocks.appearance } } : {}),
        ...(subject.locked_blocks.manner ? { manner: { ...subject.locked_blocks.manner } } : {})
      }
    } : {}),
    ...(subject.variants ? {
      variants: subject.variants.map((variant) => ({
        id: variant.id,
        source_asset_id: variant.source_asset
      }))
    } : {}),
    ...(subject.preservation ? { preservation: { ...subject.preservation } } : {})
  }));

  const scenes = (input.scenes ?? []).map((scene) => ({
    id: scene.id,
    location_map: scene.location_map,
    ...(scene.palette !== undefined ? { palette: scene.palette } : {}),
    props: [],
    active_subject_ids: [...scene.active_subjects]
  }));

  const shots = input.shots.map((shot) => ({
    id: shot.id,
    start_ms: shot.start_ms,
    end_ms: shot.end_ms,
    ...(shot.scene ? { scene_id: shot.scene } : {}),
    cast: (shot.cast ?? []).map((entry) => ({
      subject_id: entry.subject,
      ...(entry.variant ? { variant_id: entry.variant } : {})
    })),
    ...(legacyComposition(shot.composition) ? { composition: legacyComposition(shot.composition) } : {}),
    action_beats: [{ description: shot.visual }],
    ...(shot.camera ? { camera: legacyCamera(shot.camera) } : {}),
    vocal_events: [
      ...(shot.dialogue ? [legacyDialogueEvent(shot.id + "-dialogue", shot.dialogue, input.subjects)] : []),
      ...(shot.lyrics !== undefined ? [legacyLyricsEvent(shot.id + "-lyrics", shot.lyrics, input.subjects)] : [])
    ],
    visible_text_events: shot.on_screen_text === undefined ? [] : [{
      id: `${shot.id}-visible-text`,
      text: shot.on_screen_text,
      text_digest: sha256Text(shot.on_screen_text),
      purpose: "generated-scene-text" as const,
      render_target: "model" as const
    }],
    ...(shot.subject_expectations ? { subject_expectations: shot.subject_expectations.map((expectation) => ({ ...expectation })) } : {}),
    constraints: {
      positive: [],
      exact_text_refs: [
        ...(shot.dialogue ? [`${shot.id}-dialogue`] : []),
        ...(shot.lyrics !== undefined ? [`${shot.id}-lyrics`] : []),
        ...(shot.on_screen_text !== undefined ? [`${shot.id}-visible-text`] : [])
      ]
    }
  }));

  const raw = {
    version: 2 as const,
    target: {
      model_profile_id: target.model,
      mode: target.mode,
      duration_ms: durationToMs(target.duration),
      quality: target.quality,
      aspect: target.aspect,
      audio: target.audio
    },
    creative: {
      ...(input.creative?.intent !== undefined ? { intent: input.creative.intent } : {}),
      ...(input.creative?.style ? { style: { ...input.creative.style } } : {}),
      must_include: [...(input.creative?.must_include ?? [])],
      prohibited: [...(input.creative?.avoid ?? [])]
    },
    subjects,
    scenes,
    assets: input.assets.map((asset) => ({
      id: asset.id,
      type: asset.type,
      path: asset.path,
      role: asset.role
    })),
    shots,
    audio: {
      policy: input.sound.music.enabled ? "native-generated" as const : "silent" as const,
      soundscape: input.sound.soundscape,
      ...(input.sound.music.description ? { non_diegetic_music: input.sound.music.description } : {}),
      reference_asset_ids: [],
      final_mix: input.sound.music.enabled ? "use-generated" as const : "discard-generated" as const
    },
    program_kind: programKind,
    ...(options.program_binding ? { program_binding: { ...options.program_binding } } : {})
  };

  return {
    ir: parseVideoPromptIrV2(raw),
    source_version: 1,
    source_model: target.model,
    source_sha256: sha256Text(JSON.stringify(input))
  };
}

function durationToMs(seconds: number): number {
  const milliseconds = seconds * 1_000;
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("VPD-U002: V1 duration must convert to a positive safe integer number of milliseconds");
  }
  return milliseconds;
}

function legacyComposition(composition: { framing?: string; subject_position?: string; environment?: string } | undefined): string | undefined {
  if (!composition) return undefined;
  return [composition.framing, composition.subject_position, composition.environment]
    .filter((value): value is string => Boolean(value))
    .join("; ") || undefined;
}

function legacyCamera(camera: NonNullable<H3CreativeIr["shots"][number]["camera"]>) {
  return {
    type: camera.type,
    ...(camera.amplitude ? { amplitude: camera.amplitude } : {}),
    ...(camera.speed ? { speed: camera.speed } : {}),
    ...(camera.direction ? { direction: camera.direction } : {})
  };
}

function speakerIds(
  speaker: string | undefined,
  speakerId: string | undefined,
  subjects: H3CreativeIr["subjects"]
): string[] {
  if (speakerId) return [speakerId];
  const subject = speaker ? subjects.find((item) => item.id === speaker) : undefined;
  return [subject?.speaker_id ?? "S1"];
}

function legacyDialogueEvent(
  id: string,
  dialogue: NonNullable<H3CreativeIr["shots"][number]["dialogue"]>,
  subjects: H3CreativeIr["subjects"]
) {
  return {
    id,
    kind: dialogue.voiceover ? "voiceover" as const : "dialogue" as const,
    speaker_ids: speakerIds(dialogue.speaker, dialogue.speaker_id, subjects),
    language_id: dialogue.language,
    content: {
      source: "legacy-unaligned" as const,
      exact_text: dialogue.text,
      text_digest: sha256Text(dialogue.text)
    },
    continuity: "contained" as const
  };
}

function legacyLyricsEvent(
  id: string,
  text: string,
  subjects: H3CreativeIr["subjects"]
) {
  return {
    id,
    kind: "singing" as const,
    speaker_ids: [subjects.find((subject) => subject.speaker_id)?.speaker_id ?? "S1"],
    language_id: "und",
    content: {
      source: "legacy-unaligned" as const,
      exact_text: text,
      text_digest: sha256Text(text)
    },
    continuity: "contained" as const
  };
}
