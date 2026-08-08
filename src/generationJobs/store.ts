/**
 * Durable generation job store: atomic job.json + append-only audit + lock.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  exclusiveLock,
  GenerationJobAuditLog,
  readJsonFile,
  writeJsonAtomic,
  type GenerationJobEvent
} from "./audit.js";
import {
  GJ_IDENTITY_MISMATCH,
  GJ_SCHEMA_INVALID,
  GenerationJobError
} from "./errors.js";
import { redactSecretsDeep } from "./secrets.js";
import {
  parseGenerationJobRecord,
  type GenerationJobRecord,
  type GenerationJobStatus
} from "./schema.js";
import { assertTransition } from "./transitions.js";

export type GenerationJobStoreOptions = {
  rootDir: string;
  now?: () => string;
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
  | "error"
  | "approval"
  | "provider_job_id"
  | "artifact"
> & {
  job_id?: string;
  status?: GenerationJobStatus;
  adapter_id?: string;
  identity_token?: string;
  error?: GenerationJobRecord["error"];
  approval?: GenerationJobRecord["approval"];
  provider_job_id?: string;
  artifact?: GenerationJobRecord["artifact"];
};

export class GenerationJobStore {
  readonly rootDir: string;
  private readonly now: () => string;

  constructor(options: GenerationJobStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  jobDir(jobId: string): string {
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
    const at = this.now();
    const record = parseGenerationJobRecord(
      redactSecretsDeep({
        ...input,
        job_id: jobId,
        schema_version: 1,
        status: input.status ?? "planned",
        submit_attempts: 0,
        submission_unknown: false,
        cancel_requested: false,
        created_at: at,
        updated_at: at,
        identity_token: input.identity_token ?? randomUUID()
      })
    );

    const dir = this.jobDir(jobId);
    await mkdir(dir, { recursive: true });
    await mkdir(this.artifactsDir(jobId), { recursive: true });
    await writeJsonAtomic(this.jobPath(jobId), record);
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
    options: { expectedIdentity?: string; eventType?: string; detail?: Record<string, unknown> } = {}
  ): Promise<GenerationJobRecord> {
    const dir = this.jobDir(job.job_id);
    const lockPath = join(dir, ".job.lock");
    const identity = job.identity_token ?? randomUUID();
    const lock = await exclusiveLock(lockPath, identity);
    try {
      let previous: GenerationJobRecord | undefined;
      try {
        previous = await this.load(job.job_id);
      } catch {
        previous = undefined;
      }
      if (
        options.expectedIdentity
        && previous?.identity_token
        && previous.identity_token !== options.expectedIdentity
      ) {
        throw new GenerationJobError(
          GJ_IDENTITY_MISMATCH,
          `job identity mismatch for '${job.job_id}'`
        );
      }
      if (previous && previous.status !== job.status) {
        assertTransition(previous.status, job.status);
      }

      const next = parseGenerationJobRecord(
        redactSecretsDeep({
          ...job,
          identity_token: identity,
          updated_at: this.now()
        })
      );
      await writeJsonAtomic(this.jobPath(job.job_id), next);

      const audit = new GenerationJobAuditLog(dir, this.now);
      await audit.append({
        job_id: job.job_id,
        type: options.eventType ?? "status_change",
        from_status: previous?.status,
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
      eventType: "transition",
      detail
    });
  }

  async events(jobId: string): Promise<GenerationJobEvent[]> {
    const audit = new GenerationJobAuditLog(this.jobDir(jobId), this.now);
    return audit.readAll();
  }

  /** Test helper: remove job directory entirely. */
  async destroyForTests(jobId: string): Promise<void> {
    await rm(this.jobDir(jobId), { recursive: true, force: true });
  }
}
