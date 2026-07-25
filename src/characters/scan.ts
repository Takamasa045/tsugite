import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readJsonFile } from "../io.js";
import type { Manifest } from "../manifest/schema.js";
import { validateManifest } from "../manifest/validate.js";
import { isWithin, pathExists, portableRelative } from "../platform/fsSafe.js";
import { loadProject } from "../project/loadProject.js";
import type {
  CharacterPoseRef,
  CharacterProvenance,
  CharacterSourceRef,
  ScanCharacterSourcesOptions,
  ScanResult,
  ScanWarning
} from "./types.js";

const SKIP_CODE = "characters.scan_skipped";
const POSE_ESCAPE_CODE = "characters.pose_escape";

/**
 * Scan project shelves and optional templates for speaker character sources.
 * Callers pass directory paths; this module does not export launcher discovery.
 */
export async function scanCharacterSources(
  options: ScanCharacterSourcesOptions
): Promise<ScanResult> {
  const sources: CharacterSourceRef[] = [];
  const warnings: ScanWarning[] = [];
  const seenManifestIdentity = new Set<string>();

  for (const shelf of options.projectDirectories) {
    await scanProjectShelf(shelf, sources, warnings, seenManifestIdentity);
  }

  if (options.templatesDir) {
    await scanTemplatesDir(options.templatesDir, sources, warnings, seenManifestIdentity);
  }

  return { sources, warnings };
}

async function scanProjectShelf(
  shelf: string,
  sources: CharacterSourceRef[],
  warnings: ScanWarning[],
  seenManifestIdentity: Set<string>
): Promise<void> {
  const shelfPath = resolve(shelf);
  let entries;
  try {
    entries = await readdir(shelfPath, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    warnings.push({
      code: SKIP_CODE,
      message: `failed to read project shelf: ${messageOf(error)}`,
      path: portablePath(shelfPath)
    });
    return;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const projectDir = join(shelfPath, entry.name);
    const configPath = join(projectDir, "project.yaml");
    if (!(await pathExists(configPath))) continue;

    try {
      const project = await loadProject(configPath);
      const rootDir = resolve(projectDir);
      const manifestPath = resolve(rootDir, project.manifest);

      // Soft containment: allow project.manifest starting with "../" (asset-root parent),
      // but reject other escapes.
      if (!isWithin(manifestPath, rootDir) && !project.manifest.startsWith("../")) {
        warnings.push({
          code: SKIP_CODE,
          message: "project manifest path escapes the project directory",
          path: portablePath(manifestPath)
        });
        continue;
      }

      if (await isDuplicateManifest(manifestPath, seenManifestIdentity)) continue;

      const extracted = await extractFromManifest({
        kind: "project",
        label: project.slug || entry.name,
        manifestPath,
        rootDir,
        assetRoot: project.manifest.startsWith("../") ? resolve(rootDir, "..") : rootDir
      });
      sources.push(...extracted.sources);
      warnings.push(...extracted.warnings);
    } catch (error) {
      warnings.push({
        code: SKIP_CODE,
        message: `skipped project: ${messageOf(error)}`,
        path: portablePath(configPath)
      });
    }
  }
}

async function scanTemplatesDir(
  templatesDir: string,
  sources: CharacterSourceRef[],
  warnings: ScanWarning[],
  seenManifestIdentity: Set<string>
): Promise<void> {
  const root = resolve(templatesDir);
  let templateEntries;
  try {
    templateEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    warnings.push({
      code: SKIP_CODE,
      message: `failed to read templates directory: ${messageOf(error)}`,
      path: portablePath(root)
    });
    return;
  }

  for (const templateEntry of templateEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!templateEntry.isDirectory()) continue;
    const templateId = templateEntry.name;
    const distDir = join(root, templateId, "dist");
    let variantEntries;
    try {
      variantEntries = await readdir(distDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) continue;
      warnings.push({
        code: SKIP_CODE,
        message: `failed to read template dist: ${messageOf(error)}`,
        path: portablePath(distDir)
      });
      continue;
    }

    for (const variantEntry of variantEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!variantEntry.isDirectory()) continue;
      const variantId = variantEntry.name;
      const variantRoot = resolve(distDir, variantId);
      const manifestPath = join(variantRoot, "manifest.json");
      if (!(await pathExists(manifestPath))) continue;
      if (await isDuplicateManifest(manifestPath, seenManifestIdentity)) continue;

      const extracted = await extractFromManifest({
        kind: "template",
        label: `${templateId}/${variantId}`,
        manifestPath,
        rootDir: variantRoot,
        assetRoot: variantRoot
      });
      sources.push(...extracted.sources);
      warnings.push(...extracted.warnings);
    }
  }
}

type ExtractContext = {
  kind: "project" | "template";
  label: string;
  manifestPath: string;
  rootDir: string;
  assetRoot: string;
};

async function extractFromManifest(
  context: ExtractContext
): Promise<{ sources: CharacterSourceRef[]; warnings: ScanWarning[] }> {
  const warnings: ScanWarning[] = [];
  const portableManifest = portablePath(context.manifestPath);

  let input: unknown;
  try {
    input = await readJsonFile(context.manifestPath);
  } catch (error) {
    warnings.push({
      code: SKIP_CODE,
      message: `failed to read manifest: ${messageOf(error)}`,
      path: portableManifest
    });
    return { sources: [], warnings };
  }

  const validation = validateManifest(input);
  if (!validation.manifest) {
    const detail = validation.issues[0]?.message ?? "invalid manifest";
    warnings.push({
      code: SKIP_CODE,
      message: `skipped invalid manifest: ${detail}`,
      path: portableManifest
    });
    return { sources: [], warnings };
  }

  let manifestModifiedAtMs = 0;
  try {
    manifestModifiedAtMs = (await stat(context.manifestPath)).mtimeMs;
  } catch {
    manifestModifiedAtMs = 0;
  }

  const manifest = validation.manifest;
  const imageById = new Map(manifest.images.map((image) => [image.id, image]));
  const manifestDir = dirname(context.manifestPath);
  const sources: CharacterSourceRef[] = [];

  for (const speaker of manifest.speakers) {
    const poses: CharacterPoseRef[] = [];
    for (const [poseName, imageId] of Object.entries(speaker.poses)) {
      poses.push(
        await resolvePoseImage({
          name: poseName,
          imageId,
          imageById,
          manifestDir,
          assetRoot: context.assetRoot,
          warnings,
          warningPath: `${portableManifest}#speakers.${speaker.id}.poses.${poseName}`
        })
      );
    }

    let mouthFrames: CharacterPoseRef[] | undefined;
    if (speaker.mouth_frames && speaker.mouth_frames.length > 0) {
      mouthFrames = [];
      for (const [index, imageId] of speaker.mouth_frames.entries()) {
        mouthFrames.push(
          await resolvePoseImage({
            name: String(index),
            imageId,
            imageById,
            manifestDir,
            assetRoot: context.assetRoot,
            warnings,
            warningPath: `${portableManifest}#speakers.${speaker.id}.mouth_frames.${index}`
          })
        );
      }
    }

    const provenance = extractProvenance(speaker);
    sources.push({
      sourceKey: makeSourceKey(context.kind, portableManifest, speaker.id),
      kind: context.kind,
      label: context.label,
      manifestPath: portableManifest,
      // Containment/serving root: assetRoot (may be parent for soft-containment manifests).
      rootDir: portablePath(context.assetRoot),
      id: speaker.id,
      displayName: speaker.display_name,
      side: speaker.side,
      accent: speaker.accent,
      poses,
      ...(mouthFrames ? { mouthFrames } : {}),
      ...(provenance ? { provenance } : {}),
      manifestModifiedAtMs
    });
  }

  return { sources, warnings };
}

async function resolvePoseImage(options: {
  name: string;
  imageId: string;
  imageById: Map<string, Manifest["images"][number]>;
  manifestDir: string;
  assetRoot: string;
  warnings: ScanWarning[];
  warningPath: string;
}): Promise<CharacterPoseRef> {
  const image = options.imageById.get(options.imageId);
  if (!image) {
    return { name: options.name, imageId: options.imageId, missing: true };
  }

  const src = image.src;
  if (!src || src.includes("\\") || /^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
    return { name: options.name, imageId: options.imageId, missing: true };
  }

  // Hot path: resolve + isWithin without per-file realpath (Windows-friendly).
  const absolute = resolve(options.manifestDir, src);
  if (!isWithin(absolute, options.assetRoot)) {
    options.warnings.push({
      code: POSE_ESCAPE_CODE,
      message: `pose image escapes asset root: ${src}`,
      path: options.warningPath
    });
    return { name: options.name, imageId: options.imageId, missing: true };
  }

  if (!(await pathExists(absolute))) {
    return { name: options.name, imageId: options.imageId, missing: true };
  }

  return {
    name: options.name,
    imageId: options.imageId,
    // Relative to assetRoot so soft-containment never emits ".." segments that
    // openContainedStaticFile rejects.
    imagePath: portableRelative(options.assetRoot, absolute),
    missing: false
  };
}

/**
 * First-wins dedup by realpath when available, else by resolved path.
 * realpath is used only for manifest identity, not for every pose file.
 */
async function isDuplicateManifest(
  manifestPath: string,
  seen: Set<string>
): Promise<boolean> {
  let identity = portablePath(resolve(manifestPath));
  try {
    identity = portablePath(await realpath(manifestPath));
  } catch {
    // keep resolved path
  }
  if (seen.has(identity)) return true;
  seen.add(identity);
  return false;
}

export function makeSourceKey(
  kind: "project" | "template",
  portableManifestPath: string,
  speakerId: string
): string {
  return `${kind}\0${portableManifestPath}\0${speakerId}`;
}

function extractProvenance(speaker: Manifest["speakers"][number]): CharacterProvenance | undefined {
  const record = speaker as Record<string, unknown>;
  const source = record.source;
  if (!isRecord(source) || typeof source.kind !== "string" || source.kind.length === 0) {
    return undefined;
  }
  return { ...source, kind: source.kind } as CharacterProvenance;
}

function portablePath(path: string): string {
  return resolve(path).split("\\").join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
