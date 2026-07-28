import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATURE_VIBE_REGGAE_FONT_PATH } from "./natureVibeAssets.mjs";
import { NATURE_VIBE_VISUALIZER_PRESET } from "./natureVibeVisualizer.js";

const backendDir = dirname(fileURLToPath(import.meta.url));

export async function stageNatureVibePublicAssets({ runDir, manifest }) {
  if (manifest?.presentation?.preset !== NATURE_VIBE_VISUALIZER_PRESET) return [];

  const source = join(backendDir, "assets", "fonts", "ReggaeOne-Regular.ttf");
  const target = resolve(runDir, NATURE_VIBE_REGGAE_FONT_PATH);
  await stat(source);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  return [NATURE_VIBE_REGGAE_FONT_PATH];
}
