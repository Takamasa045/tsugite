function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function createClipVolume(clip, durationInFrames, fps) {
  const treatment = clip?.audio_mix;
  if (!treatment) return undefined;

  const baseVolume = Math.max(0, treatment.volume ?? 1);
  const fadeInFrames = Math.max(0, Math.round((treatment.fade_in_seconds ?? 0) * fps));
  const fadeOutFrames = Math.max(0, Math.round((treatment.fade_out_seconds ?? 0) * fps));

  return (frame) => {
    const fadeIn = fadeInFrames === 0 ? 1 : clamp01(frame / fadeInFrames);
    const framesRemaining = Math.max(0, durationInFrames - 1 - frame);
    const fadeOut = fadeOutFrames === 0 ? 1 : clamp01(framesRemaining / fadeOutFrames);
    return baseVolume * Math.min(fadeIn, fadeOut);
  };
}
