/**
 * Pure state machine for generation jobs.
 * Invalid transitions throw GenerationJobError (fail-closed).
 */

import {
  GJ_INVALID_TRANSITION,
  GenerationJobError
} from "./errors.js";
import type { GenerationJobStatus } from "./schema.js";

/** Allowed directed edges. Terminal states have empty targets. */
export const GENERATION_JOB_TRANSITIONS: Readonly<
  Record<GenerationJobStatus, readonly GenerationJobStatus[]>
> = {
  planned: ["awaiting_cost_approval", "blocked", "failed", "cancelled"],
  awaiting_cost_approval: ["approved", "blocked", "failed", "cancelled"],
  approved: ["submitting", "blocked", "failed", "cancelled", "cancel_requested"],
  submitting: [
    "submitted",
    "submission_unknown",
    "failed",
    "blocked",
    "cancel_requested"
  ],
  submitted: ["polling", "succeeded", "failed", "retry_wait", "cancel_requested", "cancelled"],
  polling: [
    "polling",
    "succeeded",
    "failed",
    "retry_wait",
    "cancel_requested",
    "cancelled"
  ],
  succeeded: ["downloading", "failed", "cancel_requested"],
  downloading: ["verified", "failed", "retry_wait"],
  verified: ["pinned", "failed"],
  pinned: [],
  cancel_requested: ["cancelled", "failed", "polling", "submitted"],
  cancelled: [],
  retry_wait: ["submitting", "polling", "downloading", "failed", "cancelled", "cancel_requested"],
  blocked: ["failed", "cancelled", "awaiting_cost_approval", "planned"],
  failed: [],
  submission_unknown: ["polling", "failed", "cancelled"]
  // Note: submission_unknown → submitting is FORBIDDEN (no auto resubmit).
  // polling is allowed only when provider_job_id is already known (resume).
};

export function canTransition(
  from: GenerationJobStatus,
  to: GenerationJobStatus
): boolean {
  return GENERATION_JOB_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: GenerationJobStatus,
  to: GenerationJobStatus
): void {
  if (!canTransition(from, to)) {
    throw new GenerationJobError(
      GJ_INVALID_TRANSITION,
      `invalid generation job transition: ${from} -> ${to}`
    );
  }
}

export function isTerminalStatus(status: GenerationJobStatus): boolean {
  return GENERATION_JOB_TRANSITIONS[status].length === 0;
}

/** Statuses from which poll/download resume is allowed when provider_job_id exists. */
export function isResumableWithProviderJob(status: GenerationJobStatus): boolean {
  return (
    status === "submitted"
    || status === "polling"
    || status === "retry_wait"
    || status === "succeeded"
    || status === "downloading"
    || status === "submission_unknown"
  );
}
