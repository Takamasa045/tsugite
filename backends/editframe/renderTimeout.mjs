export const RENDER_TIMEOUT_MS = 90_000;
const RENDER_TIMEOUT_BASE_MS = 60_000;
const RENDER_TIMEOUT_PER_FRAME_MS = 400;
const RENDER_TIMEOUT_MAX_MS = 30 * 60_000;

// renderLocal captures frames serially, so the budget must grow with frame count.
export function renderTimeoutMs(manifest) {
  const seconds = Number(manifest?.meta?.target_duration_seconds);
  const fps = Number(manifest?.meta?.fps);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(fps) || fps <= 0) return RENDER_TIMEOUT_MS;
  const frames = Math.ceil(seconds * fps);
  return Math.min(RENDER_TIMEOUT_MAX_MS, Math.max(RENDER_TIMEOUT_MS, RENDER_TIMEOUT_BASE_MS + frames * RENDER_TIMEOUT_PER_FRAME_MS));
}
