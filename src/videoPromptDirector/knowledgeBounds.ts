/**
 * Machine-check model prompt profiles against repo knowledge / constraint primary sources.
 * Does not vendor license-unknown third-party bodies; only structural bounds comparison.
 */

import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModelPromptProfile } from "./modelProfile.js";

export const MODEL_PROFILE_KNOWLEDGE_BOUNDS_CODE = "VPD-E005";
export const MODEL_PROFILE_KNOWLEDGE_PIN_CODE = "VPD-E006";

export type KnowledgeModelLimits = {
  modelId: string;
  durationMin?: number;
  durationMax?: number;
  resolutions?: string[];
  aspects?: string[];
  inputModes?: string[];
};

export type KnowledgeBoundsResult =
  | { ok: true; knowledge: KnowledgeModelLimits }
  | { ok: false; code: string; message: string };

export type ResolveKnowledgePinOptions = {
  /** Repository root that owns the `knowledge/` directory. Defaults to process.cwd(). */
  repoRoot?: string;
};

/**
 * Parse source.pin of the form:
 *   path/to/file.yaml#modelId@version
 *   path/to/file.yaml#modelId
 *   path/to/file.yaml@version   (model id from knowledge_model_id / profile id)
 */
export function parseModelProfileSourcePin(pin: string): {
  path: string;
  modelId?: string;
  version?: string;
} {
  const hashIndex = pin.indexOf("#");
  if (hashIndex < 0) {
    // path@version (no model fragment)
    const atIndex = pin.lastIndexOf("@");
    if (atIndex > 0 && pin.includes("/") && !pin.slice(atIndex + 1).includes("/")) {
      return {
        path: pin.slice(0, atIndex),
        version: pin.slice(atIndex + 1) || undefined
      };
    }
    return { path: pin };
  }
  const path = pin.slice(0, hashIndex);
  const fragment = pin.slice(hashIndex + 1);
  const atIndex = fragment.indexOf("@");
  if (atIndex < 0) {
    return { path, modelId: fragment || undefined };
  }
  return {
    path,
    modelId: fragment.slice(0, atIndex) || undefined,
    version: fragment.slice(atIndex + 1) || undefined
  };
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

/**
 * Lexically pin a source.pin file path under `<repoRoot>/knowledge`.
 * Rejects absolute paths and `..` traversal that leave the knowledge root.
 * Does not follow symlinks — call resolveKnowledgePinPathForRead for that.
 */
export function resolveKnowledgePinPath(
  pinPath: string,
  options?: ResolveKnowledgePinOptions
): { ok: true; absolutePath: string; knowledgeRoot: string; repoRoot: string }
  | { ok: false; code: string; message: string } {
  const repoRoot = resolve(options?.repoRoot ?? process.cwd());
  const knowledgeRoot = resolve(repoRoot, "knowledge");

  if (!pinPath || pinPath.trim() === "") {
    return {
      ok: false,
      code: MODEL_PROFILE_KNOWLEDGE_PIN_CODE,
      message: "source.pin path is empty"
    };
  }
  if (isAbsolute(pinPath)) {
    return {
      ok: false,
      code: MODEL_PROFILE_KNOWLEDGE_PIN_CODE,
      message:
        `source.pin must be a relative path under knowledge/ (got absolute '${pinPath}')`
    };
  }

  // Normalize and require the resolved path to stay under knowledge root.
  const absolutePath = resolve(repoRoot, pinPath);
  if (!isPathWithinRoot(knowledgeRoot, absolutePath)) {
    return {
      ok: false,
      code: MODEL_PROFILE_KNOWLEDGE_PIN_CODE,
      message:
        `source.pin must stay under the repo knowledge/ root after resolve `
        + `(got '${pinPath}')`
    };
  }

  return { ok: true, absolutePath, knowledgeRoot, repoRoot };
}

/**
 * Resolve pin path and ensure realpath (symlink target) remains under knowledge root.
 * Call before any read of the knowledge primary source.
 */
export async function resolveKnowledgePinPathForRead(
  pinPath: string,
  options?: ResolveKnowledgePinOptions
): Promise<
  | { ok: true; absolutePath: string; realPath: string; knowledgeRoot: string }
  | { ok: false; code: string; message: string }
> {
  const lexical = resolveKnowledgePinPath(pinPath, options);
  if (!lexical.ok) return lexical;

  try {
    await access(lexical.absolutePath);
  } catch {
    return {
      ok: false,
      code: MODEL_PROFILE_KNOWLEDGE_PIN_CODE,
      message: `knowledge source path not found: ${pinPath}`
    };
  }

  try {
    const [realKnowledgeRoot, realPath] = await Promise.all([
      realpath(lexical.knowledgeRoot),
      realpath(lexical.absolutePath)
    ]);
    if (!isPathWithinRoot(realKnowledgeRoot, realPath)) {
      return {
        ok: false,
        code: MODEL_PROFILE_KNOWLEDGE_PIN_CODE,
        message:
          `source.pin realpath escaped the repo knowledge/ root `
          + `(pin '${pinPath}')`
      };
    }
    return {
      ok: true,
      absolutePath: lexical.absolutePath,
      realPath,
      knowledgeRoot: lexical.knowledgeRoot
    };
  } catch {
    return {
      ok: false,
      code: MODEL_PROFILE_KNOWLEDGE_PIN_CODE,
      message: `knowledge source path not readable: ${pinPath}`
    };
  }
}

/**
 * Load knowledge video-prompt-guide model limits for structural comparison.
 */
export async function loadKnowledgeModelLimits(
  pin: string,
  knowledgeModelId?: string,
  options?: ResolveKnowledgePinOptions
): Promise<KnowledgeBoundsResult> {
  const parsed = parseModelProfileSourcePin(pin);
  const resolved = await resolveKnowledgePinPathForRead(parsed.path, options);
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      message: resolved.message
    };
  }

  const text = await readFile(resolved.realPath, "utf8");
  const doc = parseYaml(text) as {
    models?: Array<{
      id: string;
      aliases?: string[];
      input_modes?: string[];
      limits?: {
        duration_seconds?: { min?: number; max?: number };
        resolutions?: string[];
        text_to_video_aspect_ratios?: string[];
      };
    }>;
  };

  const modelId = knowledgeModelId ?? parsed.modelId;
  if (!modelId) {
    return {
      ok: false,
      code: MODEL_PROFILE_KNOWLEDGE_PIN_CODE,
      message: `source.pin '${pin}' does not identify a knowledge model id`
    };
  }

  const models = doc.models ?? [];
  const match = models.find(
    (item) => item.id === modelId || (item.aliases ?? []).includes(modelId)
  );
  if (!match) {
    return {
      ok: false,
      code: MODEL_PROFILE_KNOWLEDGE_PIN_CODE,
      message: `knowledge model '${modelId}' not found in ${parsed.path}`
    };
  }

  return {
    ok: true,
    knowledge: {
      modelId: match.id,
      durationMin: match.limits?.duration_seconds?.min,
      durationMax: match.limits?.duration_seconds?.max,
      resolutions: match.limits?.resolutions,
      aspects: match.limits?.text_to_video_aspect_ratios,
      inputModes: match.input_modes
    }
  };
}

/**
 * Profile must not exceed knowledge limits (duration max, resolution set).
 * Profile may be stricter (subset) than knowledge.
 */
export function assertProfileWithinKnowledgeBounds(
  profile: ModelPromptProfile,
  knowledge: KnowledgeModelLimits
): KnowledgeBoundsResult {
  if (knowledge.durationMax !== undefined) {
    const maxDuration = Math.max(...profile.durations);
    if (maxDuration > knowledge.durationMax) {
      return {
        ok: false,
        code: MODEL_PROFILE_KNOWLEDGE_BOUNDS_CODE,
        message:
          `model profile '${profile.id}' duration max ${maxDuration} exceeds `
          + `knowledge '${knowledge.modelId}' max ${knowledge.durationMax}`
      };
    }
  }
  if (knowledge.durationMin !== undefined) {
    const minDuration = Math.min(...profile.durations);
    if (minDuration < knowledge.durationMin) {
      return {
        ok: false,
        code: MODEL_PROFILE_KNOWLEDGE_BOUNDS_CODE,
        message:
          `model profile '${profile.id}' duration min ${minDuration} is below `
          + `knowledge '${knowledge.modelId}' min ${knowledge.durationMin}`
      };
    }
  }
  if (knowledge.resolutions && knowledge.resolutions.length > 0) {
    const allowed = new Set(knowledge.resolutions.map((item) => item.toLowerCase()));
    for (const resolution of profile.resolutions) {
      if (!allowed.has(resolution.toLowerCase())) {
        return {
          ok: false,
          code: MODEL_PROFILE_KNOWLEDGE_BOUNDS_CODE,
          message:
            `model profile '${profile.id}' resolution '${resolution}' is outside `
            + `knowledge '${knowledge.modelId}' resolutions [${knowledge.resolutions.join(", ")}]`
        };
      }
    }
  }
  return { ok: true, knowledge };
}

/**
 * Full pin → knowledge load → structural bounds check for a model profile.
 */
export async function verifyModelProfileAgainstKnowledge(
  profile: ModelPromptProfile,
  options?: ResolveKnowledgePinOptions
): Promise<KnowledgeBoundsResult> {
  const knowledgeModelId =
    profile.knowledge_model_id
    ?? parseModelProfileSourcePin(profile.source.pin).modelId
    ?? profile.id;
  const loaded = await loadKnowledgeModelLimits(
    profile.source.pin,
    knowledgeModelId,
    options
  );
  if (!loaded.ok) return loaded;
  return assertProfileWithinKnowledgeBounds(profile, loaded.knowledge);
}
