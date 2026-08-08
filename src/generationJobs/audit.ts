/**
 * Append-only audit event log for generation jobs.
 * Events never contain secret values.
 */

import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { stablePrettyJson } from "../integrity/canonical.js";
import { redactSecretsDeep } from "./secrets.js";
import type { GenerationJobStatus } from "./schema.js";

export const GENERATION_JOB_EVENT_SCHEMA_VERSION = 1 as const;

const isoDate = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value,
  "must be an ISO 8601 UTC timestamp"
);

export const generationJobEventSchema = z
  .object({
    schema_version: z.literal(GENERATION_JOB_EVENT_SCHEMA_VERSION),
    seq: z.number().int().nonnegative(),
    event_id: z.string().min(1).max(128),
    job_id: z.string().min(1).max(128),
    at: isoDate,
    type: z.string().min(1).max(64),
    from_status: z.string().min(1).max(64).optional(),
    to_status: z.string().min(1).max(64).optional(),
    detail: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export type GenerationJobEvent = z.infer<typeof generationJobEventSchema>;

export type AuditAppendInput = {
  job_id: string;
  type: string;
  from_status?: GenerationJobStatus | string;
  to_status?: GenerationJobStatus | string;
  detail?: Record<string, unknown>;
  at?: string;
};

export class GenerationJobAuditLog {
  private readonly eventsPath: string;
  private nextSeq: number;
  private loaded = false;

  constructor(jobDir: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.eventsPath = join(jobDir, "events.jsonl");
    this.nextSeq = 0;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.eventsPath, "utf8");
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      let maxSeq = -1;
      for (const line of lines) {
        const parsed = generationJobEventSchema.safeParse(JSON.parse(line));
        if (parsed.success) maxSeq = Math.max(maxSeq, parsed.data.seq);
      }
      this.nextSeq = maxSeq + 1;
    } catch {
      this.nextSeq = 0;
    }
    this.loaded = true;
  }

  async append(input: AuditAppendInput): Promise<GenerationJobEvent> {
    if (!this.loaded) await this.load();
    const event: GenerationJobEvent = generationJobEventSchema.parse({
      schema_version: GENERATION_JOB_EVENT_SCHEMA_VERSION,
      seq: this.nextSeq,
      event_id: randomUUID(),
      job_id: input.job_id,
      at: input.at ?? this.now(),
      type: input.type,
      ...(input.from_status !== undefined ? { from_status: input.from_status } : {}),
      ...(input.to_status !== undefined ? { to_status: input.to_status } : {}),
      detail: redactSecretsDeep(input.detail ?? {}) as Record<string, unknown>
    });

    await mkdir(dirname(this.eventsPath), { recursive: true });
    // Append-only: never rewrite prior lines. O_APPEND via appendFile.
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
    this.nextSeq += 1;
    return event;
  }

  async readAll(): Promise<GenerationJobEvent[]> {
    try {
      const text = await readFile(this.eventsPath, "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => generationJobEventSchema.parse(JSON.parse(line)));
    } catch {
      return [];
    }
  }

  /**
   * Crash-safe compaction is intentionally NOT provided.
   * Tests can assert that rewrite attempts are refused by policy.
   */
  async refuseRewrite(): Promise<never> {
    throw new Error("generation job audit log is append-only; rewrite is forbidden");
  }
}

/** Atomic write helper for non-audit durable JSON (job record). */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, stablePrettyJson(value), { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function exclusiveLock(
  lockPath: string,
  identityToken: string
): Promise<{ release: () => Promise<void> }> {
  await mkdir(dirname(lockPath), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(
      `${JSON.stringify({ token: identityToken, pid: process.pid, at: new Date().toISOString() })}\n`,
      "utf8"
    );
    await handle.sync();
  } catch (error) {
    await handle?.close();
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      const { GJ_LOCK_HELD, GenerationJobError } = await import("./errors.js");
      throw new GenerationJobError(GJ_LOCK_HELD, `job lock held: ${lockPath}`);
    }
    throw error;
  }
  const held = handle;
  return {
    release: async () => {
      try {
        await held.close();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  };
}
