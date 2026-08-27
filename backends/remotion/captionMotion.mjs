export function resolveCaptionStyle(manifest) {
  const style = manifest?.meta?.caption_style;
  if (style === "cinematic-impact" || style === "lyric-kinetic") return style;
  return "standard";
}

export function captionMotionState(caption, second, fps) {
  if (!caption || second < caption.start || second >= caption.end) {
    return { active: false, enter: 0, exit: 0, localFrame: 0, durationInFrames: 0 };
  }

  const localFrame = Math.max(0, (second - caption.start) * fps);
  const durationInFrames = Math.max(1, (caption.end - caption.start) * fps);
  const enter = clamp(localFrame / Math.min(12, durationInFrames / 3));
  const exitStart = Math.max(0, durationInFrames - 10);
  const exit = clamp((localFrame - exitStart) / Math.max(1, durationInFrames - exitStart));

  return { active: true, enter, exit, localFrame, durationInFrames };
}

export function lyricChunks(text) {
  const source = String(text ?? "").trim();
  if (!source) return [];
  const tokens = source.match(/「[^」]*」|[^\s　]+/g);
  return tokens && tokens.length > 0 ? tokens : [source];
}

export function lyricChunkStep(chunkCount, durationInFrames) {
  const count = Math.max(0, Math.floor(chunkCount));
  if (count <= 1) return 0;
  const frames = Math.max(1, durationInFrames);
  const holdFrames = Math.min(8, Math.max(1, Math.round(frames * 0.12)));
  const lastStart = Math.max(0, frames - holdFrames);
  const preferred = Math.min(5, Math.max(1, lastStart / count));
  return Math.min(preferred, lastStart / (count - 1));
}

export function lyricChunkReveal(chunkCount, localFrame, durationInFrames) {
  const count = Math.max(0, Math.floor(chunkCount));
  if (count === 0) return [];
  const step = lyricChunkStep(count, durationInFrames);
  return Array.from({ length: count }, (_, index) => (localFrame + 0.001 >= index * step ? 1 : 0));
}

export function captionSegments(text, emphasis = []) {
  const phrases = [...new Set(emphasis.filter(Boolean))];
  if (phrases.length === 0) return [{ text, emphasized: false }];

  const segments = [];
  let cursor = 0;
  while (cursor < text.length) {
    const matches = phrases
      .map((phrase) => ({ phrase, index: text.indexOf(phrase, cursor) }))
      .filter((match) => match.index >= 0)
      .sort((a, b) => a.index - b.index || b.phrase.length - a.phrase.length);
    const next = matches[0];
    if (!next) {
      segments.push({ text: text.slice(cursor), emphasized: false });
      break;
    }
    if (next.index > cursor) {
      segments.push({ text: text.slice(cursor, next.index), emphasized: false });
    }
    segments.push({ text: next.phrase, emphasized: true });
    cursor = next.index + next.phrase.length;
  }

  return segments;
}

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}
