/**
 * Public types and contracts for finalize.
 * Runtime helpers stay out of this module to keep the dependency surface small.
 */
import type { Manifest } from "../manifest/schema.js";
import type { PromotionTransactionTestHooks } from "../project/projectsHome.js";
import type { Project } from "../project/schema.js";
import type { Issue } from "../types.js";
import type {
  FinalizeFileIdentity,
  FinalizeJournal,
  FinalizeJournalPhase
} from "./finalizeJournal.js";
import type {
  FinalizeRunDirIdentity,
  FinalizeStateDirIdentity
} from "./finalizePathSafety.js";

/**
 * Optional hooks used only by unit tests to inject mid-apply failures.
 * Never wired from the CLI.
 */
export type FinalizeTestHooks = {
  afterQuarantineIndex?: (index: number, quarantinedPath: string) => Promise<void>;
  beforePermanentDeleteIndex?: (index: number, quarantinedPath: string) => Promise<void>;
  beforeRecordWrite?: (recordPath: string) => Promise<void>;
  beforePromote?: () => Promise<void>;
  /** Runs after successful promotion and before the pre-permanent-delete revalidation. */
  afterPromote?: () => Promise<void>;
  /** Runs after a journal phase is persisted. */
  afterJournalPhase?: (phase: FinalizeJournalPhase, journal: FinalizeJournal) => Promise<void>;
  /**
   * Runs immediately before each post-lock stateDir/runDir identity revalidation
   * that guards a destructive operation. Used only to inject path-swap races in tests.
   */
  beforeBoundaryRevalidate?: () => Promise<void>;
  /**
   * Forwarded to launcher promotion commit/rollback failure injection.
   * Never wired from the CLI.
   */
  promotion?: PromotionTransactionTestHooks;
};

export type FinalizeCompletedProjectOptions = {
  configPath: string;
  project: Project;
  manifest: Manifest;
  stateDir?: string;
  apply: boolean;
  now?: string;
  /**
   * Required when apply is true. Must match the live plan digest from preview.
   */
  expectedPlanDigest?: string;
  /**
   * Optional identities captured at CLI preflight / lock acquire. When set, apply
   * refuses if stateDir/runDir no longer match these real directories.
   */
  expectedStateDirIdentity?: FinalizeStateDirIdentity;
  expectedRunDirIdentity?: FinalizeRunDirIdentity;
  /** @internal test-only failure injection; not exposed via CLI. */
  _testHooks?: FinalizeTestHooks;
};

export type FinalizeCompletedProjectResult = {
  ok: boolean;
  issues: Issue[];
  applied: boolean;
  canonicalOutput?: string;
  recordPath?: string;
  /**
   * True only when the completion record exists as a regular file, no deletion
   * candidates remain, and the project is already under durable launcher home.
   * Path presence alone is not enough — preview always reports the record path.
   */
  alreadyFinalized?: boolean;
  mediaFiles: string[];
  retainedMedia: string[];
  plannedBytes: number;
  deletedFiles: number;
  deletedBytes: number;
  /** Deterministic digest of deletion candidates and retention conditions. */
  planDigest?: string;
  /** Regular-file identities for each deletion candidate (project-relative paths). */
  candidateIdentities?: FinalizeFileIdentity[];
  /** Paths that could not be restored from quarantine after a failed apply. */
  unrestoredPaths?: string[];
  /** Durable launcher projects directory (main shelf). */
  launcherProjectsHome?: string;
  /** Project root the launcher should list after finalize. */
  launcherProjectRoot?: string;
  /** True when the project was already under the durable launcher home. */
  launcherAlreadyHome?: boolean;
  /** True when finalize copied the project into the durable launcher home. */
  promotedToLauncherHome?: boolean;
  /** Config path under the durable launcher home after promotion. */
  launcherConfigPath?: string;
};
