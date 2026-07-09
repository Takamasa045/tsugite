import { manifestSchema, type Manifest } from "./schema.js";
import type { Issue, Result } from "../types.js";

const urlLike = /^[a-z][a-z0-9+.-]*:\/\//i;

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

  const captionIssues = manifest.captions.flatMap((caption, index) =>
    caption.end <= caption.start
      ? [
          {
            code: "manifest.caption.timing",
            message: "caption end must be greater than start",
            path: `captions.${index}`
          }
        ]
      : []
  );

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

  return [...clipIssues, ...captionIssues, ...chapterIssues];
}

function isCloseEnough(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.01;
}
