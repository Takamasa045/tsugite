const JPEG_RENDER_PIXEL_THRESHOLD = 1920 * 1080 * 300;

export const OFFTHREAD_VIDEO_FETCH_GUARD = Object.freeze({
  delayRenderRetries: 10,
  delayRenderTimeoutInMilliseconds: 180_000
});

export function resolveRenderMediaSettings(composition) {
  const settings = { concurrency: 1 };
  const renderPixels =
    (composition?.width ?? 0) *
    (composition?.height ?? 0) *
    (composition?.durationInFrames ?? 0);

  if (renderPixels >= JPEG_RENDER_PIXEL_THRESHOLD) {
    return {
      ...settings,
      concurrency: 1,
      imageFormat: "jpeg",
      jpegQuality: 90
    };
  }

  return settings;
}
