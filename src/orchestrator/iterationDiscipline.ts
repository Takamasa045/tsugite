/**
 * Iteration discipline lint (Phase E) — evidence only, no Gate / auto-regen.
 * Deterministic comparison of lineage block digests and generation ordinals.
 */

import {
  countChangedBlocks,
  type PromptBlockDigests
} from "../videoPromptDirector/blockDigests.js";

export const ITERATION_MULTI_BLOCK_CHANGE_CODE = "iteration.multi_block_change";
export const ITERATION_RETRY_SATURATION_CODE = "iteration.retry_saturation";

export type IterationLineageSnapshot = {
  request_id: string;
  generation_ordinal: number;
  block_digests: PromptBlockDigests;
};

export type IterationFinding = {
  code:
    | typeof ITERATION_MULTI_BLOCK_CHANGE_CODE
    | typeof ITERATION_RETRY_SATURATION_CODE;
  message: string;
  severity: "warning";
};

export type LintIterationDisciplineOptions = {
  /** Blocks changed vs previous generation to warn. Default 2. */
  multiBlockThreshold?: number;
  /** Generation ordinal at which to warn about retry saturation. Default 10. */
  retrySaturationThreshold?: number;
};

const DEFAULTS = {
  multiBlockThreshold: 2,
  retrySaturationThreshold: 10
} as const;

/**
 * Lint one generation step against optional previous snapshot.
 * History of 0–1 generations: multi_block skipped; saturation uses ordinal only.
 */
export function lintIterationDiscipline(
  current: IterationLineageSnapshot,
  previous: IterationLineageSnapshot | undefined,
  options: LintIterationDisciplineOptions = {}
): IterationFinding[] {
  const multiBlockThreshold = options.multiBlockThreshold ?? DEFAULTS.multiBlockThreshold;
  const retrySaturationThreshold =
    options.retrySaturationThreshold ?? DEFAULTS.retrySaturationThreshold;
  const findings: IterationFinding[] = [];

  if (previous && previous.request_id === current.request_id) {
    const changed = countChangedBlocks(previous.block_digests, current.block_digests);
    if (changed >= multiBlockThreshold) {
      findings.push({
        code: ITERATION_MULTI_BLOCK_CHANGE_CODE,
        severity: "warning",
        message:
          `request '${current.request_id}' changed ${changed} prompt blocks vs previous generation `
          + `(threshold ${multiBlockThreshold}); change one block at a time`
      });
    }
  }

  if (current.generation_ordinal >= retrySaturationThreshold) {
    findings.push({
      code: ITERATION_RETRY_SATURATION_CODE,
      severity: "warning",
      message:
        `request '${current.request_id}' reached generation ordinal ${current.generation_ordinal} `
        + `(threshold ${retrySaturationThreshold}); consider splitting or simplifying the shot`
    });
  }

  // Stable order for determinism
  return findings.sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}

export function iterationFindingsToWarningMessages(
  findings: readonly IterationFinding[]
): string[] {
  return findings.map((finding) => `[イテレーション] ${finding.message}`);
}
