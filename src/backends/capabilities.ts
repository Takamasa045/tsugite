import { FAST_EDIT_CAPABILITIES, fastEditCapabilitiesSchema } from "../fastEdit/schema.js";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import type { Manifest } from "../manifest/schema.js";
import type { Issue, Result } from "../types.js";
import { PipelineError } from "../types.js";
import { setupCheckSchema } from "../setupChecks.js";

const capabilitiesSchema = z.object({
  name: z.string().min(1),
  motion_review: z
    .object({
      surface: z.string().min(1),
      method: z.string().min(1),
      preview: z.enum(["html-css-approximation", "specification-only", "native-cli"])
    })
    .optional(),
  capabilities: z.object({
    fast_edit: fastEditCapabilitiesSchema.optional(),
    native_authoring: z.object({
      aspects: z.array(z.string().min(1)).min(1),
      fps: z.array(z.number().positive()).min(1),
      asset_id_pattern: z.string().min(1).optional()
    }).strict().superRefine((value, context) => {
      if (!value.asset_id_pattern) return;
      try { new RegExp(value.asset_id_pattern); }
      catch { context.addIssue({ code: z.ZodIssueCode.custom, path: ["asset_id_pattern"], message: "native_authoring.asset_id_pattern must be a valid regular expression" }); }
    }).optional(),
    captions: z.boolean(),
    transitions: z.boolean(),
    audio_mix: z.boolean(),
    audio_reactive: z.boolean().default(false),
    vertical: z.boolean(),
    transition_inputs: z.array(z.enum(["top_level", "clip_motion"])).min(1).optional(),
    fps: z.array(z.number().positive()).min(1),
    presets: z.array(z.string().min(1)).default([])
  }),
  checks: z
    .object({
      setup: z.array(setupCheckSchema).default([]),
      render_preflight: z
        .array(
          z.object({
            name: z.string().min(1),
            command: z.array(z.string().min(1)).min(1)
          })
        )
        .default([])
    })
    .default({ setup: [], render_preflight: [] })
});

export type BackendCapabilities = z.infer<typeof capabilitiesSchema>;
export type BackendMotionReview = NonNullable<BackendCapabilities["motion_review"]>;
export type BackendExternalCommand = {
  phase: "render_preflight";
  backend: string;
  name: string;
  command: string[];
};

export async function loadBackendCapabilities(
  name: string,
  backendDirs = ["backends"]
): Promise<BackendCapabilities | undefined> {
  for (const dir of backendDirs) {
    const path = join(dir, name, "capabilities.yaml");
    if (await exists(path)) {
      const parsed = capabilitiesSchema.safeParse(await readYamlFile(path));
      if (!parsed.success) {
        throw new PipelineError({
          code: "backend.schema",
          message: parsed.error.issues[0]?.message ?? "invalid backend capabilities",
          path
        });
      }
      return parsed.data;
    }
  }

  return undefined;
}

export function validateBackendCapabilities(
  manifest: Manifest,
  backend: BackendCapabilities,
  fastEditEnabled = Boolean(manifest.fast_edit)
): Result<{ backend: BackendCapabilities }> {
  const issues: Issue[] = [];
  const capabilities = fastEditEnabled ? {...backend.capabilities,
    vertical: backend.capabilities.fast_edit?.vertical === true,
    audio_mix: backend.capabilities.fast_edit?.audio === true,
    transitions: backend.capabilities.fast_edit?.transitions === true
  } : backend.capabilities;
  const nativeAuthoring = backend.capabilities.native_authoring;
  if (manifest.native_edit && !nativeAuthoring) {
    issues.push({
      code: "backend.capability.native_edit",
      message: `manifest contains native authoring data, but backend '${backend.name}' does not declare native authoring support`,
      path: "native_edit"
    });
  }
  if (fastEditEnabled) {
    for (const key of FAST_EDIT_CAPABILITIES) if (capabilities.fast_edit?.[key] !== true) {
      issues.push({code: "backend.capability.fast_edit", message: `Fast Edit v1 requires ${key} on ${backend.name}`});
    }
  }

  if (manifest.captions.length > 0 && !capabilities.captions) {
    issues.push({
      code: "backend.capability.captions",
      message: "manifest requires captions, but backend does not support captions"
    });
  }

  if (manifest.meta.aspect === "9:16" && !capabilities.vertical) {
    issues.push({
      code: "backend.capability.vertical",
      message: "manifest requires vertical output, but backend does not support it"
    });
  }

  const nativeAuthoringMode = Boolean(manifest.native_edit?.mode === "replace" && nativeAuthoring);
  if (nativeAuthoringMode && nativeAuthoring?.asset_id_pattern) {
    const assetIdPattern = new RegExp(nativeAuthoring.asset_id_pattern);
    const declaredIds = [
      ...manifest.clips.map((clip, index) => ({ id: clip.id, path: `clips.${index}.id` })),
      ...manifest.images.map((image, index) => ({ id: image.id, path: `images.${index}.id` })),
      ...(manifest.native_edit?.assets ?? []).map((asset, index) => ({ id: asset.asset_id, path: `native_edit.assets.${index}.asset_id` }))
    ];
    for (const declaration of declaredIds) {
      assetIdPattern.lastIndex = 0;
      if (!assetIdPattern.test(declaration.id)) {
        issues.push({
          code: "backend.capability.native_asset_id",
          message: `native resource id '${declaration.id}' does not match backend '${backend.name}' requirements`,
          path: declaration.path
        });
      }
    }
  }
  if (!(["16:9", "9:16"] as string[]).includes(manifest.meta.aspect)
    && !(nativeAuthoringMode && nativeAuthoring?.aspects.includes(manifest.meta.aspect))) {
    issues.push({
      code: "backend.capability.aspect",
      message: `manifest aspect ${manifest.meta.aspect} is not supported by backend '${backend.name}'`,
      path: "meta.aspect"
    });
  }

  if (!capabilities.fps.includes(manifest.meta.fps)
    && !(nativeAuthoringMode && nativeAuthoring?.fps.includes(manifest.meta.fps))) {
    issues.push({
      code: "backend.capability.fps",
      message: `manifest fps ${manifest.meta.fps} is not supported by backend`
    });
  }

  if (requiresAudioMix(manifest) && !capabilities.audio_mix) {
    issues.push({
      code: "backend.capability.audio_mix",
      message: "manifest requires audio mixing, but backend does not support it"
    });
  }

  if (requiresTransitions(manifest) && !capabilities.transitions) {
    issues.push({
      code: "backend.capability.transitions",
      message: "manifest requires transitions, but backend does not support them"
    });
  }

  const transitionInputs = backend.capabilities.transition_inputs ?? ["top_level", "clip_motion"];
  if ((manifest as Manifest & { transitions?: unknown }).transitions !== undefined
    && !transitionInputs.includes("top_level")) {
    issues.push({
      code: "backend.capability.transitions",
      message: "backend does not accept top-level manifest.transitions"
    });
  }
  if (manifest.clips.some((clip) => Boolean(clip.motion?.transition_to_next))
    && !transitionInputs.includes("clip_motion")) {
    issues.push({
      code: "backend.capability.transitions",
      message: "backend does not accept per-clip motion.transition_to_next cues"
    });
  }

  if (requiresAudioReactive(manifest) && !capabilities.audio_reactive) {
    issues.push({
      code: "backend.capability.audio_reactive",
      message: "manifest requires audio-reactive motion, but backend does not support it"
    });
  }

  if (manifest.presentation && !capabilities.presets.includes(manifest.presentation.preset)) {
    issues.push({
      code: "backend.capability.preset",
      message: `manifest requires presentation preset '${manifest.presentation.preset}', but backend does not support it`
    });
  }

  return issues.length > 0
    ? { ok: false, issues, backend }
    : { ok: true, issues: [], backend };
}

export function renderPreflightCommands(backend?: BackendCapabilities): BackendExternalCommand[] {
  if (!backend) return [];

  return backend.checks.render_preflight.map((check) => ({
    phase: "render_preflight",
    backend: backend.name,
    name: check.name,
    command: check.command
  }));
}

function requiresAudioMix(manifest: Manifest): boolean {
  return manifest.audio.bgm.length + manifest.audio.narration.length + manifest.audio.sfx.length > 0;
}

function requiresTransitions(manifest: Manifest): boolean {
  const value = (manifest as { transitions?: unknown }).transitions;
  return (Array.isArray(value) && value.length > 0)
    || manifest.clips.some((clip) => Boolean(clip.motion?.transition_to_next));
}

function requiresAudioReactive(manifest: Manifest): boolean {
  return manifest.clips.some((clip) => Boolean(clip.motion?.audio_reactive))
    || manifest.captions.some((caption) => Boolean(caption.visual?.motion?.audio_reactive));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
