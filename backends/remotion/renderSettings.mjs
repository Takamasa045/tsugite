const LONG_RENDER_FRAME_THRESHOLD = 100_000;

export function resolveRenderMediaSettings(composition) {
  const settings = { concurrency: 1 };

  if (composition?.durationInFrames >= LONG_RENDER_FRAME_THRESHOLD) {
    return {
      ...settings,
      concurrency: 4,
      imageFormat: "jpeg",
      jpegQuality: 50
    };
  }

  return settings;
}
