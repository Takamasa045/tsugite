import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CAPTION_CHARS = 48;
const DEFAULT_DURATION_PER_QA = 10;
const DEFAULT_QUESTION_RATIO = 0.35;
const DEFAULT_INTRO_SECONDS = 4;
const DEFAULT_OUTRO_SECONDS = 4;

/**
 * Expand a high-level Q&A list into a Remotion article-dialogue manifest.
 * @param {object} config video.json
 * @param {object} qa qa.json
 */
export function buildManifest(config, qa) {
  validateConfig(config);
  const dialogue = expandQaToDialogue(config, qa);
  const durationSeconds = applyTargetDuration(dialogue, config.duration_seconds);
  validateDialogue(config, dialogue.captions, durationSeconds);

  return {
    meta: {
      aspect: config.aspect,
      fps: config.fps,
      target_duration_seconds: durationSeconds,
      slug: config.slug
    },
    clips: [
      {
        id: config.background.id,
        src: config.background.src,
        in: 0,
        out: durationSeconds,
        duration: durationSeconds,
        fps: config.fps,
        resolution: config.background.resolution,
        audio: false
      }
    ],
    images: structuredClone(config.images),
    speakers: structuredClone(config.speakers),
    presentation: {
      ...structuredClone(config.presentation),
      title: qa.title ?? config.presentation?.title,
      source_title: qa.source_title ?? config.presentation?.source_title,
      source_url: qa.source_url ?? config.presentation?.source_url,
      label: qa.label ?? config.presentation?.label ?? "Q&A DIALOGUE",
      draft: config.presentation?.draft ?? true
    },
    audio: structuredClone(config.audio ?? { bgm: [], narration: [], sfx: [] }),
    captions: dialogue.captions,
    chapters: dialogue.chapters,
    provenance: structuredClone(config.provenance ?? [])
  };
}

/**
 * Convert qa.json into timed captions + chapters.
 */
export function expandQaToDialogue(config, qa) {
  if (!qa || typeof qa !== "object") throw new Error("qa config must be an object");
  if (typeof qa.title !== "string" || qa.title.trim().length === 0) {
    throw new Error("qa.title is required");
  }
  if (!Array.isArray(qa.qa_list) || qa.qa_list.length === 0) {
    throw new Error("qa.qa_list must contain at least one item");
  }

  const speakerIds = new Set(config.speakers.map((speaker) => speaker.id));
  const roles = {
    questioner: qa.roles?.questioner ?? config.roles?.questioner ?? defaultSpeakerOnSide(config, "left"),
    answerer: qa.roles?.answerer ?? config.roles?.answerer ?? defaultSpeakerOnSide(config, "right")
  };
  if (!speakerIds.has(roles.questioner)) throw new Error(`unknown questioner '${roles.questioner}'`);
  if (!speakerIds.has(roles.answerer)) throw new Error(`unknown answerer '${roles.answerer}'`);

  const durationPerQa = positiveNumber(qa.duration_per_qa, DEFAULT_DURATION_PER_QA, "duration_per_qa");
  const questionRatio = clamp(positiveNumber(qa.question_ratio, DEFAULT_QUESTION_RATIO, "question_ratio"), 0.15, 0.6);
  const captions = [];
  const chapters = [];
  let cursor = 0;
  let captionIndex = 1;

  const intro = normalizeBeat(qa.intro, {
    text: "今日はよくある質問にテンポよく答えるよ",
    speaker: roles.answerer,
    seconds: DEFAULT_INTRO_SECONDS,
    visual: {
      kicker: "FAQ",
      headline: qa.title,
      detail: qa.subtitle ?? "Q&A 掛け合い解説",
      image_id: qa.intro?.image_id,
      steps: qa.intro?.steps ?? []
    }
  });
  if (intro) {
    assertCaptionText(intro.text, "intro");
    if (!speakerIds.has(intro.speaker)) throw new Error(`intro references unknown speaker '${intro.speaker}'`);
    captions.push({
      id: `s${String(captionIndex++).padStart(2, "0")}`,
      speaker: intro.speaker,
      text: intro.text,
      tts_text: intro.tts_text ?? intro.text,
      start: roundTime(cursor),
      end: roundTime(cursor + intro.seconds),
      pose: intro.pose ?? "neutral",
      emphasis: intro.emphasis ?? [],
      visual: {
        ...intro.visual,
        image_id: intro.visual?.image_id ?? qa.intro?.image_id,
        steps: intro.visual?.steps ?? qa.intro?.steps ?? []
      }
    });
    chapters.push({ title: "Intro", start: roundTime(cursor), end: roundTime(cursor + intro.seconds) });
    cursor += intro.seconds;
  }

  for (const [index, item] of qa.qa_list.entries()) {
    if (!item || typeof item !== "object") throw new Error(`qa_list item ${index + 1} must be an object`);
    const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `q${String(index + 1).padStart(2, "0")}`;
    const question = typeof item.q === "string" ? item.q.trim() : "";
    if (!question) throw new Error(`qa_list item '${id}' needs q`);
    assertCaptionText(question, `qa_list.${id}.q`);

    const answerLines = normalizeAnswerLines(item, id);
    const itemDuration = positiveNumber(item.duration, durationPerQa, `qa_list.${id}.duration`);
    const questionSeconds = roundTime(itemDuration * questionRatio);
    const answerBudget = roundTime(itemDuration - questionSeconds);
    if (questionSeconds <= 0 || answerBudget <= 0) {
      throw new Error(`qa_list item '${id}' needs a longer duration`);
    }

    const qaStart = cursor;
    const questioner = item.q_speaker ?? roles.questioner;
    const answerer = item.a_speaker ?? roles.answerer;
    if (!speakerIds.has(questioner)) throw new Error(`qa_list item '${id}' has unknown q_speaker`);
    if (!speakerIds.has(answerer)) throw new Error(`qa_list item '${id}' has unknown a_speaker`);

    const sharedVisual = {
      image_id: item.image_id,
      steps: item.steps ?? [],
      badges: item.highlights ?? item.badges ?? []
    };

    captions.push({
      id: `s${String(captionIndex++).padStart(2, "0")}`,
      speaker: questioner,
      text: question,
      tts_text: item.q_tts ?? question,
      start: roundTime(cursor),
      end: roundTime(cursor + questionSeconds),
      pose: item.q_pose ?? "curious",
      emphasis: item.emphasis_q ?? [],
      visual: {
        kicker: item.q_kicker ?? "QUESTION",
        headline: item.q_headline ?? question,
        detail: item.q_detail ?? `Q${index + 1}`,
        ...sharedVisual,
        badges: item.badges ?? []
      }
    });
    cursor += questionSeconds;

    const perAnswer = answerLines.length === 1 ? answerBudget : roundTime(answerBudget / answerLines.length);
    let answerSpent = 0;
    for (const [lineIndex, line] of answerLines.entries()) {
      const isLast = lineIndex === answerLines.length - 1;
      const seconds = isLast ? roundTime(answerBudget - answerSpent) : perAnswer;
      if (seconds <= 0) throw new Error(`qa_list item '${id}' answer timing collapsed`);
      captions.push({
        id: `s${String(captionIndex++).padStart(2, "0")}`,
        speaker: answerer,
        text: line.text,
        tts_text: line.tts_text ?? line.text,
        start: roundTime(cursor),
        end: roundTime(cursor + seconds),
        pose: item.a_pose ?? "explain",
        emphasis: line.emphasis ?? item.emphasis_a ?? [],
        visual: {
          kicker: item.a_kicker ?? "ANSWER",
          headline: line.headline ?? line.text,
          detail: item.detail ?? item.a_detail ?? qa.subtitle ?? "ポイント",
          ...sharedVisual,
          steps: line.steps ?? item.steps ?? [],
          badges: line.badges ?? item.highlights ?? item.badges ?? []
        }
      });
      cursor += seconds;
      answerSpent = roundTime(answerSpent + seconds);
    }

    chapters.push({
      title: item.chapter_title ?? `Q${index + 1}`,
      start: roundTime(qaStart),
      end: roundTime(cursor)
    });
  }

  const outro = normalizeBeat(qa.outro, {
    text: "詳しくはドキュメントで確認してね",
    speaker: roles.answerer,
    seconds: DEFAULT_OUTRO_SECONDS,
    visual: {
      kicker: "NEXT",
      headline: qa.cta_headline ?? "次の一歩",
      detail: qa.cta_detail ?? "公式ドキュメントへ",
      image_id: qa.outro?.image_id,
      steps: qa.outro?.steps ?? []
    }
  });
  if (outro) {
    assertCaptionText(outro.text, "outro");
    if (!speakerIds.has(outro.speaker)) throw new Error(`outro references unknown speaker '${outro.speaker}'`);
    captions.push({
      id: `s${String(captionIndex++).padStart(2, "0")}`,
      speaker: outro.speaker,
      text: outro.text,
      tts_text: outro.tts_text ?? outro.text,
      start: roundTime(cursor),
      end: roundTime(cursor + outro.seconds),
      pose: outro.pose ?? "smile",
      emphasis: outro.emphasis ?? [],
      visual: {
        ...outro.visual,
        image_id: outro.visual?.image_id ?? qa.outro?.image_id,
        steps: outro.visual?.steps ?? qa.outro?.steps ?? []
      }
    });
    chapters.push({ title: "Outro", start: roundTime(cursor), end: roundTime(cursor + outro.seconds) });
    cursor += outro.seconds;
  }

  return {
    captions,
    chapters,
    durationSeconds: roundTime(cursor)
  };
}

/**
 * Pad the final caption/chapter when video.json declares a longer fixed duration
 * (e.g. a 60s background clip). Never shortens content.
 */
export function applyTargetDuration(dialogue, targetDuration) {
  if (targetDuration === undefined || targetDuration === null) {
    return dialogue.durationSeconds;
  }
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    throw new Error("video config duration_seconds must be a positive number");
  }
  const target = roundTime(targetDuration);
  if (target + 0.001 < dialogue.durationSeconds) {
    throw new Error(
      `qa content needs ${dialogue.durationSeconds}s but duration_seconds is only ${target}s`
    );
  }
  if (Math.abs(target - dialogue.durationSeconds) <= 0.001) {
    return target;
  }

  const lastCaption = dialogue.captions.at(-1);
  const lastChapter = dialogue.chapters.at(-1);
  if (!lastCaption) throw new Error("cannot pad an empty dialogue");
  lastCaption.end = target;
  if (lastChapter) lastChapter.end = target;
  dialogue.durationSeconds = target;
  return target;
}

function normalizeAnswerLines(item, id) {
  if (Array.isArray(item.a_lines) && item.a_lines.length > 0) {
    return item.a_lines.map((line, index) => {
      if (typeof line === "string") {
        const text = line.trim();
        if (!text) throw new Error(`qa_list item '${id}' a_lines[${index}] is empty`);
        assertCaptionText(text, `qa_list.${id}.a_lines[${index}]`);
        return { text };
      }
      if (!line || typeof line !== "object" || typeof line.text !== "string" || !line.text.trim()) {
        throw new Error(`qa_list item '${id}' a_lines[${index}] needs text`);
      }
      const text = line.text.trim();
      assertCaptionText(text, `qa_list.${id}.a_lines[${index}]`);
      return {
        text,
        tts_text: line.tts_text,
        headline: line.headline,
        emphasis: line.emphasis
      };
    });
  }

  const answer = typeof item.a === "string" ? item.a.trim() : "";
  if (!answer) throw new Error(`qa_list item '${id}' needs a or a_lines`);
  assertCaptionText(answer, `qa_list.${id}.a`);
  return [{ text: answer, headline: item.a_headline }];
}

function normalizeBeat(value, fallback) {
  if (value === false || value === null) return null;
  const source = value && typeof value === "object" ? value : {};
  const seconds = positiveNumber(source.seconds, fallback.seconds, "beat.seconds");
  if (seconds <= 0) return null;
  return {
    text: typeof source.text === "string" && source.text.trim() ? source.text.trim() : fallback.text,
    speaker: source.speaker ?? fallback.speaker,
    seconds,
    tts_text: source.tts_text,
    pose: source.pose,
    emphasis: source.emphasis,
    visual: {
      kicker: source.visual?.kicker ?? fallback.visual.kicker,
      headline: source.visual?.headline ?? fallback.visual.headline,
      detail: source.visual?.detail ?? fallback.visual.detail,
      badges: source.visual?.badges ?? fallback.visual.badges ?? [],
      image_id: source.visual?.image_id ?? source.image_id ?? fallback.visual.image_id,
      steps: source.visual?.steps ?? source.steps ?? fallback.visual.steps ?? []
    }
  };
}

export function validateDialogue(config, dialogue, durationSeconds) {
  if (!Array.isArray(dialogue) || dialogue.length === 0) {
    throw new Error("dialogue must contain at least one segment");
  }

  const speakerIds = new Set(config.speakers.map((speaker) => speaker.id));
  const segmentIds = new Set();
  let previousEnd = 0;

  for (const [index, segment] of dialogue.entries()) {
    if (!segment || typeof segment !== "object") throw new Error(`dialogue segment ${index + 1} must be an object`);
    if (typeof segment.id !== "string" || segment.id.length === 0) {
      throw new Error(`dialogue segment ${index + 1} needs an id`);
    }
    if (segmentIds.has(segment.id)) throw new Error(`duplicate dialogue id '${segment.id}'`);
    segmentIds.add(segment.id);
    if (!speakerIds.has(segment.speaker)) {
      throw new Error(`dialogue segment '${segment.id}' references an unknown speaker`);
    }
    if (typeof segment.text !== "string" || segment.text.trim().length === 0) {
      throw new Error(`dialogue segment '${segment.id}' needs text`);
    }
    assertCaptionText(segment.text, `dialogue.${segment.id}`);
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) {
      throw new Error(`dialogue segment '${segment.id}' has invalid timing`);
    }
    if (segment.start < previousEnd - 0.001) throw new Error(`dialogue segment '${segment.id}' overlaps the previous segment`);
    if (segment.start > previousEnd + 0.001) throw new Error(`dialogue segment '${segment.id}' leaves a gap`);
    if (!segment.visual?.headline) throw new Error(`dialogue segment '${segment.id}' needs visual.headline`);
    previousEnd = segment.end;
  }

  if (Math.abs(previousEnd - durationSeconds) > 0.001) {
    throw new Error("dialogue must cover the full target duration");
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("video config must be an object");
  if (config.aspect !== "16:9") throw new Error("qa dialogue template requires a 16:9 aspect");
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

function defaultSpeakerOnSide(config, side) {
  const speaker = config.speakers.find((entry) => entry.side === side);
  if (!speaker) throw new Error(`no speaker on side '${side}'`);
  return speaker.id;
}

function assertCaptionText(text, path) {
  if ([...text].length > MAX_CAPTION_CHARS) {
    throw new Error(`${path} must be ${MAX_CAPTION_CHARS} characters or fewer`);
  }
}

function positiveNumber(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
  return value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTime(value) {
  return Math.round(value * 1000) / 1000;
}

async function main() {
  const templateDir = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
  const [config, qa] = await Promise.all([
    readJson(join(templateDir, "video.json")),
    readJson(join(templateDir, "qa.json"))
  ]);
  const manifest = buildManifest(config, qa);
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
