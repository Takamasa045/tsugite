export const ARTICLE_DIALOGUE_PRESET = "article-dialogue-16x9";

export function designScale(width, height) {
  return Math.min(width / 1920, height / 1080);
}

export function activeCaptionAt(captions, second) {
  return (captions ?? []).find((caption) => second >= caption.start && second < caption.end);
}

const MOUTH_PATTERN = [0, 1, 2, 1];

export function mouthFrameIndex(localFrame, fps, mouthFps = 8) {
  const framesPerMouthState = Math.max(1, Math.round(fps / mouthFps));
  return MOUTH_PATTERN[Math.floor(Math.max(0, localFrame) / framesPerMouthState) % MOUTH_PATTERN.length];
}

export function resolveSpeakerImage(speaker, caption, images, frame = 0, fps = 30, mouthFps = 8) {
  if (!speaker) return undefined;
  const isActive = caption?.speaker === speaker.id;
  const requestedPose = isActive ? caption.pose : undefined;
  const localFrame = isActive ? Math.max(0, frame - Math.round((caption?.start ?? 0) * fps)) : 0;
  const imageId =
    (isActive && speaker.mouth_frames?.length === 3
      ? speaker.mouth_frames[mouthFrameIndex(localFrame, fps, mouthFps)]
      : undefined) ??
    (requestedPose ? speaker.poses?.[requestedPose] : undefined) ??
    speaker.poses?.neutral ??
    Object.values(speaker.poses ?? {})[0];
  return (images ?? []).find((image) => image.id === imageId);
}

export function emphasizedTextParts(text, emphasis = []) {
  const terms = [...new Set(emphasis.filter((term) => term.length > 0))].sort((left, right) => right.length - left.length);
  if (terms.length === 0) return [{ text, emphasized: false }];
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "g");
  return text
    .split(pattern)
    .filter(Boolean)
    .map((part) => ({ text: part, emphasized: terms.includes(part) }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
