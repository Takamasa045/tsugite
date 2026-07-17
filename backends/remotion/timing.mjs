export function audioTrackTiming(track, manifest, fps) {
  const start = track.start ?? 0;
  const end = track.end ?? totalDuration(manifest);
  return {
    from: secondsToTimelineFrame(start, fps),
    durationInFrames: secondsToFrames(Math.max(0.01, end - start), fps)
  };
}

export function clipSequenceTimings(clips, fps) {
  if (clips.length === 0) return [];

  const totalClipDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  const finalFrame = secondsToFrames(totalClipDuration, fps);
  let outputSeconds = 0;
  let previousFrame = 0;

  return clips.map((clip, index) => {
    outputSeconds += clip.duration;
    const nextFrame = index === clips.length - 1
      ? finalFrame
      : secondsToTimelineFrame(outputSeconds, fps);
    const timing = {
      from: previousFrame,
      durationInFrames: Math.max(0, nextFrame - previousFrame),
      trimBefore: secondsToTimelineFrame(clip.in ?? 0, fps)
    };
    previousFrame = nextFrame;
    return timing;
  });
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
