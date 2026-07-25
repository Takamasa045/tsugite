/**
 * Mouth-frame cycling, shared by every editing backend so a character's speech
 * looks the same wherever it is rendered.
 *
 * The pattern walks closed -> half -> open -> half, which reads as speech without
 * needing real phoneme data.
 */

export const MOUTH_PATTERN = [0, 1, 2, 1];
export const DEFAULT_MOUTH_FPS = 8;

/** Frame-based entry point, for backends that count in frames. */
export function mouthFrameIndex(localFrame, fps, mouthFps = DEFAULT_MOUTH_FPS) {
  const framesPerMouthState = Math.max(1, Math.round(fps / mouthFps));
  return MOUTH_PATTERN[Math.floor(Math.max(0, localFrame) / framesPerMouthState) % MOUTH_PATTERN.length];
}

/** Seconds-based entry point, for backends whose timeline is seeked in seconds. */
export function mouthIndexAtSeconds(elapsedSeconds, mouthFps = DEFAULT_MOUTH_FPS) {
  const state = Math.floor(Math.max(0, elapsedSeconds) * mouthFps);
  return MOUTH_PATTERN[state % MOUTH_PATTERN.length];
}
