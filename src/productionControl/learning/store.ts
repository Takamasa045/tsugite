/**
 * Append-only learning artifact store with atomic publish and crash-safe layout.
 * Never writes feedback.jsonl or LESSONS.md directly.
 */
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { sha256Bytes, sha256Canonical } from "../canonical.js";
import { acquireProductionControlRootLock, pcError } from "../errors.js";
import {
  parseLearningCandidate,
  parseLearningExperiment,
  parsePromotionProposal,
  parseRuleRevision,
  parseRuleSetSnapshot,
  type LearningCandidateV1,
  type LearningExperimentV1,
  type PromotionProposalV1,
  type RuleRevisionV1,
  type RuleSetSnapshotV1
} from "./schema.js";

export type LearningArtifactKind =
  | "candidate"
  | "experiment"
  | "proposal"
  | "rule-revision"
  | "rule-set";

type StoredKindMap = {
  candidate: LearningCandidateV1;
  experiment: LearningExperimentV1;
  proposal: PromotionProposalV1;
  "rule-revision": RuleRevisionV1;
  "rule-set": RuleSetSnapshotV1;
};

const KIND_DIR: Record<LearningArtifactKind, string> = {
  candidate: "candidates",
  experiment: "experiments",
  proposal: "proposals",
  "rule-revision": "rule-revisions",
  "rule-set": "rule-sets"
};

function parseByKind<K extends LearningArtifactKind>(kind: K, value: unknown): StoredKindMap[K] {
  switch (kind) {
    case "candidate":
      return parseLearningCandidate(value) as StoredKindMap[K];
    case "experiment":
      return parseLearningExperiment(value) as StoredKindMap[K];
    case "proposal":
      return parsePromotionProposal(value) as StoredKindMap[K];
    case "rule-revision":
      return parseRuleRevision(value) as StoredKindMap[K];
    case "rule-set":
      return parseRuleSetSnapshot(value) as StoredKindMap[K];
    default: {
      const _exhaustive: never = kind;
      throw pcError("PC_SCHEMA_INVALID", `unknown learning artifact kind: ${_exhaustive}`);
    }
  }
}

function artifactIdOf(kind: LearningArtifactKind, value: StoredKindMap[LearningArtifactKind]): string {
  switch (kind) {
    case "candidate":
      return (value as LearningCandidateV1).candidate_id;
    case "experiment":
      return (value as LearningExperimentV1).experiment_id;
    case "proposal":
      return (value as PromotionProposalV1).proposal_id;
    case "rule-revision": {
      const revision = value as RuleRevisionV1;
      return `${revision.rule_id}.r${revision.revision}`;
    }
    case "rule-set":
      return (value as RuleSetSnapshotV1).rule_set_id;
    default: {
      const _exhaustive: never = kind;
      throw pcError("PC_SCHEMA_INVALID", `unknown learning artifact kind: ${_exhaustive}`);
    }
  }
}

function digestOf(kind: LearningArtifactKind, value: StoredKindMap[LearningArtifactKind]): string {
  switch (kind) {
    case "candidate":
      return (value as LearningCandidateV1).digest;
    case "experiment":
      return (value as LearningExperimentV1).digest;
    case "proposal":
      return (value as PromotionProposalV1).digest;
    case "rule-revision":
      return (value as RuleRevisionV1).digest;
    case "rule-set":
      return (value as RuleSetSnapshotV1).digest;
    default: {
      const _exhaustive: never = kind;
      throw pcError("PC_SCHEMA_INVALID", `unknown learning artifact kind: ${_exhaustive}`);
    }
  }
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(value) && value.length <= 160;
}

async function assertContainedRegularFile(path: string, root: string): Promise<void> {
  const realRoot = await realpath(root);
  const realPath = await realpath(path);
  const rel = relative(realRoot, realPath);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || rel === "") {
    throw pcError("PC_PATH_UNSAFE", "learning artifact escaped store root");
  }
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw pcError("PC_PATH_UNSAFE", "learning artifact must be a regular file");
  }
}

/**
 * Layout under coordination root:
 *   learning/candidates/<id>.json
 *   learning/experiments/<id>.json
 *   learning/proposals/<id>.json
 *   learning/rule-revisions/<id>.json
 *   learning/rule-sets/<id>.json
 *   learning/index.jsonl  (append-only provenance ledger)
 */
export class LearningArtifactStore {
  private readonly root: string;
  private readonly learningRoot: string;

  constructor(coordinationRoot: string) {
    this.root = resolve(coordinationRoot);
    this.learningRoot = join(this.root, "learning");
  }

  async append<K extends LearningArtifactKind>(
    kind: K,
    raw: StoredKindMap[K]
  ): Promise<{ id: string; digest: string; relative_path: string }> {
    const value = parseByKind(kind, raw);
    const id = artifactIdOf(kind, value);
    const digest = digestOf(kind, value);
    if (!isSafeId(id)) throw pcError("PC_PATH_UNSAFE", "learning artifact id is unsafe");

    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = await acquireProductionControlRootLock(this.root);
    try {
      await mkdir(this.learningRoot, { recursive: true, mode: 0o700 });
      const dir = join(this.learningRoot, KIND_DIR[kind]);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const finalPath = join(dir, `${id}.json`);
      const relative_path = relative(this.root, finalPath).split(sep).join("/");

      // Create-only: refuse overwrite (append-only provenance).
      try {
        await lstat(finalPath);
        throw pcError("PC_ARTIFACT_DUPLICATE", "learning artifact already exists", { id, kind });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: string }).code)
          : "";
        if (code === "PC_ARTIFACT_DUPLICATE") throw error;
        if (code !== "ENOENT") throw error;
      }

      const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      const contentDigest = sha256Bytes(bytes);
      const temporaryPath = join(dir, `.${id}.${process.pid}.${randomUUID()}.tmp`);
      let handle: FileHandle | undefined;
      try {
        handle = await open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600
        );
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;

        // Create-only publish: O_EXCL reservation on final path closes TOCTOU with concurrent writers.
        // Rename replaces the empty reservation atomically; never open final without O_EXCL first.
        let reservation: FileHandle | undefined;
        try {
          reservation = await open(
            finalPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
            0o600
          );
          await reservation.close();
          reservation = undefined;
          await rename(temporaryPath, finalPath);
        } catch (error) {
          if (reservation) await reservation.close().catch(() => undefined);
          await unlink(temporaryPath).catch(() => undefined);
          if (error && typeof error === "object" && "code" in error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EEXIST") {
              throw pcError("PC_ARTIFACT_DUPLICATE", "learning artifact already exists", { id, kind });
            }
          }
          // Best-effort cleanup of a failed reservation that may have been created.
          await unlink(finalPath).catch(() => undefined);
          throw error;
        }

        await assertContainedRegularFile(finalPath, this.root);
        const written = await readFile(finalPath);
        if (sha256Bytes(written) !== contentDigest) {
          throw pcError("PC_ARTIFACT_MISMATCH", "learning artifact content digest mismatch after publish");
        }

        await this.appendIndexLine({
          kind,
          id,
          digest,
          content_digest: contentDigest,
          relative_path
        });

        return { id, digest, relative_path };
      } finally {
        if (handle) await handle.close().catch(() => undefined);
      }
    } finally {
      await lock.release();
    }
  }

  async read<K extends LearningArtifactKind>(kind: K, id: string): Promise<StoredKindMap[K]> {
    if (!isSafeId(id)) throw pcError("PC_PATH_UNSAFE", "learning artifact id is unsafe");
    const path = join(this.learningRoot, KIND_DIR[kind], `${id}.json`);
    await assertContainedRegularFile(path, this.root);
    const text = await readFile(path, "utf8");
    return parseByKind(kind, JSON.parse(text));
  }

  async listIds(kind: LearningArtifactKind): Promise<string[]> {
    const dir = join(this.learningRoot, KIND_DIR[kind]);
    try {
      const entries = await readdir(dir);
      return entries
        .filter((name) => name.endsWith(".json") && !name.startsWith("."))
        .map((name) => name.slice(0, -".json".length))
        .sort();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async appendIndexLine(entry: {
    kind: LearningArtifactKind;
    id: string;
    digest: string;
    content_digest: string;
    relative_path: string;
  }): Promise<void> {
    const indexPath = join(this.learningRoot, "index.jsonl");
    const line = `${JSON.stringify({
      schema_version: 1,
      ...entry,
      provenance_digest: createHash("sha256")
        .update(sha256Canonical(entry), "utf8")
        .digest("hex")
    })}\n`;
    const handle = await open(
      indexPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Ensure parent dir fsync best-effort
    const dirHandle = await open(dirname(indexPath), constants.O_RDONLY);
    try {
      await dirHandle.sync();
    } catch {
      // some platforms cannot fsync directories
    } finally {
      await dirHandle.close();
    }
  }
}
