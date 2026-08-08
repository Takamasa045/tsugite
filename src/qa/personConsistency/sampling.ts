/**
 * Deterministic sampling: shot boundaries + uniform interior frames.
 */
import type { SamplingFrame } from "./schema.js";

export type ShotTiming = {
  id: string;
  start_ms: number;
  end_ms: number;
};

/**
 * Build a deterministic sampling plan.
 * - Always includes boundary_start at start_ms
 * - Includes boundary_end at end_ms - 1 when duration allows (avoids double-count on zero-length)
 * - Adds uniform interior frames so total frames per shot is at most frames_per_shot
 * - frames_per_shot is clamped by caller policy to 1..12
 */
export function buildSamplingPlan(
  shots: readonly ShotTiming[],
  framesPerShot: number
): SamplingFrame[] {
  if (framesPerShot < 1 || framesPerShot > 12) {
    throw new Error("frames_per_shot must be between 1 and 12");
  }

  const plan: SamplingFrame[] = [];
  for (const shot of shots) {
    if (shot.end_ms <= shot.start_ms) {
      throw new Error(`shot '${shot.id}' has non-positive duration`);
    }
    const duration = shot.end_ms - shot.start_ms;
    const frames: SamplingFrame[] = [
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
      // Uniform interior samples exclusive of the already-selected endpoints.
      for (let i = 1; i <= remaining; i += 1) {
        const fraction = i / (remaining + 1);
        const timestamp_ms = shot.start_ms + Math.floor(duration * fraction);
        // Skip if it collides with an existing sample.
        if (frames.some((frame) => frame.timestamp_ms === timestamp_ms)) continue;
        frames.push({
          shot_id: shot.id,
          timestamp_ms,
          role: "uniform"
        });
      }
    }

    frames.sort((left, right) => left.timestamp_ms - right.timestamp_ms);
    plan.push(...frames);
  }
  return plan;
}
