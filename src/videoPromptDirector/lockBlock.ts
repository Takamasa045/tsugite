/**
 * CLI helper: recompute locked_blocks sha256 and write back into project.yaml.
 * Uses YAML parseDocument so unrelated fields / comments are preserved.
 * local-write only — does not run Gate, generation, or render.
 */

import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { writeAtomic } from "../platform/fsSafe.js";
import type { Issue, Result } from "../types.js";
import {
  hashLockedText,
  isLockedBlockField,
  type LockedBlockField
} from "./lockedBlocks.js";

export type LockSubjectBlockOptions = {
  configPath: string;
  subjectId: string;
  field: string;
  text: string;
  /** When multiple requests carry IR, pick this request id. */
  requestId?: string;
};

export type LockSubjectBlockSuccess = {
  configPath: string;
  requestId: string;
  irKind: "h3" | "video_prompt";
  subjectId: string;
  field: LockedBlockField;
  sha256: string;
};

function fail(code: string, message: string, path?: string): Result<LockSubjectBlockSuccess> {
  const issue: Issue = path ? { code, message, path } : { code, message };
  return { ok: false, issues: [issue] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Write locked_blocks.{field} = { text, sha256 } for a subject under request.h3 or request.video_prompt.
 */
export async function lockSubjectBlock(
  options: LockSubjectBlockOptions
): Promise<Result<LockSubjectBlockSuccess>> {
  if (!isLockedBlockField(options.field)) {
    return fail(
      "lock_block.field_invalid",
      `field must be one of voice|appearance|manner (got '${options.field}')`,
      "--field"
    );
  }
  const field = options.field;
  if (!options.subjectId.trim()) {
    return fail("lock_block.subject_required", "--subject is required", "--subject");
  }
  if (!options.text || options.text.length === 0) {
    return fail("lock_block.text_required", "locked text must be non-empty", "--text");
  }

  const configText = await readFile(options.configPath, "utf8");
  const document = parseDocument(configText);
  const input = document.toJS() as Record<string, unknown>;
  const generation = isRecord(input.generation) ? input.generation : undefined;
  const requests = generation && Array.isArray(generation.requests) ? generation.requests : [];
  if (requests.length === 0) {
    return fail(
      "lock_block.no_requests",
      "project has no generation.requests",
      "generation.requests"
    );
  }

  type Hit = {
    requestIndex: number;
    requestId: string;
    irKind: "h3" | "video_prompt";
    subjectIndex: number;
  };

  const hits: Hit[] = [];
  for (const [requestIndex, raw] of requests.entries()) {
    if (!isRecord(raw)) continue;
    const requestId = typeof raw.id === "string" ? raw.id : String(requestIndex);
    if (options.requestId && requestId !== options.requestId) continue;

    for (const irKind of ["h3", "video_prompt"] as const) {
      const ir = raw[irKind];
      if (!isRecord(ir)) continue;
      const subjects = Array.isArray(ir.subjects) ? ir.subjects : [];
      for (const [subjectIndex, subject] of subjects.entries()) {
        if (isRecord(subject) && subject.id === options.subjectId) {
          hits.push({ requestIndex, requestId, irKind, subjectIndex });
        }
      }
    }
  }

  if (hits.length === 0) {
    return fail(
      "lock_block.subject_missing",
      options.requestId
        ? `subject '${options.subjectId}' not found in request '${options.requestId}'`
        : `subject '${options.subjectId}' not found in any generation request`,
      options.subjectId
    );
  }
  if (hits.length > 1 && !options.requestId) {
    return fail(
      "lock_block.request_ambiguous",
      `subject '${options.subjectId}' appears in multiple requests; pass --request-id`,
      "--request-id"
    );
  }

  const hit = hits[0]!;
  const sha256 = hashLockedText(options.text);
  const basePath = [
    "generation",
    "requests",
    hit.requestIndex,
    hit.irKind,
    "subjects",
    hit.subjectIndex,
    "locked_blocks",
    field
  ] as const;

  // New object only for this field; yaml setIn preserves siblings.
  document.setIn([...basePath], {
    text: options.text,
    sha256
  });

  await writeAtomic(options.configPath, document.toString());

  return {
    ok: true,
    issues: [],
    configPath: options.configPath,
    requestId: hit.requestId,
    irKind: hit.irKind,
    subjectId: options.subjectId,
    field,
    sha256
  };
}
