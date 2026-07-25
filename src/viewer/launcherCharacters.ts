import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { addCharacterToProject, type AddCharacterResult } from "../characters/addToProject.js";
import { aggregateCharacters, isReferenceAssetSource } from "../characters/aggregate.js";
import { scanCharacterSources } from "../characters/scan.js";
import type {
  CharacterPoseRef,
  CharacterProvenance,
  CharacterSourceRef,
  ScanWarning
} from "../characters/types.js";

/** Wire pose shown to the launcher UI. */
export type LauncherCharacterPose = {
  name: string;
  imageId: string;
  /** Opaque deterministic key for GET /character-image/:key (present when resolvable). */
  imageKey?: string;
  missing: boolean;
};

/** Concrete source occurrence inside an aggregated character group. */
export type LauncherCharacterSource = {
  sourceKey: string;
  kind: "project" | "template";
  label: string;
  speakerId: string;
  side: "left" | "right";
  accent: string;
  /** Template sources and read-only shelves (e.g. other worktrees). */
  readOnly: boolean;
  poses: LauncherCharacterPose[];
  mouthFrames?: LauncherCharacterPose[];
  /** False when any pose/mouth frame is missing, or there are no poses. */
  canUse: boolean;
  /**
   * Storyboard / review frames stored as speakers (not a portrait character).
   * Still listed so authors can inspect the source project.
   */
  assetRole: "character" | "reference";
  provenance?: CharacterProvenance;
};

/** Aggregated gallery card payload for GET /api/characters. */
export type LauncherCharacter = {
  groupKey: string;
  id: string;
  displayName: string;
  poseCount: number;
  hasMouthFrames: boolean;
  provenance?: CharacterProvenance;
  sources: LauncherCharacterSource[];
  representativeImageKey?: string;
  /** True when every usable representative path is a non-character reference asset. */
  referenceOnly: boolean;
};

/** Server-side image resolution for /character-image/:key (not sent to the client). */
export type CharacterImageLocation = {
  rootDir: string;
  relativePath: string;
  readOnly: boolean;
};

/** Server-side lookup for POST /api/characters/use. */
export type CharacterSourceLocation = {
  sourceKey: string;
  speakerId: string;
  rootDir: string;
  manifestPath: string;
  canUse: boolean;
  readOnly: boolean;
};

export type LauncherCharacterCatalog = {
  characters: LauncherCharacter[];
  images: Map<string, CharacterImageLocation>;
  sourcesByKey: Map<string, CharacterSourceLocation>;
  warnings: ScanWarning[];
};

export type LauncherProjectDirectoryInput = {
  path: string;
  readOnly: boolean;
};

export type BuildLauncherCharacterCatalogOptions = {
  /** Project shelves. Strings are treated as writable; objects carry readOnly. */
  projectDirectories: Array<string | LauncherProjectDirectoryInput>;
  templatesDir?: string;
};

export type CharacterUseInput = {
  sourceKey: string;
  speakerId: string;
  targetConfigPath: string;
  catalog: LauncherCharacterCatalog;
};

/**
 * Deterministic 32-hex image key from rootDir + relative path.
 * Not secret — only needs to be stable and collision-resistant enough for one process.
 */
export function characterImageKey(rootDir: string, relativePath: string): string {
  return createHash("sha256")
    .update(`${portablePath(rootDir)}\0${portablePath(relativePath)}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Scan + aggregate project/template speakers into a launcher-facing catalog.
 * projectDirectories is caller-owned (launcher does not export its internal list).
 */
export async function buildLauncherCharacterCatalog(
  options: BuildLauncherCharacterCatalogOptions
): Promise<LauncherCharacterCatalog> {
  const shelves = options.projectDirectories.map(normalizeShelfInput);
  const scan = await scanCharacterSources({
    projectDirectories: shelves.map((shelf) => shelf.path),
    ...(options.templatesDir !== undefined ? { templatesDir: options.templatesDir } : {})
  });

  const images = new Map<string, CharacterImageLocation>();
  const sourcesByKey = new Map<string, CharacterSourceLocation>();
  const aggregated = aggregateCharacters(scan.sources);

  const characters = aggregated.map((group) => {
    const sources = group.sources.map((source) =>
      toWireSource(source, shelves, images, sourcesByKey)
    );
    const representativeImageKey = findRepresentativeImageKey(sources);
    const referenceOnly = sources.length > 0 && sources.every((source) => source.assetRole === "reference");
    return {
      groupKey: group.groupKey,
      id: group.id,
      displayName: group.displayName,
      poseCount: group.poseCount,
      hasMouthFrames: group.hasMouthFrames,
      ...(group.provenance ? { provenance: group.provenance } : {}),
      sources,
      referenceOnly,
      ...(representativeImageKey ? { representativeImageKey } : {})
    } satisfies LauncherCharacter;
  });

  return {
    characters,
    images,
    sourcesByKey,
    warnings: scan.warnings
  };
}

/**
 * Copy a catalog source speaker into a target project.
 * Caller must enforce mutation auth, readOnly target, and project identity.
 */
export async function useCharacterFromCatalog(
  input: CharacterUseInput
): Promise<AddCharacterResult | { ok: false; issue: { code: string; message: string } }> {
  const location = input.catalog.sourcesByKey.get(input.sourceKey);
  if (!location) {
    return {
      ok: false,
      issue: {
        code: "character_use.source_not_found",
        message: "Character source was not found in the gallery catalog"
      }
    };
  }
  if (location.speakerId !== input.speakerId) {
    return {
      ok: false,
      issue: {
        code: "character_use.speaker_mismatch",
        message: "speakerId does not match the sourceKey"
      }
    };
  }
  if (!location.canUse) {
    return {
      ok: false,
      issue: {
        code: "character_add.missing_pose",
        message: "Character source has missing pose or mouth-frame images and cannot be used"
      }
    };
  }

  return addCharacterToProject({
    sourceManifestPath: location.manifestPath,
    sourceRootDir: location.rootDir,
    speakerId: location.speakerId,
    targetConfigPath: input.targetConfigPath
  });
}

function toWireSource(
  source: CharacterSourceRef,
  shelves: LauncherProjectDirectoryInput[],
  images: Map<string, CharacterImageLocation>,
  sourcesByKey: Map<string, CharacterSourceLocation>
): LauncherCharacterSource {
  const readOnly = source.kind === "template" || isUnderReadOnlyShelf(source.rootDir, shelves);
  const assetRole = isReferenceAssetSource(source) ? "reference" : "character";
  const poses = wirePoses(source.poses, source.rootDir, readOnly, images);
  const mouthFrames = source.mouthFrames
    ? wirePoses(source.mouthFrames, source.rootDir, readOnly, images)
    : undefined;
  const canUse =
    poses.length > 0
    && poses.every((pose) => !pose.missing)
    && (mouthFrames === undefined || mouthFrames.every((frame) => !frame.missing));

  sourcesByKey.set(source.sourceKey, {
    sourceKey: source.sourceKey,
    speakerId: source.id,
    rootDir: source.rootDir,
    manifestPath: source.manifestPath,
    canUse,
    readOnly
  });

  return {
    sourceKey: source.sourceKey,
    kind: source.kind,
    label: source.label,
    speakerId: source.id,
    side: source.side,
    accent: source.accent,
    readOnly,
    poses,
    ...(mouthFrames ? { mouthFrames } : {}),
    canUse,
    assetRole,
    ...(source.provenance ? { provenance: source.provenance } : {})
  };
}

function wirePoses(
  poses: CharacterPoseRef[],
  rootDir: string,
  readOnly: boolean,
  images: Map<string, CharacterImageLocation>
): LauncherCharacterPose[] {
  return poses.map((pose) => {
    if (pose.missing || !pose.imagePath) {
      return { name: pose.name, imageId: pose.imageId, missing: true };
    }
    const imageKey = characterImageKey(rootDir, pose.imagePath);
    if (!images.has(imageKey)) {
      images.set(imageKey, {
        rootDir,
        relativePath: pose.imagePath,
        readOnly
      });
    }
    return {
      name: pose.name,
      imageId: pose.imageId,
      imageKey,
      missing: false
    };
  });
}

function findRepresentativeImageKey(sources: LauncherCharacterSource[]): string | undefined {
  const ordered = [
    ...sources.filter((source) => source.assetRole === "character"),
    ...sources.filter((source) => source.assetRole !== "character")
  ];
  for (const source of ordered) {
    const preferred =
      source.poses.find((pose) => pose.name === "neutral" && pose.imageKey && !pose.missing)
      ?? source.poses.find((pose) => pose.imageKey && !pose.missing);
    if (preferred?.imageKey) return preferred.imageKey;
  }
  return undefined;
}

function normalizeShelfInput(
  input: string | LauncherProjectDirectoryInput
): LauncherProjectDirectoryInput {
  if (typeof input === "string") {
    return { path: resolve(input), readOnly: false };
  }
  return { path: resolve(input.path), readOnly: input.readOnly };
}

function isUnderReadOnlyShelf(
  rootDir: string,
  shelves: LauncherProjectDirectoryInput[]
): boolean {
  const portableRoot = portablePath(resolve(rootDir));
  for (const shelf of shelves) {
    if (!shelf.readOnly) continue;
    const portableShelf = portablePath(resolve(shelf.path));
    if (
      portableRoot === portableShelf
      || portableRoot.startsWith(`${portableShelf}/`)
    ) {
      return true;
    }
  }
  return false;
}

function portablePath(path: string): string {
  return path.split("\\").join("/");
}
