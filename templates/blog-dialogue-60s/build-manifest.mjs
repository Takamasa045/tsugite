import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function buildManifest(config, dialogue) {
  validateConfig(config);
  validateDialogue(config, dialogue);

  return {
    meta: {
      aspect: config.aspect,
      fps: config.fps,
      target_duration_seconds: config.duration_seconds,
      slug: config.slug
    },
    clips: [
      {
        id: config.background.id,
        src: config.background.src,
        in: 0,
        out: config.duration_seconds,
        duration: config.duration_seconds,
        fps: config.fps,
        resolution: config.background.resolution,
        audio: false
      }
    ],
    images: structuredClone(config.images),
    speakers: structuredClone(config.speakers),
    presentation: structuredClone(config.presentation),
    audio: structuredClone(config.audio ?? { bgm: [], narration: [], sfx: [] }),
    captions: structuredClone(dialogue),
    chapters: structuredClone(config.chapters ?? []),
    provenance: structuredClone(config.provenance ?? [])
  };
}

export function validateDialogue(config, dialogue) {
  if (!Array.isArray(dialogue) || dialogue.length === 0) {
    throw new Error("dialogue must contain at least one segment");
  }

  const speakerIds = new Set(config.speakers.map((speaker) => speaker.id));
  const segmentIds = new Set();
  let previousEnd = 0;

  for (const [index, segment] of dialogue.entries()) {
    if (!segment || typeof segment !== "object") throw new Error(`dialogue segment ${index + 1} must be an object`);
    if (typeof segment.id !== "string" || segment.id.length === 0) throw new Error(`dialogue segment ${index + 1} needs an id`);
    if (segmentIds.has(segment.id)) throw new Error(`duplicate dialogue id '${segment.id}'`);
    segmentIds.add(segment.id);
    if (!speakerIds.has(segment.speaker)) throw new Error(`dialogue segment '${segment.id}' references an unknown speaker`);
    if (typeof segment.text !== "string" || segment.text.trim().length === 0) {
      throw new Error(`dialogue segment '${segment.id}' needs text`);
    }
    if ([...segment.text].length > 48) {
      throw new Error(`dialogue segment '${segment.id}' must be 48 characters or fewer`);
    }
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) {
      throw new Error(`dialogue segment '${segment.id}' has invalid timing`);
    }
    if (segment.start < previousEnd - 0.001) throw new Error(`dialogue segment '${segment.id}' overlaps the previous segment`);
    if (segment.start > previousEnd + 0.001) throw new Error(`dialogue segment '${segment.id}' leaves a gap`);
    previousEnd = segment.end;
  }

  if (Math.abs(previousEnd - config.duration_seconds) > 0.001) {
    throw new Error("dialogue must cover the full 60 seconds");
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("video config must be an object");
  if (config.aspect !== "16:9") throw new Error("blog dialogue template requires a 16:9 aspect");
  if (config.duration_seconds !== 60) throw new Error("blog dialogue template must be exactly 60 seconds");
  if (!Number.isFinite(config.fps) || config.fps <= 0) throw new Error("video config fps must be positive");
  if (!config.background?.src || !config.background?.resolution) throw new Error("video config needs a background clip");
  if (!Array.isArray(config.images) || config.images.length < 2) throw new Error("video config needs character images");
  if (!Array.isArray(config.speakers) || config.speakers.length !== 2) throw new Error("video config needs two speakers");
  const imageIds = new Set(config.images.map((image) => image.id));
  for (const speaker of config.speakers) {
    if (!Array.isArray(speaker.mouth_frames) || speaker.mouth_frames.length !== 3) {
      throw new Error(`speaker '${speaker.id}' needs closed, half-open, and open mouth frames`);
    }
    for (const imageId of speaker.mouth_frames) {
      if (!imageIds.has(imageId)) throw new Error(`speaker '${speaker.id}' references unknown mouth frame '${imageId}'`);
    }
  }
  const sides = new Set(config.speakers.map((speaker) => speaker.side));
  if (!sides.has("left") || !sides.has("right")) throw new Error("video config needs left and right speakers");
  if (config.presentation?.preset !== "article-dialogue-16x9") {
    throw new Error("video config must select the article-dialogue-16x9 preset");
  }
}

async function main() {
  const templateDir = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
  const [config, dialogue] = await Promise.all([
    readJson(join(templateDir, "video.json")),
    readJson(join(templateDir, "dialogue_60s.json"))
  ]);
  const manifest = buildManifest(config, dialogue);
  const outputPath = join(templateDir, "manifest.json");
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${outputPath}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
