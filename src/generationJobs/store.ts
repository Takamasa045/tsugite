/**
 * Durable generation job store: atomic job.json + append-only audit + lock.
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  exclusiveLock,
  GenerationJobAuditLog,
  readJsonFile,
  writeJsonAtomic,
  writeJsonExclusive,
  type ExclusiveLockOptions,
  type GenerationJobEvent
} from "./audit.js";
import {
  GJ_IDENTITY_MISMATCH,
  GJ_SCHEMA_INVALID,
  GenerationJobError
} from "./errors.js";
import { redactAndAssertClean } from "./secrets.js";
import {
  isSafeJobId,
  parseGenerationJobRecord,
  type GenerationJobRecord,
  type GenerationJobStatus
} from "./schema.js";
import { assertTransition } from "./transitions.js";

export type GenerationJobStoreOptions = {
  rootDir: string;
  now?: () => string;
  lock?: ExclusiveLockOptions;
};

export type CreateJobInput = Omit<
  GenerationJobRecord,
  | "schema_version"
  | "status"
  | "created_at"
  | "updated_at"
  | "submit_attempts"
  | "submission_unknown"
  | "cancel_requested"
  | "job_id"
  | "adapter_id"
  | "identity_token"
  | "revision"
  | "error"
  | "approval"
  | "provider_job_id"
  | "artifact"
> & {
  job_id?: string;
  status?: GenerationJobStatus;
  adapter_id?: string;
  identity_token?: string;
  revision?: number;
  error?: GenerationJobRecord["error"];
  approval?: GenerationJobRecord["approval"];
  provider_job_id?: string;
  artifact?: GenerationJobRecord["artifact"];
};

export class GenerationJobStore {
  readonly rootDir: string;
  private readonly now: () => string;
  private readonly lockOptions: ExclusiveLockOptions;

  constructor(options: GenerationJobStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.now = options.now ?? (() => new Date().toISOString());
    this.lockOptions = options.lock ?? {};
  }

  assertJobId(jobId: string): void {
    if (!isSafeJobId(jobId)) {
      throw new GenerationJobError(
        GJ_SCHEMA_INVALID,
        `unsafe job id rejected: ${jobId}`
      );
    }
  }

  jobDir(jobId: string): string {
    this.assertJobId(jobId);
    return join(this.rootDir, jobId);
  }

  jobPath(jobId: string): string {
    return join(this.jobDir(jobId), "job.json");
  }

  artifactsDir(jobId: string): string {
    return join(this.jobDir(jobId), "artifacts");
  }

  async create(input: CreateJobInput): Promise<GenerationJobRecord> {
    const jobId = input.job_id ?? `job-${randomUUID()}`;
    this.assertJobId(jobId);
    const at = this.now();
    const record = parseGenerationJobRecord(
      redactAndAssertClean(
        {
          ...input,
          job_id: jobId,
          schema_version: 1,
          status: input.status ?? "planned",
          submit_attempts: 0,
          submission_unknown: false,
          cancel_requested: false,
          created_at: at,
          updated_at: at,
          identity_token: input.identity_token ?? randomUUID(),
          revision: input.revision ?? 0
        },
        "job.create"
      )
    );

    const dir = this.jobDir(jobId);
    // Fail-closed: refuse duplicate job_id (do not overwrite existing job.json / events / approval).
    try {
      await access(this.jobPath(jobId));
      throw new GenerationJobError(
        GJ_SCHEMA_INVALID,
        `duplicate job_id refused: '${jobId}' already exists`
      );
    } catch (error) {
      if (error instanceof GenerationJobError) throw error;
      // ENOENT → ok
    }

    await mkdir(this.rootDir, { recursive: true });
    await mkdir(dir, { recursive: true });
    await mkdir(this.artifactsDir(jobId), { recursive: true });

    try {
      await writeJsonExclusive(this.jobPath(jobId), record);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        throw new GenerationJobError(
          GJ_SCHEMA_INVALID,
          `duplicate job_id refused: '${jobId}' already exists`
        );
      }
      throw error;
    }

    const audit = new GenerationJobAuditLog(dir, this.now);
    await audit.append({
      job_id: jobId,
      type: "created",
      to_status: record.status,
      detail: {
        connection_id: record.connection_id,
        model_id: record.model_id,
        mode: record.mode
      }
    });
    return record;
  }

  async load(jobId: string): Promise<GenerationJobRecord> {
    this.assertJobId(jobId);
    try {
      const raw = await readJsonFile(this.jobPath(jobId));
      return parseGenerationJobRecord(raw);
    } catch (error) {
      if (error instanceof GenerationJobError) throw error;
      throw new GenerationJobError(
        GJ_SCHEMA_INVALID,
        `failed to load job '${jobId}': ${(error as Error).message}`
      );
    }
  }

  async save(
    job: GenerationJobRecord,
    options: {
      expectedIdentity?: string;
      expectedRevision?: number;
      eventType?: string;
      detail?: Record<string, unknown>;
    } = {}
  ): Promise<GenerationJobRecord> {
    this.assertJobId(job.job_id);
    const dir = this.jobDir(job.job_id);
    const lockPath = join(dir, ".job.lock");
    const writerToken = randomUUID();

    const recoveryEvents: Array<{ previousPid: number; previousAt: string }> = [];
    const lock = await exclusiveLock(lockPath, writerToken, {
      ...this.lockOptions,
      onRecovered: async (info) => {
        recoveryEvents.push({ previousPid: info.previousPid, previousAt: info.previousAt });
        if (this.lockOptions.onRecovered) await this.lockOptions.onRecovered(info);
      }
    });

    try {
      // Fail-closed: never recreate from caller-supplied in-memory job when durable
      // job.json is missing, corrupt, or schema-invalid.
      const previous = await this.load(job.job_id);

      if (
        options.expectedIdentity
        && previous.identity_token
        && previous.identity_token !== options.expectedIdentity
      ) {
        throw new GenerationJobError(
          GJ_IDENTITY_MISMATCH,
          `job identity mismatch for '${job.job_id}'`
        );
      }

      if (
        options.expectedRevision !== undefined
        && previous.revision !== options.expectedRevision
      ) {
        throw new GenerationJobError(
          GJ_IDENTITY_MISMATCH,
          `job revision mismatch for '${job.job_id}': expected ${options.expectedRevision}, got ${previous.revision}`
        );
      }

      if (previous.status !== job.status) {
        assertTransition(previous.status, job.status);
      }

      // Optimistic concurrency: always rotate identity and bump revision on save.
      const nextIdentity = randomUUID();
      const nextRevision = (previous.revision ?? job.revision ?? 0) + 1;
      const next = parseGenerationJobRecord(
        redactAndAssertClean(
          {
            ...job,
            identity_token: nextIdentity,
            revision: nextRevision,
            updated_at: this.now()
          },
          "job.save"
        )
      );
      await writeJsonAtomic(this.jobPath(job.job_id), next);

      const audit = new GenerationJobAuditLog(dir, this.now);
      for (const recovery of recoveryEvents) {
        await audit.append({
          job_id: job.job_id,
          type: "lock_recovered",
          detail: {
            previous_pid: recovery.previousPid,
            previous_at: recovery.previousAt,
            recovered: true
          }
        });
      }
      if (lock.recovered && lock.recovery && recoveryEvents.length === 0) {
        await audit.append({
          job_id: job.job_id,
          type: "lock_recovered",
          detail: {
            previous_pid: lock.recovery.previousPid,
            previous_at: lock.recovery.previousAt,
            recovered: true
          }
        });
      }
      await audit.append({
        job_id: job.job_id,
        type: options.eventType ?? "status_change",
        from_status: previous.status,
        to_status: next.status,
        detail: options.detail ?? {}
      });
      return next;
    } finally {
      await lock.release();
    }
  }

  async transition(
    jobId: string,
    toStatus: GenerationJobStatus,
    mutate: (job: GenerationJobRecord) => GenerationJobRecord | void = (j) => j,
    detail: Record<string, unknown> = {}
  ): Promise<GenerationJobRecord> {
    const current = await this.load(jobId);
    assertTransition(current.status, toStatus);
    const patched = mutate({ ...current }) ?? current;
    const next: GenerationJobRecord = {
      ...patched,
      status: toStatus,
      updated_at: this.now()
    };
    return this.save(next, {
      expectedIdentity: current.identity_token,
      expectedRevision: current.revision,
      eventType: "transition",
      detail
    });
  }

  async events(jobId: string): Promise<GenerationJobEvent[]> {
    this.assertJobId(jobId);
    const audit = new GenerationJobAuditLog(this.jobDir(jobId), this.now);
    return audit.readAll();
  }

  /** Test helper: remove job directory entirely. */
  async destroyForTests(jobId: string): Promise<void> {
    this.assertJobId(jobId);
    await rm(this.jobDir(jobId), { recursive: true, force: true });
  }
}
