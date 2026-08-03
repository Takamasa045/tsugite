/**
 * Shared public types and small path helpers for the launcher projects home.
 * No promotion/journal/fs orchestration here — only pure helpers and contracts.
 */

import { lstat, realpath, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { Issue } from "../types.js";
import { isNodeError } from "./promotionJournalShared.js";

/** Durable promotion marker written only as a regular file under the destination root. */
export const LAUNCHER_HOME_MARKER_NAME = "launcher-home.json";

/** Optional hooks/fs overrides for regression tests only. */
export type PromotionTransactionTestHooks = {
  rm?: typeof rm;
  rename?: typeof rename;
  /** Invoked after phase=switching is durable, before the first destination→backup rename. */
  afterSwitchingJournal?: () => Promise<void>;
  /** Invoked after phase=committing is durable, before backup removal. */
  afterCommitPhase?: () => Promise<void>;
  /** Invoked after phase=rolling_back is durable, before destination removal. */
  afterRollbackPhase?: () => Promise<void>;
  /** Invoked after destination removal, before backup rename restore. */
  afterRollbackRemoveDestination?: () => Promise<void>;
};

export type ResolveDurableProjectsHomeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type LauncherHomePlan = {
  projectsHome: string;
  projectRoot: string;
  destinationRoot: string;
  alreadyHome: boolean;
  willPromote: boolean;
};

export type EnsureLauncherHomeOptions = {
  configPath: string;
  projectSlug: string;
  apply: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
  /** Test-only hooks for commit/rollback failure injection. */
  _testHooks?: PromotionTransactionTestHooks;
};

/**
 * Keeps a durable-destination backup (or newly created tree) open until
 * completion-record is confirmed. commit drops the backup; rollback restores
 * the prior destination or removes a newly created partial promotion.
 */
export type PromotionTransaction = {
  destinationRoot: string;
  backupPath?: string;
  createdFresh: boolean;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

export type EnsureLauncherHomeResult = {
  ok: boolean;
  issues: Issue[];
  projectsHome: string;
  projectRoot: string;
  destinationRoot: string;
  alreadyHome: boolean;
  promoted: boolean;
  destinationConfigPath?: string;
  /**
   * Present only when apply promoted a tree. Hold until completion-record is
   * durable; then commit(). On record failure, rollback() before returning.
   */
  promotionTransaction?: PromotionTransaction;
};

export type EnsureProjectVisibleOptions = {
  configPath: string;
  projectSlug: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type EnsureProjectVisibleResult = {
  ok: boolean;
  issues: Issue[];
  alreadyHome: boolean;
  linked: boolean;
  projectsHome: string;
  launcherProjectRoot: string;
  launcherConfigPath: string;
};

export function isWithinDirectory(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === ""
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

export function sanitizeProjectDirName(projectSlug: string, projectRoot: string): string {
  const slug = projectSlug.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) return slug;
  return basename(projectRoot);
}

export async function resolveExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export async function isSymbolicLinkPath(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function pathIsDirOrSymlink(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isSymbolicLink() || stats.isDirectory();
  } catch {
    return false;
  }
}

export { isNodeError };
