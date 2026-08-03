/**
 * Public types, constants, and errors for run/gate state and run locks.
 */
import type { DirectoryIdentity } from "./finalizePersistence.js";

export type GateId = "gate_1" | "gate_2" | "gate_3";
export type GateDecision = "approved" | "revise" | "abort" | "re_render";
export type GateStatus = "pending" | "awaiting_approval" | "approved" | "revise" | "abort";
export type RunStatus =
  | "planned"
  | "awaiting_gate_1"
  | "dry_run"
  | "running"
  | "awaiting_gate_2"
  | "rendering"
  | "awaiting_gate_3"
  | "completed"
  | "aborted";

export type GateDecisionSource = "human" | "auto_qc";

export type GateState = {
  status: GateStatus;
  updated_at?: string;
  approved_input_digest?: string;
  decision_source?: GateDecisionSource;
};

export type RunState = {
  run_id: string;
  status: RunStatus;
  updated_at: string;
  gates: Record<GateId, GateState>;
};

export type RunLock = {
  token: string;
  release: () => Promise<void>;
};

/** Expected stateDir identity captured at finalize preflight for lock-time revalidation. */
export type ExpectedStateDirIdentity = DirectoryIdentity;

export type AcquireRunLockOptions = {
  /**
   * When set, re-verify parent/leaf nofollow containment and device/inode/realpath
   * identity inside the lock path before any mkdir/write/rename/unlink.
   */
  expectedStateDir?: ExpectedStateDirIdentity;
  /** Optional project root used for symlink-along-path containment checks. */
  containWithin?: string;
  /**
   * @internal test-only TOCTOU injection. Never wired from the CLI.
   */
  _testHooks?: AcquireRunLockTestHooks;
};

/** @internal test-only hooks for lock-path race injection. */
export type AcquireRunLockTestHooks = {
  /** Runs after stateDir/runDir identity checks and immediately before open(lock). */
  afterIdentityCheckBeforeOpen?: () => Promise<void>;
  /** Runs after exclusive lock create and before post-open identity revalidation. */
  afterLockCreatedBeforeValidate?: () => Promise<void>;
};

export class RunLockBoundaryError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(issue: { code: string; message: string; path?: string }) {
    super(issue.message);
    this.name = "RunLockBoundaryError";
    this.code = issue.code;
    if (issue.path !== undefined) this.path = issue.path;
  }
}

export const RUN_LOCK_INHERIT_ENV = "TSUGITE_INHERITED_RUN_LOCK";
export const LAUNCHER_EXPECTED_APPROVAL_DIGEST_ENV = "TSUGITE_LAUNCHER_EXPECTED_APPROVAL_DIGEST";

export class RunLockedError extends Error {
  readonly code = "run.locked";

  constructor() {
    super("run is locked by another process");
    this.name = "RunLockedError";
  }
}
