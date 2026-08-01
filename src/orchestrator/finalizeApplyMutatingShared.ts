/**
 * Shared types and journal helpers for the mutating finalize apply path.
 * No phase orchestration — imported by preflight / quarantine / promote / commit modules.
 */
import type { LauncherHomePlan, PromotionTransactionTestHooks } from "../project/projectsHome.js";
import type { Issue } from "../types.js";
import {
  resolveCompletionRecordPaths,
  type CompletionRecordProjectContext
} from "./finalizeCompletionRecord.js";
import {
  updateFinalizeJournalPhase,
  writeFinalizeJournal,
  type FinalizeFileIdentity,
  type FinalizeJournal,
  type FinalizeJournalPhase
} from "./finalizeJournal.js";
import type { PriorCleanupProgress } from "./finalizeRecovery.js";

export type MutatingApplyResult = {
  ok: boolean;
  issues: Issue[];
  applied: boolean;
  recordPath?: string;
  deletedFiles: number;
  deletedBytes: number;
  unrestoredPaths?: string[];
  promotedToLauncherHome?: boolean;
  launcherProjectRoot?: string;
  launcherConfigPath?: string;
};

export type MutatingApplyTestHooks = {
  afterQuarantineIndex?: (index: number, quarantinedPath: string) => Promise<void>;
  beforePermanentDeleteIndex?: (index: number, quarantinedPath: string) => Promise<void>;
  beforeRecordWrite?: (recordPath: string) => Promise<void>;
  beforePromote?: () => Promise<void>;
  afterPromote?: () => Promise<void>;
  afterJournalPhase?: (phase: FinalizeJournalPhase, journal: FinalizeJournal) => Promise<void>;
  promotion?: PromotionTransactionTestHooks;
};

export type MutatingApplyContext = {
  projectRoot: string;
  stateDir: string;
  runId: string;
  runDir: string;
  recordPath: string;
  canonicalOutputPath: string;
  candidates: readonly string[];
  mediaFiles: readonly string[];
  identities: readonly FinalizeFileIdentity[];
  plannedBytes: number;
  referencedSourceMedia: readonly string[];
  planDigest: string;
  priorCleanup: PriorCleanupProgress;
  stateUpdatedAt: string;
  launcherPlan: LauncherHomePlan;
  project: CompletionRecordProjectContext;
  configPath: string;
  projectSlug: string;
  now?: string;
  existingRecordText?: string;
  base: MutatingApplyResult;
  testHooks?: MutatingApplyTestHooks;
  revalidatePinnedDirs: () => Promise<Issue | undefined>;
  revalidateLiveFinalizeConditions: (input: {
    quarantinedOriginalPaths: readonly string[];
  }) => Promise<Issue | undefined>;
  inspectDeletionCandidate: (
    absolutePath: string,
    expected: FinalizeFileIdentity
  ) => Promise<Issue | undefined>;
};

export type RecordPaths = ReturnType<typeof resolveCompletionRecordPaths>;

export type JournalHooks = MutatingApplyTestHooks | undefined;

export type SessionCounters = {
  deletedFiles: number;
  deletedBytes: number;
  paths: string[];
};

export type PhaseOk<T extends object> = { kind: "ok" } & T;
export type PhaseFailed = { kind: "failed"; result: MutatingApplyResult };

export function failClosed(base: MutatingApplyResult, issue: Issue): MutatingApplyResult {
  return {
    ...base,
    ok: false,
    deletedFiles: 0,
    deletedBytes: 0,
    issues: [issue]
  };
}

export async function writeJournal(input: {
  stateDir: string;
  runId: string;
  journal: FinalizeJournal;
  hooks?: JournalHooks;
}): Promise<FinalizeJournal> {
  return writeFinalizeJournal({
    stateDir: input.stateDir,
    runId: input.runId,
    journal: input.journal,
    containWithin: input.stateDir,
    afterPhase: input.hooks?.afterJournalPhase
      ? (phase, journal) => input.hooks!.afterJournalPhase!(phase, journal)
      : undefined
  });
}

export async function updatePhase(
  stateDir: string,
  journal: FinalizeJournal,
  phase: FinalizeJournalPhase,
  hooks?: JournalHooks
): Promise<FinalizeJournal> {
  return updateFinalizeJournalPhase({
    stateDir,
    journal,
    phase,
    containWithin: stateDir,
    afterPhase: hooks?.afterJournalPhase
      ? (nextPhase, nextJournal) => hooks.afterJournalPhase!(nextPhase, nextJournal)
      : undefined
  });
}
