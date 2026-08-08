/**
 * Append-only audit event log for generation jobs.
 * Events never contain secret values.
 */

import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { stablePrettyJson } from "../integrity/canonical.js";
import { GJ_LOCK_HELD, GenerationJobError } from "./errors.js";
import { redactAndAssertClean, redactSecretsDeep } from "./secrets.js";
import type { GenerationJobStatus } from "./schema.js";

export const GENERATION_JOB_EVENT_SCHEMA_VERSION = 1 as const;

/** Default: lock must be older than this AND pid dead to reclaim. */
export const DEFAULT_LOCK_STALE_MS = 30_000;

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
    const cleanDetail = redactAndAssertClean(input.detail ?? {}, "audit.detail") as Record<
      string,
      unknown
    >;
    const event: GenerationJobEvent = generationJobEventSchema.parse({
      schema_version: GENERATION_JOB_EVENT_SCHEMA_VERSION,
      seq: this.nextSeq,
      event_id: randomUUID(),
      job_id: input.job_id,
      at: input.at ?? this.now(),
      type: input.type,
      ...(input.from_status !== undefined ? { from_status: input.from_status } : {}),
      ...(input.to_status !== undefined ? { to_status: input.to_status } : {}),
      detail: cleanDetail
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

/** Create-only atomic write: fails if destination already exists (O_EXCL). */
export async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // wx on final path — never overwrite existing job.json.
  await writeFile(path, stablePrettyJson(value), { encoding: "utf8", flag: "wx" });
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export type ExclusiveLockOptions = {
  /** Epoch ms clock (injectable for tests). */
  nowMs?: () => number;
  /** PID liveness probe (injectable; default process.kill(pid, 0)). */
  isPidAlive?: (pid: number) => boolean;
  /** Minimum age before a dead-PID lock may be reclaimed. */
  staleMs?: number;
  /** Optional callback when a stale lock is reclaimed (audit hook). */
  onRecovered?: (info: { previousPid: number; previousAt: string; lockPath: string }) => void | Promise<void>;
};

export type ExclusiveLockHandle = {
  release: () => Promise<void>;
  recovered: boolean;
  recovery?: { previousPid: number; previousAt: string };
};

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // EPERM means process exists but we cannot signal it.
    if (err.code === "EPERM") return true;
    return false;
  }
}

type LockPayload = { token: string; pid: number; at: string };

function parseLockPayload(raw: string): LockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof parsed.token !== "string"
      || typeof parsed.pid !== "number"
      || !Number.isInteger(parsed.pid)
      || typeof parsed.at !== "string"
      || Number.isNaN(Date.parse(parsed.at))
    ) {
      return null;
    }
    return { token: parsed.token, pid: parsed.pid, at: parsed.at };
  } catch {
    return null;
  }
}

/**
 * Exclusive lock with fail-closed reclaim:
 * only dead PID AND age >= staleMs may be recovered. PID reuse / parse failure / fresh locks → GJ_LOCK_HELD.
 */
export async function exclusiveLock(
  lockPath: string,
  identityToken: string,
  options: ExclusiveLockOptions = {}
): Promise<ExclusiveLockHandle> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;

  await mkdir(dirname(lockPath), { recursive: true });

  const attempt = async (recovered: boolean, recovery?: ExclusiveLockHandle["recovery"]): Promise<ExclusiveLockHandle> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(
        `${JSON.stringify({ token: identityToken, pid: process.pid, at: new Date(nowMs()).toISOString() })}\n`,
        "utf8"
      );
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        throw new GenerationJobError(GJ_LOCK_HELD, `job lock held: ${lockPath}`);
      }
      throw error;
    }
    const held = handle;
    return {
      recovered,
      recovery,
      release: async () => {
        try {
          await held.close();
        } finally {
          await rm(lockPath, { force: true });
        }
      }
    };
  };

  try {
    return await attempt(false);
  } catch (error) {
    if (!(error instanceof GenerationJobError) || error.code !== GJ_LOCK_HELD) {
      throw error;
    }

    // Attempt safe reclaim of dead+stale lock only.
    let raw: string;
    try {
      raw = await readFile(lockPath, "utf8");
    } catch {
      throw new GenerationJobError(GJ_LOCK_HELD, `job lock held: ${lockPath}`);
    }

    const payload = parseLockPayload(raw.trim());
    if (!payload) {
      throw new GenerationJobError(GJ_LOCK_HELD, `job lock held (unparseable): ${lockPath}`);
    }

    if (isPidAlive(payload.pid)) {
      throw new GenerationJobError(GJ_LOCK_HELD, `job lock held by live pid ${payload.pid}`);
    }

    const age = nowMs() - Date.parse(payload.at);
    if (!Number.isFinite(age) || age < staleMs) {
      throw new GenerationJobError(
        GJ_LOCK_HELD,
        `job lock held (dead pid but not stale enough): ${lockPath}`
      );
    }

    // Safe reclaim: remove then re-acquire with wx.
    try {
      await rm(lockPath, { force: true });
    } catch {
      throw new GenerationJobError(GJ_LOCK_HELD, `job lock reclaim failed: ${lockPath}`);
    }

    const recovery = { previousPid: payload.pid, previousAt: payload.at };
    if (options.onRecovered) {
      await options.onRecovered({ ...recovery, lockPath });
    }

    try {
      return await attempt(true, recovery);
    } catch {
      // Race: another process reclaimed first.
      throw new GenerationJobError(GJ_LOCK_HELD, `job lock held after reclaim race: ${lockPath}`);
    }
  }
}

// Keep redact import used for accidental direct detail writes.
void redactSecretsDeep;
