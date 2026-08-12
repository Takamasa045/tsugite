/**
 * feedback_api_bridge_only — Learning reads/proposals go through existing feedback API only.
 * Direct mutation of feedback.jsonl / LESSONS.md from learning modules is forbidden.
 */
import {
  decideProjectFeedbackPromotion,
  readProjectFeedback,
  type FeedbackDecisionOptions,
  type FeedbackRecord
} from "../../feedback/index.js";
import { pcError } from "../errors.js";
import type { FeedbackObservation } from "./candidate.js";

/** Compile-time and runtime marker: learning must not open feedback files directly. */
export const FEEDBACK_API_BRIDGE_ONLY = true as const;

export type FeedbackBridgeReadResult = {
  path: string;
  observations: FeedbackObservation[];
  records: FeedbackRecord[];
  issues: Array<{ code: string; message: string; path?: string }>;
};

/**
 * Read feedback observations via existing feedback API.
 * Maps exact keys; never writes files.
 */
export async function readFeedbackObservationsViaApi(
  configPath: string
): Promise<FeedbackBridgeReadResult> {
  if (!FEEDBACK_API_BRIDGE_ONLY) {
    throw pcError("PC_ROLE_FORBIDDEN", "feedback bridge marker disabled");
  }
  const result = await readProjectFeedback(configPath);
  const observations: FeedbackObservation[] = result.entries.map((entry) => ({
    id: entry.id,
    key: entry.key,
    summary: entry.summary,
    stage: entry.stage,
    ...(entry.evidence ? { evidence: entry.evidence } : {})
  }));
  return {
    path: result.path,
    observations,
    records: result.entries,
    issues: result.issues
  };
}

/**
 * Exact-key recurrence count from feedback API records (semantic matches never count).
 */
export function exactKeyRecurrenceFromRecords(
  records: readonly FeedbackRecord[],
  key: string
): number {
  return records.filter((record) => record.key === key).length;
}

/**
 * Decide a feedback promotion proposal via existing human-decision API only.
 * Learning never opens feedback.jsonl for write outside this bridge.
 */
export async function decideLearningPromotionViaFeedbackApi(
  configPath: string,
  input: { key: string; proposalId: string; decision: "approved" | "rejected" },
  options: FeedbackDecisionOptions = {}
): Promise<{ path: string; entry: FeedbackRecord }> {
  if (!FEEDBACK_API_BRIDGE_ONLY) {
    throw pcError("PC_ROLE_FORBIDDEN", "feedback bridge marker disabled");
  }
  return decideProjectFeedbackPromotion(configPath, input, options);
}
