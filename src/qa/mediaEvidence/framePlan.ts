/**
 * Deterministic boundary + uniform frame planning (provider neutral).
 * Shot identity (id) is never rewritten; input is validated and deterministically ordered
 * so the full plan is guaranteed non-decreasing by timestamp_ms.
 */
import { MEDIA_EVIDENCE_LIMITS, type MediaFrameRole } from "./schema.js";

export type MediaShotTiming = {
  id: string;
  start_ms: number;
  end_ms: number;
};

export type MediaFramePlanEntry = {
  shot_id: string;
  timestamp_ms: number;
  role: MediaFrameRole;
};

export type MediaFramePlanOptions = {
  frames_per_shot: number;
  max_total_frames?: number;
};

const ROLE_ORDER: Record<MediaFrameRole, number> = {
  boundary_start: 0,
  uniform: 1,
  boundary_end: 2
};

/**
 * Build a deterministic sampling plan.
 * - Validates non-positive duration, empty/duplicate ids
 * - Sorts shots by (start_ms, id) without changing shot identity fields
 * - boundary_start at start_ms; boundary_end at end_ms - 1 when duration allows
 * - uniform interior samples so total per shot is at most frames_per_shot
 * - Final plan is stable-sorted by (timestamp_ms, shot_id, role) so global
 *   timestamps are always non-decreasing even with overlapping shots
 */
export function buildMediaFramePlan(
  shots: readonly MediaShotTiming[],
  options: MediaFramePlanOptions
): MediaFramePlanEntry[] {
  const framesPerShot = options.frames_per_shot;
  const maxTotal = options.max_total_frames ?? MEDIA_EVIDENCE_LIMITS.max_total_frames;

  if (
    !Number.isInteger(framesPerShot)
    || framesPerShot < 1
    || framesPerShot > MEDIA_EVIDENCE_LIMITS.max_frames_per_shot
  ) {
    throw new Error(
      `frames_per_shot must be between 1 and ${MEDIA_EVIDENCE_LIMITS.max_frames_per_shot} (limit)`
    );
  }
  if (!Number.isInteger(maxTotal) || maxTotal < 1 || maxTotal > MEDIA_EVIDENCE_LIMITS.max_total_frames) {
    throw new Error(
      `max_total_frames must be between 1 and ${MEDIA_EVIDENCE_LIMITS.max_total_frames} (limit)`
    );
  }

  const seenIds = new Set<string>();
  for (const shot of shots) {
    if (!shot.id || typeof shot.id !== "string") {
      throw new Error("shot id must be a non-empty string");
    }
    if (seenIds.has(shot.id)) {
      throw new Error(`duplicate shot id '${shot.id}'`);
    }
    seenIds.add(shot.id);
    if (!Number.isFinite(shot.start_ms) || !Number.isFinite(shot.end_ms)) {
      throw new Error(`shot '${shot.id}' has non-finite timing`);
    }
    if (!Number.isInteger(shot.start_ms) || !Number.isInteger(shot.end_ms)) {
      throw new Error(`shot '${shot.id}' timestamps must be integers`);
    }
    if (shot.start_ms < 0) {
      throw new Error(`shot '${shot.id}' start_ms must be non-negative`);
    }
    if (shot.end_ms <= shot.start_ms) {
      throw new Error(`shot '${shot.id}' has non-positive duration`);
    }
  }

  // Deterministic shot order by start time then id — preserves original identity fields.
  const orderedShots = [...shots].sort((left, right) => {
    if (left.start_ms !== right.start_ms) return left.start_ms - right.start_ms;
    return left.id.localeCompare(right.id);
  });

  const plan: MediaFramePlanEntry[] = [];
  for (const shot of orderedShots) {
    const duration = shot.end_ms - shot.start_ms;
    const frames: MediaFramePlanEntry[] = [
      {
        shot_id: shot.id,
        timestamp_ms: shot.start_ms,
        role: "boundary_start"
      }
    ];

    if (framesPerShot >= 2) {
      const endTs = Math.max(shot.start_ms, shot.end_ms - 1);
      if (endTs !== shot.start_ms) {
        frames.push({
          shot_id: shot.id,
          timestamp_ms: endTs,
          role: "boundary_end"
        });
      }
    }

    const remaining = framesPerShot - frames.length;
    if (remaining > 0 && duration > 1) {
      for (let i = 1; i <= remaining; i += 1) {
        const fraction = i / (remaining + 1);
        const timestamp_ms = shot.start_ms + Math.floor(duration * fraction);
        if (frames.some((frame) => frame.timestamp_ms === timestamp_ms)) continue;
        frames.push({
          shot_id: shot.id,
          timestamp_ms,
          role: "uniform"
        });
      }
    }

    frames.sort((left, right) => {
      if (left.timestamp_ms !== right.timestamp_ms) {
        return left.timestamp_ms - right.timestamp_ms;
      }
      return ROLE_ORDER[left.role] - ROLE_ORDER[right.role];
    });
    plan.push(...frames);
  }

  // Global non-decreasing guarantee (handles reverse input and overlapping ranges).
  plan.sort((left, right) => {
    if (left.timestamp_ms !== right.timestamp_ms) {
      return left.timestamp_ms - right.timestamp_ms;
    }
    const idCmp = left.shot_id.localeCompare(right.shot_id);
    if (idCmp !== 0) return idCmp;
    return ROLE_ORDER[left.role] - ROLE_ORDER[right.role];
  });

  if (plan.length > maxTotal) {
    throw new Error(
      `max_total_frames limit exceeded: planned ${plan.length} frames > ${maxTotal}`
    );
  }

  return plan;
}

/** Expected contact-sheet cell label for a frames-manifest entry (layout order only). */
export function contactSheetCellLabel(frame: {
  shot_id?: string;
  timestamp_ms: number;
}): string {
  return frame.shot_id !== undefined
    ? `${frame.shot_id}@${frame.timestamp_ms}ms`
    : `t=${frame.timestamp_ms}ms`;
}
