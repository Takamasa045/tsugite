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
      preview: z.enum(["html-css-approximation", "specification-only"])
    })
    .optional(),
  capabilities: z.object({
    captions: z.boolean(),
    transitions: z.boolean(),
    audio_mix: z.boolean(),
    vertical: z.boolean(),
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
  backend: BackendCapabilities
): Result<{ backend: BackendCapabilities }> {
  const issues: Issue[] = [];
  const capabilities = backend.capabilities;

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

  if (!capabilities.fps.includes(manifest.meta.fps)) {
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
  return Array.isArray(value) && value.length > 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
