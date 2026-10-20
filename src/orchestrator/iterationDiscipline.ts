/**
 * Iteration discipline lint (Phase E) — evidence only, no Gate / auto-regen.
 * Deterministic comparison of lineage block digests and generation ordinals.
 */

import { createTranslator, type TranslateParams } from "../i18n/index.js";
import {
  countChangedBlocks,
  type PromptBlockDigests
} from "../videoPromptDirector/blockDigests.js";

type Translator = (key: string, params?: TranslateParams) => string;
const ja = createTranslator("ja");

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
  params: TranslateParams;
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
      const params = {
        id: current.request_id,
        changed,
        threshold: multiBlockThreshold
      };
      findings.push({
        code: ITERATION_MULTI_BLOCK_CHANGE_CODE,
        severity: "warning",
        params,
        message: ja("review.warn.iteration_multi_block", params)
      });
    }
  }

  if (current.generation_ordinal >= retrySaturationThreshold) {
    const params = {
      id: current.request_id,
      ordinal: current.generation_ordinal,
      threshold: retrySaturationThreshold
    };
    findings.push({
      code: ITERATION_RETRY_SATURATION_CODE,
      severity: "warning",
      params,
      message: ja("review.warn.iteration_retry_saturation", params)
    });
  }

  // Stable order for determinism
  return findings.sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}

export function iterationFindingsToWarningMessages(
  findings: readonly IterationFinding[],
  tr: Translator = ja
): string[] {
  return findings.map((item) => {
    const body = item.code === ITERATION_MULTI_BLOCK_CHANGE_CODE
      ? tr("review.warn.iteration_multi_block", item.params)
      : tr("review.warn.iteration_retry_saturation", item.params);
    return `${tr("review.warn.iteration_prefix")} ${body}`;
  });
}
