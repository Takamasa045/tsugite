import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { validateManifest } from "../manifest/validate.js";
import {
  containedFile,
  isWithin,
  pathExists,
  portableRelative,
  sha256File,
  writeAtomic
} from "../platform/fsSafe.js";
import { projectSchema } from "../project/schema.js";
const SAFE_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

export type CharacterAddIssue = {
  code: string;
  message: string;
  path?: string;
};

export type ResolvedImage = {
  sourceId: string;
  sourcePath: string;
  sha256: string;
  extension: string;
};

export type ImagePlan = {
  imageIdMap: Record<string, string>;
  newImages: Array<Record<string, unknown>>;
  copies: Array<{ sourcePath: string; destName: string; sha256: string }>;
};

export type Fingerprint = {
  display_name: string;
  side: string;
  accent: string;
  poses: Array<[string, string]>;
  mouth_frames: string[] | null;
  source: string | null;
};

export type PreparedAdd = {
  configDir: string;
  manifestPath: string;
  manifestText: string;
  updatedManifestText: string;
  destinationAbsolute: string;
  copies: Array<{ sourcePath: string; destName: string; sha256: string }>;
};

export class CharacterAddError extends Error {
  constructor(readonly issue: CharacterAddIssue) {
    super(issue.message);
    this.name = "CharacterAddError";
  }
}

export function fail(code: string, message: string, path?: string): never {
  throw new CharacterAddError({ code, message, ...(path !== undefined ? { path } : {}) });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadTargetProject(configPathInput: string): Promise<{
  configDir: string;
  manifestPath: string;
  manifestText: string;
  manifestInput: Record<string, unknown>;
  manifest: NonNullable<ReturnType<typeof validateManifest>["manifest"]>;
}> {
  const configPath = await containedFile(
    resolve(configPathInput),
    dirname(resolve(configPathInput)),
    "character_add.config_missing"
  );
  const configText = await readFile(configPath, "utf8");
  let projectInput: unknown;
  try {
    projectInput = parse(configText);
  } catch (error) {
    fail(
      "character_add.project_schema",
      error instanceof Error ? error.message : "invalid project yaml",
      configPath
    );
  }
  const parsedProject = projectSchema.safeParse(projectInput);
  if (!parsedProject.success) {
    const issue = parsedProject.error.issues[0];
    fail("character_add.project_schema", issue?.message ?? "invalid project", issue?.path.join("."));
  }

  const configDir = dirname(configPath);
  const manifestCandidate = resolve(configDir, parsedProject.data.manifest);
  if (!isWithin(manifestCandidate, configDir)) {
    fail("character_add.manifest_escape", "project manifest must stay within the project directory", manifestCandidate);
  }
  if (!(await pathExists(manifestCandidate))) {
    fail("character_add.manifest_missing", "project manifest was not found", manifestCandidate);
  }
  const manifestPath = await containedFile(manifestCandidate, configDir, "character_add.manifest_escape");
  const manifestText = await readFile(manifestPath, "utf8");
  let manifestInput: unknown;
  try {
    manifestInput = JSON.parse(manifestText);
  } catch (error) {
    fail(
      "character_add.manifest_schema",
      error instanceof Error ? error.message : "invalid manifest json",
      manifestPath
    );
  }
  if (!isRecord(manifestInput)) {
    fail("character_add.manifest_schema", "manifest must be an object", manifestPath);
  }
  const currentManifest = validateManifest(manifestInput);
  if (!currentManifest.manifest) {
    fail(
      "character_add.manifest_schema",
      currentManifest.issues[0]?.message ?? "invalid manifest",
      currentManifest.issues[0]?.path
    );
  }

  return {
    configDir,
    manifestPath,
    manifestText,
    manifestInput,
    manifest: currentManifest.manifest
  };
}

export async function planImageBindings(input: {
  resolvedImages: Map<string, ResolvedImage>;
  targetManifest: NonNullable<ReturnType<typeof validateManifest>["manifest"]>;
  destinationAbsolute: string;
  configDir: string;
  manifestDir: string;
}): Promise<ImagePlan> {
  const existingById = new Map(input.targetManifest.images.map((image) => [image.id, image]));
  const usedIds = new Set(existingById.keys());
  const imageIdMap: Record<string, string> = {};
  const newImages: Array<Record<string, unknown>> = [];
  const copies: Array<{ sourcePath: string; destName: string; sha256: string }> = [];

  for (const [sourceId, resolved] of input.resolvedImages) {
    const existing = existingById.get(sourceId);
    if (existing) {
      const existingAbsolute = resolve(input.manifestDir, existing.src);
      let sameContent = false;
      if (
        existing.src
        && !existing.src.includes("\\")
        && !URL_LIKE.test(existing.src)
        && isWithin(existingAbsolute, input.configDir)
        && (await pathExists(existingAbsolute))
      ) {
        try {
          const contained = await containedFile(
            existingAbsolute,
            input.configDir,
            "character_add.target_image_missing"
          );
          sameContent = (await sha256File(contained)) === resolved.sha256;
        } catch {
          sameContent = false;
        }
      }

      if (sameContent) {
        imageIdMap[sourceId] = sourceId;
        continue;
      }
    }

    const targetId = existing || usedIds.has(sourceId)
      ? allocateImageId(sourceId, usedIds)
      : sourceId;
    usedIds.add(targetId);
    imageIdMap[sourceId] = targetId;

    const destName = `${safeFileStem(targetId)}${resolved.extension}`;
    const destAbsolute = join(input.destinationAbsolute, destName);
    const srcRelative = portableRelative(input.manifestDir, destAbsolute);
    newImages.push({
      id: targetId,
      src: srcRelative,
      alt: targetId
    });
    copies.push({ sourcePath: resolved.sourcePath, destName, sha256: resolved.sha256 });
  }

  return { imageIdMap, newImages, copies };
}

export async function commitAdd(
  prepared: PreparedAdd,
  beforeWrite?: () => Promise<void>
): Promise<void> {
  const writtenFiles: string[] = [];
  let destinationCreated = false;

  try {
    if (prepared.copies.length > 0) {
      await ensureRealDirectoryTree(prepared.destinationAbsolute, prepared.configDir);
      if (!(await pathExists(prepared.destinationAbsolute))) {
        const parent = dirname(prepared.destinationAbsolute);
        const staging = await mkdtemp(join(parent, ".character-add-"));
        try {
          for (const file of prepared.copies) {
            await copyFile(file.sourcePath, join(staging, file.destName));
          }
          await rename(staging, prepared.destinationAbsolute);
          destinationCreated = true;
          for (const file of prepared.copies) {
            writtenFiles.push(join(prepared.destinationAbsolute, file.destName));
          }
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
      } else {
        for (const file of prepared.copies) {
          const destPath = join(prepared.destinationAbsolute, file.destName);
          if (await pathExists(destPath)) {
            const existingHash = await sha256File(destPath);
            if (existingHash === file.sha256) continue;
            fail(
              "character_add.destination_conflict",
              `destination file already exists with different content: ${file.destName}`,
              destPath
            );
          }
          const temporary = join(
            prepared.destinationAbsolute,
            `.${file.destName}.${createHash("sha256").update(file.destName).digest("hex").slice(0, 8)}.tmp`
          );
          try {
            await copyFile(file.sourcePath, temporary);
            await rename(temporary, destPath);
            writtenFiles.push(destPath);
          } catch (error) {
            await rm(temporary, { force: true });
            throw error;
          }
        }
      }
    }

    if (beforeWrite) await beforeWrite();

    const latest = await readFile(prepared.manifestPath, "utf8");
    if (latest !== prepared.manifestText) {
      fail("character_add.target_changed", "target manifest changed during character add", prepared.manifestPath);
    }

    if (prepared.updatedManifestText !== prepared.manifestText) {
      await writeAtomic(prepared.manifestPath, prepared.updatedManifestText);
    }
  } catch (error) {
    await rollbackWrittenFiles(writtenFiles, destinationCreated ? prepared.destinationAbsolute : undefined);
    throw error;
  }
}

async function rollbackWrittenFiles(files: string[], destinationDir?: string): Promise<void> {
  for (const file of files) {
    await rm(file, { force: true }).catch(() => undefined);
  }
  if (destinationDir) {
    await rm(destinationDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensureRealDirectoryTree(destination: string, root: string): Promise<void> {
  const parent = dirname(destination);
  if (!isWithin(parent, root) && resolve(parent) !== resolve(root)) {
    fail("character_add.destination_escape", "character destination escapes the project", parent);
  }
  const segments = relative(root, parent).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        fail("character_add.destination_escape", "destination parents must be real directories", current);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
}

export function appendSpeakerAndImages(
  manifest: Record<string, unknown>,
  speaker: Record<string, unknown>,
  newImages: Array<Record<string, unknown>>
): Record<string, unknown> {
  const images = Array.isArray(manifest.images)
    ? [...(manifest.images as Array<Record<string, unknown>>)]
    : [];
  const speakers = Array.isArray(manifest.speakers)
    ? [...(manifest.speakers as Array<Record<string, unknown>>)]
    : [];
  return {
    ...manifest,
    images: [...images, ...newImages],
    speakers: [...speakers, speaker]
  };
}

export function buildFingerprint(
  raw: Record<string, unknown>,
  speaker: {
    display_name: string;
    side: string;
    accent: string;
    poses: Record<string, string>;
    mouth_frames?: string[];
  },
  hashOf: (imageId: string) => string
): Fingerprint {
  const poses = Object.entries(speaker.poses)
    .map(([name, imageId]) => [name, hashOf(imageId)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
  const mouth = speaker.mouth_frames
    ? speaker.mouth_frames.map((id) => hashOf(id))
    : null;
  const source = isRecord(raw.source) ? stableJson(raw.source) : null;
  return {
    display_name: speaker.display_name,
    side: speaker.side,
    accent: speaker.accent,
    poses,
    mouth_frames: mouth,
    source
  };
}

export function fingerprintsEqual(a: Fingerprint, b: Fingerprint): boolean {
  return (
    a.display_name === b.display_name
    && a.side === b.side
    && a.accent === b.accent
    && a.source === b.source
    && JSON.stringify(a.poses) === JSON.stringify(b.poses)
    && JSON.stringify(a.mouth_frames) === JSON.stringify(b.mouth_frames)
  );
}

export async function resolveTargetImageHashes(
  speaker: { poses: Record<string, string>; mouth_frames?: string[] },
  imageById: Map<string, { id: string; src: string }>,
  manifestDir: string,
  configDir: string
): Promise<Map<string, string> | null> {
  const ids = collectImageIds(speaker);
  const hashes = new Map<string, string>();
  for (const imageId of ids) {
    const image = imageById.get(imageId);
    if (!image) return null;
    if (!image.src || image.src.includes("\\") || URL_LIKE.test(image.src)) return null;
    const absolute = resolve(manifestDir, image.src);
    if (!isWithin(absolute, configDir)) return null;
    if (!(await pathExists(absolute))) return null;
    try {
      const contained = await containedFile(absolute, configDir, "character_add.target_image_missing");
      hashes.set(imageId, await sha256File(contained));
    } catch {
      return null;
    }
  }
  return hashes;
}

export function collectImageIds(speaker: {
  poses: Record<string, string>;
  mouth_frames?: string[];
}): string[] {
  const ids = new Set<string>();
  for (const imageId of Object.values(speaker.poses)) ids.add(imageId);
  for (const imageId of speaker.mouth_frames ?? []) ids.add(imageId);
  return [...ids];
}

export function findSpeakerRecord(
  manifest: Record<string, unknown>,
  speakerId: string
): Record<string, unknown> | undefined {
  if (!Array.isArray(manifest.speakers)) return undefined;
  for (const entry of manifest.speakers) {
    if (isRecord(entry) && entry.id === speakerId) return entry;
  }
  return undefined;
}

export function characterDirName(speakerId: string): string {
  if (SAFE_DIR_NAME.test(speakerId)) return speakerId;
  return `char-${createHash("sha256").update(speakerId).digest("hex").slice(0, 8)}`;
}

function allocateImageId(preferred: string, used: Set<string>): string {
  if (!used.has(preferred)) return preferred;
  let n = 2;
  while (used.has(`${preferred}-${n}`)) n += 1;
  return `${preferred}-${n}`;
}

function safeFileStem(id: string): string {
  // Keep readable stems only when the id is already a safe filename token.
  // Collapsing arbitrary characters (e.g. hero@1 vs hero#1 → hero-1) would
  // make distinct image ids fight over the same destination path.
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return id;
  return `img-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}
