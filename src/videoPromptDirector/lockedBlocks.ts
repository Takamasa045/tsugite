/**
 * Subject locked_blocks: verbatim identity text + sha256 machine check.
 * Renderer-independent helpers used by schema, validate, render, lineage, CLI.
 */

import { z } from "zod";
import { sha256Text } from "../integrity/canonical.js";
import type { H3CreativeIr, H3Subject } from "./schema.js";
import { issue, type H3Issue } from "./validation/types.js";

export const LOCK_HASH_MISMATCH_CODE = "LOCK-E001";

export const LOCKED_BLOCK_FIELDS = ["voice", "appearance", "manner"] as const;
export type LockedBlockField = (typeof LOCKED_BLOCK_FIELDS)[number];

export const lockedBlockFieldSchema = z
  .object({
    text: z.string().min(1),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "must be lowercase sha256 hex")
  })
  .strict();

export const lockedBlocksSchema = z
  .object({
    voice: lockedBlockFieldSchema.optional(),
    appearance: lockedBlockFieldSchema.optional(),
    manner: lockedBlockFieldSchema.optional()
  })
  .strict();

export type LockedTextBlock = z.infer<typeof lockedBlockFieldSchema>;
export type SubjectLockedBlocks = z.infer<typeof lockedBlocksSchema>;

export function hashLockedText(text: string): string {
  return sha256Text(text);
}

export function isLockedBlockField(value: string): value is LockedBlockField {
  return (LOCKED_BLOCK_FIELDS as readonly string[]).includes(value);
}

/** IR-level hash check. Always runs for H3 and plain (renderer-independent). */
export function validateLockedBlocks(ir: H3CreativeIr): H3Issue[] {
  const issues: H3Issue[] = [];
  for (const [subjectIndex, subject] of ir.subjects.entries()) {
    const blocks = subject.locked_blocks;
    if (!blocks) continue;
    for (const field of LOCKED_BLOCK_FIELDS) {
      const block = blocks[field];
      if (!block) continue;
      const actual = hashLockedText(block.text);
      if (actual !== block.sha256) {
        issues.push(
          issue(
            LOCK_HASH_MISMATCH_CODE,
            `locked_blocks.${field} sha256 does not match text (expected ${block.sha256}, got ${actual})`,
            "error",
            ["subjects", subjectIndex, "locked_blocks", field, "sha256"]
          )
        );
      }
    }
  }
  return issues;
}

/** Lineage digests: "subjectId.field" → declared sha256 (validated separately). */
export function collectLockedBlockHashes(
  ir: H3CreativeIr
): Record<string, string> | undefined {
  const hashes: Record<string, string> = {};
  for (const subject of ir.subjects) {
    const blocks = subject.locked_blocks;
    if (!blocks) continue;
    for (const field of LOCKED_BLOCK_FIELDS) {
      const block = blocks[field];
      if (block) {
        hashes[`${subject.id}.${field}`] = block.sha256;
      }
    }
  }
  return Object.keys(hashes).length > 0 ? hashes : undefined;
}

export function formatVoiceLockedBlock(text: string): string {
  // No trim / normalize — locked payload is byte-for-byte.
  return `VOICE:\n${text}`;
}

export function formatAppearanceLockedBlock(text: string): string {
  return `CHARACTER APPEARANCE:\n${text}`;
}

export function formatMannerLockedBlock(text: string): string {
  return `CHARACTER MANNER:\n${text}`;
}

/** Character-acting locked lines for a speaking subject (appearance + manner). */
export function renderSubjectActingLocks(subject: H3Subject | undefined): string[] {
  if (!subject?.locked_blocks) return [];
  const parts: string[] = [];
  if (subject.locked_blocks.appearance) {
    parts.push(formatAppearanceLockedBlock(subject.locked_blocks.appearance.text));
  }
  if (subject.locked_blocks.manner) {
    parts.push(formatMannerLockedBlock(subject.locked_blocks.manner.text));
  }
  return parts;
}

/** Append locked appearance/manner for reference subject_definitions. */
export function appendSubjectDefinitionLocks(
  baseLine: string,
  subject: H3Subject
): string {
  const extras = renderSubjectActingLocks(subject);
  if (extras.length === 0) return baseLine;
  return [baseLine, ...extras].join("\n");
}
