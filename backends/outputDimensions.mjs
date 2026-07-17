const RATIOS = {
  "16:9": 16 / 9,
  "9:16": 9 / 16
};

const CANONICAL = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 }
};

export function resolveOutputDimensions(manifest) {
  const aspect = manifest?.meta?.aspect;
  const targetRatio = RATIOS[aspect];
  const canonical = CANONICAL[aspect] ?? CANONICAL["16:9"];
  const source = manifest?.clips?.[0]?.resolution;

  if (!source || !targetRatio) return canonical;

  const sourceWidth = even(source.width);
  const sourceHeight = even(source.height);
  const sourceRatio = sourceWidth / sourceHeight;
  if (Math.abs(sourceRatio - targetRatio) < 0.001) {
    return { width: sourceWidth, height: sourceHeight };
  }

  if (aspect === "9:16") {
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

function even(value) {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}
