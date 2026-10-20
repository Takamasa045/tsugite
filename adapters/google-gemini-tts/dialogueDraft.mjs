import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = "gemini-3.8-flash";
const MAX_RESPONSE_BYTES = 128_000;

function requireText(value, label, max = 1000) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max) {
    throw new Error(`${label} must be nonempty and within ${max} UTF-8 bytes`);
  }
  return value.trim();
}

export function buildDialogueDraftRequest(brief) {
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) throw new Error("brief must be an object");
  const topic = requireText(brief.topic, "topic", 2000);
  const characters = brief.characters;
  if (!Array.isArray(characters) || characters.length !== 2) throw new Error("brief needs two characters");
  const personas = characters.map((character, index) => ({
    speaker: index === 0 ? "A" : "B",
    description: requireText(character?.description, `character ${index + 1}`, 1000)
  }));
  const targetSeconds = brief.target_seconds ?? 10;
  if (!Number.isInteger(targetSeconds) || targetSeconds < 3 || targetSeconds > 60) {
    throw new Error("target_seconds must be 3 to 60");
  }
  const input = [
    "次のブリーフから、日本語の自然な二人の会話台本を作ってください。",
    "説明文や舞台指示を台詞に混ぜず、短い応答と自然な間合いを優先してください。",
    "各発話に話者 A/B、読み上げる台詞 text、英語の短い声の演技指定 style を付けてください。",
    "事実を創作で補わず、ブリーフ内の条件を守ってください。",
    `目標尺: 約 ${targetSeconds} 秒。発話は2〜12個。`,
    `テーマ・目的: ${topic}`,
    ...personas.map((persona) => `${persona.speaker} の人物像: ${persona.description}`)
  ].join("\n");
  return {
    model: MODEL,
    input: [{ type: "user_input", content: [{ type: "text", text: input }] }],
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: {
        type: "object",
        properties: {
          turns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                speaker: { type: "string", enum: ["A", "B"] },
                text: { type: "string" },
                style: { type: "string" }
              },
              required: ["speaker", "text", "style"]
            }
          }
        },
        required: ["turns"]
      }
    },
    store: false
  };
}

export function parseDialogueDraft(interaction) {
  if (interaction?.status !== "completed") throw new Error("Gemini dialogue draft did not complete");
  const blocks = (interaction.steps ?? [])
    .filter((step) => step?.type === "model_output")
    .flatMap((step) => Array.isArray(step.content) ? step.content : [])
    .filter((block) => block?.type === "text" && typeof block.text === "string");
  const raw = blocks.length === 1 ? blocks[0].text : interaction.output_text;
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Gemini dialogue draft returned no bounded text");
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Gemini dialogue draft returned invalid JSON"); }
  if (!Array.isArray(parsed.turns) || parsed.turns.length < 2 || parsed.turns.length > 12) {
    throw new Error("Gemini dialogue draft needs 2 to 12 turns");
  }
  const turns = parsed.turns.map((turn) => {
    if (turn?.speaker !== "A" && turn?.speaker !== "B") throw new Error("draft speaker must be A or B");
    const text = requireText(turn.text, "turn text", 1000);
    if (/[\r\n]/.test(text)) throw new Error("draft turn text must be one line");
    return { speaker: turn.speaker, text, style: requireText(turn.style, "turn style", 200) };
  });
  if (!turns.some((turn) => turn.speaker === "A") || !turns.some((turn) => turn.speaker === "B")) {
    throw new Error("draft must contain both speakers");
  }
  return { model: MODEL, turns };
}

export async function generateDialogueDraft(brief, outputPath, options = {}) {
  const body = buildDialogueDraftRequest(brief);
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  try {
    await readFile(outputPath);
    throw new Error("dialogue draft output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const marker = `${outputPath}.submission`;
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await writeFile(marker, `${digest}\n`, { flag: "wx", mode: 0o600 });
  let response;
  try {
    response = await (options.fetchImpl ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(60_000)
    });
  } catch {
    throw new Error("Gemini dialogue submission outcome is unknown; inspect provider usage before retrying");
  }
  if (!response.ok) throw new Error(`Gemini dialogue request failed with HTTP ${response.status}`);
  const claimed = Number(response.headers.get("content-length"));
  if (Number.isFinite(claimed) && claimed > MAX_RESPONSE_BYTES) throw new Error("Gemini dialogue response is too large");
  const chunks = [];
  let size = 0;
  if (!response.body) throw new Error("Gemini dialogue response has no body");
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error("Gemini dialogue response is too large");
    chunks.push(chunk);
  }
  let interaction;
  try { interaction = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Gemini dialogue response is invalid JSON"); }
  const draft = parseDialogueDraft(interaction);
  await writeFile(outputPath, `${JSON.stringify(draft, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return draft;
}

export async function applyDialogueDraft(draftPath, projectPath) {
  const draft = JSON.parse(await readFile(draftPath, "utf8"));
  const turns = parseDialogueDraft({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(draft) }] }] });
  const yaml = YAML.parseDocument(await readFile(projectPath, "utf8"));
  if (yaml.getIn(["generation", "adapter"]) !== "google-gemini-tts"
    || yaml.getIn(["generation", "requests", 0, "operation"]) !== "voice") {
    throw new Error("target project is not a Gemini TTS voice project");
  }
  const manifestPath = resolve(dirname(projectPath), "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const duration = manifest.meta?.target_duration_seconds;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("target manifest duration is invalid");
  yaml.setIn(["generation", "requests", 0, "prompt"], turns.turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n"));
  yaml.setIn(["generation", "requests", 0, "params", "turn_styles"], turns.turns.map((turn) => turn.style));
  manifest.captions = turns.turns.map((turn, index) => ({
    id: index === 0 ? "dialogue" : `turn-${String(index + 1).padStart(2, "0")}`,
    start: Number((duration * index / turns.turns.length).toFixed(3)),
    end: Number((duration * (index + 1) / turns.turns.length).toFixed(3)),
    text: `${turn.speaker}: ${turn.text}`
  }));
  await writeFile(projectPath, String(yaml));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { turns: turns.turns.length, projectPath, manifestPath };
}
