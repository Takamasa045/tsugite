import type { Manifest } from "./schema.js";

const ratios = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
  "4:5": 4 / 5,
  "3:4": 3 / 4,
  "5:4": 5 / 4
} as const;

const canonical = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "3:4": { width: 810, height: 1080 },
  "5:4": { width: 1350, height: 1080 }
} as const;

export function resolveOutputDimensions(manifest: Manifest): { width: number; height: number } {
  const aspect = manifest.meta.aspect;
  const targetRatio = ratios[aspect];
  const fallback = canonical[aspect];
  const source = manifest.clips[0]?.resolution;

  if (!source) return fallback;

  const sourceWidth = even(source.width);
  const sourceHeight = even(source.height);
  const sourceRatio = sourceWidth / sourceHeight;
  if (Math.abs(sourceRatio - targetRatio) < 0.001) {
    return { width: sourceWidth, height: sourceHeight };
  }

  if (aspect === "9:16" || aspect === "4:5" || aspect === "3:4") {
    return {
      width: even(sourceHeight * targetRatio),
      height: sourceHeight
    };
  }

  return {
    width: sourceWidth,
    height: even(sourceWidth / targetRatio)
  };
}

function even(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}
