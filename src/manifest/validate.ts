import { manifestSchema, type Manifest } from "./schema.js";
import type { Issue, Result } from "../types.js";

const urlLike = /^[a-z][a-z0-9+.-]*:\/\//i;

const dialoguePresets = new Set(["article-dialogue-16x9", "street-dialogue-16x9"]);

export function validateManifest(input: unknown): Result<{ manifest: Manifest }> {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "manifest.schema",
        message: issue.message,
        path: issue.path.join(".")
      }))
    };
  }

  const issues = validateManifestContract(parsed.data);
  if (issues.length > 0) {
    return { ok: false, issues, manifest: parsed.data };
  }

  return { ok: true, issues: [], manifest: parsed.data };
}

function validateManifestContract(manifest: Manifest): Issue[] {
  const clipIssues = manifest.clips.flatMap((clip, index) => {
    const issues: Issue[] = [];
    const path = `clips.${index}`;

    if (urlLike.test(clip.src)) {
      issues.push({
        code: "manifest.clip.src.local",
        message: "clip src must be a local path, not a URL",
        path: `${path}.src`
      });
    }

    if (clip.out <= clip.in || !isCloseEnough(clip.out - clip.in, clip.duration)) {
      issues.push({
        code: "manifest.clip.timing",
        message: "clip out must be greater than in and match duration",
        path
      });
    }

    return issues;
  });

  const imageIssues: Issue[] = [];
  const imageIds = new Set<string>();
  for (const [index, image] of manifest.images.entries()) {
    if (urlLike.test(image.src)) {
      imageIssues.push({
        code: "manifest.image.src.local",
        message: "image src must be a local path, not a URL",
        path: `images.${index}.src`
      });
    }
    if (imageIds.has(image.id)) {
      imageIssues.push({
        code: "manifest.image.id.duplicate",
        message: `image id '${image.id}' must be unique`,
        path: `images.${index}.id`
      });
    }
    imageIds.add(image.id);
  }

  const speakerIssues: Issue[] = [];
  const speakerIds = new Set<string>();
  const isDialoguePresentation = dialoguePresets.has(manifest.presentation?.preset ?? "");
  for (const [index, speaker] of manifest.speakers.entries()) {
    if (speakerIds.has(speaker.id)) {
      speakerIssues.push({
        code: "manifest.speaker.id.duplicate",
        message: `speaker id '${speaker.id}' must be unique`,
        path: `speakers.${index}.id`
      });
    }
    speakerIds.add(speaker.id);
    for (const [pose, imageId] of Object.entries(speaker.poses)) {
      if (!imageIds.has(imageId)) {
        speakerIssues.push({
          code: "manifest.speaker.image",
          message: `speaker pose '${pose}' references unknown image '${imageId}'`,
          path: `speakers.${index}.poses.${pose}`
        });
      }
    }
    for (const [mouthIndex, imageId] of (speaker.mouth_frames ?? []).entries()) {
      if (!imageIds.has(imageId)) {
        speakerIssues.push({
          code: "manifest.speaker.mouth_frame",
          message: `speaker mouth frame ${mouthIndex} references unknown image '${imageId}'`,
          path: `speakers.${index}.mouth_frames.${mouthIndex}`
        });
      }
    }
  }

  if (isDialoguePresentation) {
    const sides = new Set(manifest.speakers.map((speaker) => speaker.side));
    if (manifest.meta.aspect !== "16:9" || manifest.speakers.length !== 2 || !sides.has("left") || !sides.has("right")) {
      speakerIssues.push({
        code: "manifest.presentation.cast",
        message: `${manifest.presentation?.preset} requires exactly one left and one right speaker on a 16:9 manifest`,
        path: "speakers"
      });
    }
    if (!hasAudibleSource(manifest) && manifest.presentation?.draft !== true) {
      speakerIssues.push({
        code: "manifest.presentation.draft",
        message: "a silent article dialogue presentation must remain marked as a draft",
        path: "presentation.draft"
      });
    }
  }

  const captionIssues: Issue[] = [];
  const captionIds = new Set<string>();
  for (const [index, caption] of manifest.captions.entries()) {
    if (caption.end <= caption.start) {
      captionIssues.push({
        code: "manifest.caption.timing",
        message: "caption end must be greater than start",
        path: `captions.${index}`
      });
    }
    if (caption.id) {
      if (captionIds.has(caption.id)) {
        captionIssues.push({
          code: "manifest.caption.id.duplicate",
          message: `caption id '${caption.id}' must be unique`,
          path: `captions.${index}.id`
        });
      }
      captionIds.add(caption.id);
    }
    if (isDialoguePresentation && (!caption.speaker || !speakerIds.has(caption.speaker))) {
      captionIssues.push({
        code: "manifest.caption.speaker",
        message: "presentation captions must reference a declared speaker",
        path: `captions.${index}.speaker`
      });
    }
    if (isDialoguePresentation && caption.end > manifest.meta.target_duration_seconds) {
      captionIssues.push({
        code: "manifest.caption.range",
        message: "presentation caption must end within the target duration",
        path: `captions.${index}.end`
      });
    }
    if (isDialoguePresentation && index > 0 && caption.start < manifest.captions[index - 1]!.end) {
      captionIssues.push({
        code: "manifest.caption.overlap",
        message: "presentation captions must not overlap",
        path: `captions.${index}.start`
      });
    }
  }

  const chapterIssues = manifest.chapters.flatMap((chapter, index) =>
    chapter.end <= chapter.start
      ? [
          {
            code: "manifest.chapter.timing",
            message: "chapter end must be greater than start",
            path: `chapters.${index}`
          }
        ]
      : []
  );

  return [...clipIssues, ...imageIssues, ...speakerIssues, ...captionIssues, ...chapterIssues];
}

function isCloseEnough(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.01;
}

function hasAudibleSource(manifest: Manifest): boolean {
  if (manifest.clips.some((clip) => clip.audio)) return true;
  return [manifest.audio.bgm, manifest.audio.narration, manifest.audio.sfx].some((tracks) =>
    tracks.some((track) => Boolean(track.src))
  );
}
