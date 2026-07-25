import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { validateManifest } from "../manifest/validate.js";
import {
  SafePathError,
  containedFile,
  isWithin,
  portableRelative,
  sha256File
} from "../platform/fsSafe.js";
import {
  CharacterAddError,
  appendSpeakerAndImages,
  buildFingerprint,
  characterDirName,
  collectImageIds,
  commitAdd,
  fail,
  findSpeakerRecord,
  fingerprintsEqual,
  isRecord,
  loadTargetProject,
  planImageBindings,
  resolveTargetImageHashes,
  type ResolvedImage,
  URL_LIKE
} from "./addToProjectSupport.js";

export type AddCharacterInput = {
  sourceManifestPath: string;
  sourceRootDir: string;
  speakerId: string;
  targetConfigPath: string;
  /** @internal test hook: runs after media staging, before the target-changed re-check / manifest write */
  _beforeWrite?: () => Promise<void>;
};

export type AddCharacterIssue = {
  code: string;
  message: string;
  path?: string;
};

export type AddCharacterResult =
  | {
      ok: true;
      added: true;
      alreadyPresent: false;
      speakerId: string;
      destinationDir: string;
      imageIdMap: Record<string, string>;
      manifestPath: string;
    }
  | {
      ok: true;
      added: false;
      alreadyPresent: true;
      speakerId: string;
      manifestPath: string;
    }
  | {
      ok: false;
      issue: AddCharacterIssue;
    };

/**
 * Copy a speaker (poses + mouth frames + images) from a source manifest into a
 * target project. Idempotent on exact match; never overwrites a conflicting speaker.
 */
export async function addCharacterToProject(
  input: AddCharacterInput
): Promise<AddCharacterResult> {
  try {
    return await addCharacterToProjectImpl(input);
  } catch (error) {
    if (error instanceof CharacterAddError) {
      return { ok: false, issue: error.issue };
    }
    if (error instanceof SafePathError) {
      return {
        ok: false,
        issue: {
          code: error.code.startsWith("character_add.") ? error.code : "character_add.path",
          message: error.message,
          ...(error.path !== undefined ? { path: error.path } : {})
        }
      };
    }
    return {
      ok: false,
      issue: {
        code: "character_add.failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function addCharacterToProjectImpl(
  input: AddCharacterInput
): Promise<AddCharacterResult> {
  // realpath so isWithin matches containedFile (macOS /var vs /private/var).
  const sourceRoot = await realpath(resolve(input.sourceRootDir));
  const sourceManifestPath = await containedFile(
    resolve(input.sourceManifestPath),
    sourceRoot,
    "character_add.source_missing"
  );

  const sourceManifestText = await readFile(sourceManifestPath, "utf8");
  let sourceInput: unknown;
  try {
    sourceInput = JSON.parse(sourceManifestText);
  } catch (error) {
    fail(
      "character_add.source_manifest_invalid",
      error instanceof Error ? error.message : String(error),
      sourceManifestPath
    );
  }
  if (!isRecord(sourceInput)) {
    fail("character_add.source_manifest_invalid", "source manifest must be an object", sourceManifestPath);
  }

  const sourceValidation = validateManifest(sourceInput);
  if (!sourceValidation.manifest) {
    fail(
      "character_add.source_manifest_schema",
      sourceValidation.issues[0]?.message ?? "invalid source manifest",
      sourceValidation.issues[0]?.path
    );
  }
  const sourceManifest = sourceValidation.manifest;
  const sourceSpeakerRaw = findSpeakerRecord(sourceInput, input.speakerId);
  const sourceSpeaker = sourceManifest.speakers.find((speaker) => speaker.id === input.speakerId);
  if (!sourceSpeaker || !sourceSpeakerRaw) {
    fail("character_add.speaker_missing", `speaker '${input.speakerId}' was not found in source`, input.speakerId);
  }

  const poseEntries = Object.entries(sourceSpeaker.poses);
  if (poseEntries.length === 0) {
    fail("character_add.missing_pose", `speaker '${input.speakerId}' has no poses`, input.speakerId);
  }

  const imageIds = collectImageIds(sourceSpeaker);
  const sourceImageById = new Map(sourceManifest.images.map((image) => [image.id, image]));
  const sourceManifestDir = dirname(sourceManifestPath);
  const resolvedImages = new Map<string, ResolvedImage>();

  for (const imageId of imageIds) {
    const image = sourceImageById.get(imageId);
    if (!image) {
      fail("character_add.missing_pose", `speaker references unknown image '${imageId}'`, imageId);
    }
    const src = image.src;
    if (!src || src.includes("\\") || URL_LIKE.test(src)) {
      fail("character_add.missing_pose", `pose image src is not a local relative path: ${src ?? ""}`, imageId);
    }
    const absolute = resolve(sourceManifestDir, src);
    if (!isWithin(absolute, sourceRoot)) {
      fail("character_add.source_image_escape", "source image escapes source root", absolute);
    }
    let contained: string;
    try {
      contained = await containedFile(absolute, sourceRoot, "character_add.source_image_missing");
    } catch (error) {
      if (error instanceof SafePathError) {
        fail("character_add.source_image_missing", error.message, absolute);
      }
      throw error;
    }
    resolvedImages.set(imageId, {
      sourceId: imageId,
      sourcePath: contained,
      sha256: await sha256File(contained),
      extension: extname(contained).toLowerCase() || ".png"
    });
  }

  const sourceFingerprint = buildFingerprint(sourceSpeakerRaw, sourceSpeaker, (id) => {
    const resolved = resolvedImages.get(id);
    if (!resolved) fail("character_add.missing_pose", `missing image for fingerprint '${id}'`, id);
    return resolved.sha256;
  });

  const preparedTarget = await loadTargetProject(input.targetConfigPath);
  const targetInput = preparedTarget.manifestInput;
  const targetManifest = preparedTarget.manifest;
  const existingSpeakerRaw = findSpeakerRecord(targetInput, input.speakerId);
  const existingSpeaker = targetManifest.speakers.find((speaker) => speaker.id === input.speakerId);

  if (existingSpeaker && existingSpeakerRaw) {
    const targetImageById = new Map(targetManifest.images.map((image) => [image.id, image]));
    const targetHashes = await resolveTargetImageHashes(
      existingSpeaker,
      targetImageById,
      dirname(preparedTarget.manifestPath),
      preparedTarget.configDir
    );
    if (!targetHashes) {
      fail(
        "character_add.speaker_conflict",
        `manifest speaker '${input.speakerId}' already differs`,
        input.speakerId
      );
    }
    const existingFingerprint = buildFingerprint(existingSpeakerRaw, existingSpeaker, (id) => {
      const hash = targetHashes.get(id);
      if (!hash) fail("character_add.speaker_conflict", `cannot verify existing image '${id}'`, id);
      return hash;
    });
    if (fingerprintsEqual(sourceFingerprint, existingFingerprint)) {
      return {
        ok: true,
        added: false,
        alreadyPresent: true,
        speakerId: input.speakerId,
        manifestPath: preparedTarget.manifestPath
      };
    }
    fail(
      "character_add.speaker_conflict",
      `manifest speaker '${input.speakerId}' already differs`,
      input.speakerId
    );
  }

  const dirName = characterDirName(input.speakerId);
  const destinationAbsolute = join(preparedTarget.configDir, "media", "characters", dirName);
  const destinationDir = portableRelative(preparedTarget.configDir, destinationAbsolute);
  const imagePlan = await planImageBindings({
    resolvedImages,
    targetManifest,
    destinationAbsolute,
    configDir: preparedTarget.configDir,
    manifestDir: dirname(preparedTarget.manifestPath)
  });

  const remappedPoses: Record<string, string> = {};
  for (const [poseName, imageId] of poseEntries) {
    remappedPoses[poseName] = imagePlan.imageIdMap[imageId] ?? imageId;
  }
  const remappedMouth = sourceSpeaker.mouth_frames?.map((id) => imagePlan.imageIdMap[id] ?? id);

  const nextSpeaker: Record<string, unknown> = {
    ...sourceSpeakerRaw,
    id: sourceSpeaker.id,
    display_name: sourceSpeaker.display_name,
    side: sourceSpeaker.side,
    accent: sourceSpeaker.accent,
    poses: remappedPoses
  };
  if (remappedMouth) {
    nextSpeaker.mouth_frames = remappedMouth;
  } else {
    delete nextSpeaker.mouth_frames;
  }

  const updatedManifest = appendSpeakerAndImages(targetInput, nextSpeaker, imagePlan.newImages);
  const updatedValidation = validateManifest(updatedManifest);
  if (!updatedValidation.ok) {
    fail(
      "character_add.manifest_update_invalid",
      updatedValidation.issues[0]?.message ?? "updated manifest is invalid",
      updatedValidation.issues[0]?.path
    );
  }

  await commitAdd(
    {
      configDir: preparedTarget.configDir,
      manifestPath: preparedTarget.manifestPath,
      manifestText: preparedTarget.manifestText,
      updatedManifestText: `${JSON.stringify(updatedManifest, null, 2)}\n`,
      destinationAbsolute,
      copies: imagePlan.copies
    },
    input._beforeWrite
  );

  return {
    ok: true,
    added: true,
    alreadyPresent: false,
    speakerId: input.speakerId,
    destinationDir,
    imageIdMap: imagePlan.imageIdMap,
    manifestPath: preparedTarget.manifestPath
  };
}
