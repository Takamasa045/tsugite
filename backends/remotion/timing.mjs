export function audioTrackTiming(track, manifest, fps) {
  const start = track.start ?? 0;
  const end = track.end ?? totalDuration(manifest);
  return {
    from: secondsToTimelineFrame(start, fps),
    durationInFrames: secondsToFrames(Math.max(0.01, end - start), fps)
  };
}

export function totalDuration(manifest) {
  const clipDuration = manifest.clips.reduce((sum, clip) => sum + clip.duration, 0);
  return Math.max(manifest.meta.target_duration_seconds, clipDuration);
}

export function secondsToFrames(seconds, fps) {
  return Math.max(1, Math.round(seconds * fps));
}

export function secondsToTimelineFrame(seconds, fps) {
  return Math.max(0, Math.round(seconds * fps));
}
