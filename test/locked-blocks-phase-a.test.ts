/**
 * Phase A: locked_blocks schema, hash validate, verbatim inject, lineage, lock-block CLI.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import {
  compileH3Request,
  parseH3CreativeIr,
  renderH3Prompt,
  sha256Text,
  validateH3CreativeIr,
  type H3CreativeIr
} from "../src/h3/index.js";
import {
  LOCK_HASH_MISMATCH_CODE,
  collectLockedBlockHashes,
  hashLockedText,
  validateLockedBlocks
} from "../src/videoPromptDirector/lockedBlocks.js";
import { lockSubjectBlock } from "../src/videoPromptDirector/lockBlock.js";
import { renderPlainPrompt } from "../src/videoPromptDirector/render/plain.js";
import type { GenerationRequest } from "../src/project/schema.js";

const VOICE_TEXT = "Low baritone, steady tempo, slight coastal accent, never rushed.";
const APPEARANCE_TEXT = "Weathered mid-40s man, salt-and-pepper stubble, grey wool coat, scar above left brow.";
const MANNER_TEXT = "Shoulders set forward; eyes fix on the listener before speaking; one slow nod after each clause.";

function withLocks(
  base: H3CreativeIr,
  locks: {
    voice?: string;
    appearance?: string;
    manner?: string;
    mutateSha?: Partial<Record<"voice" | "appearance" | "manner", string>>;
  }
): H3CreativeIr {
  const subject = base.subjects[0];
  if (!subject) throw new Error("fixture needs a subject");
  const locked_blocks: NonNullable<H3CreativeIr["subjects"][number]["locked_blocks"]> = {};
  if (locks.voice !== undefined) {
    locked_blocks.voice = {
      text: locks.voice,
      sha256: locks.mutateSha?.voice ?? hashLockedText(locks.voice)
    };
  }
  if (locks.appearance !== undefined) {
    locked_blocks.appearance = {
      text: locks.appearance,
      sha256: locks.mutateSha?.appearance ?? hashLockedText(locks.appearance)
    };
  }
  if (locks.manner !== undefined) {
    locked_blocks.manner = {
      text: locks.manner,
      sha256: locks.mutateSha?.manner ?? hashLockedText(locks.manner)
    };
  }
  return {
    ...base,
    subjects: [
      {
        ...subject,
        locked_blocks
      },
      ...base.subjects.slice(1)
    ]
  };
}

async function loadT2v(): Promise<H3CreativeIr> {
  const raw = JSON.parse(await readFile(join("test/fixtures/h3/t2v.json"), "utf8"));
  return parseH3CreativeIr(raw);
}

function h3Request(id: string, ir: H3CreativeIr): GenerationRequest {
  return { id, prompt: "", params: {}, h3: ir };
}

async function captureCli(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const status = await main(args);
  const stdout = log.mock.calls.map((call) => String(call[0])).join("\n");
  const stderr = error.mock.calls.map((call) => String(call[0])).join("\n");
  log.mockRestore();
  error.mockRestore();
  return { status, stdout, stderr };
}

describe("Phase A locked_blocks", () => {
  it("accepts optional locked_blocks with matching sha256", async () => {
    const ir = withLocks(await loadT2v(), {
      voice: VOICE_TEXT,
      appearance: APPEARANCE_TEXT,
      manner: MANNER_TEXT
    });
    expect(parseH3CreativeIr(ir).subjects[0]?.locked_blocks?.voice?.text).toBe(VOICE_TEXT);
    expect(validateLockedBlocks(ir)).toEqual([]);
    const rendered = renderH3Prompt(ir);
    const validation = validateH3CreativeIr(ir, { renderedText: rendered.text });
    expect(validation.errors, JSON.stringify(validation.errors)).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("rejects unknown locked_blocks keys via strict schema", async () => {
    const base = await loadT2v();
    const bad = {
      ...base,
      subjects: [
        {
          ...base.subjects[0],
          locked_blocks: {
            voice: { text: VOICE_TEXT, sha256: hashLockedText(VOICE_TEXT) },
            extra: { text: "nope", sha256: hashLockedText("nope") }
          }
        }
      ]
    };
    expect(() => parseH3CreativeIr(bad)).toThrow();
  });

  it("LOCK-E001 when voice text is altered but sha256 is stale", async () => {
    const ir = withLocks(await loadT2v(), {
      voice: VOICE_TEXT,
      mutateSha: { voice: hashLockedText(VOICE_TEXT) }
    });
    // Mutate text after computing the "stale" hash to simulate silent rewrite.
    ir.subjects[0]!.locked_blocks!.voice!.text = `${VOICE_TEXT} CHANGED`;

    const issues = validateLockedBlocks(ir);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe(LOCK_HASH_MISMATCH_CODE);
    expect(issues[0]?.path).toEqual(["subjects", 0, "locked_blocks", "voice", "sha256"]);

    const full = validateH3CreativeIr(ir);
    expect(full.ok).toBe(false);
    expect(full.errors.some((item) => item.code === LOCK_HASH_MISMATCH_CODE)).toBe(true);

    const compiled = compileH3Request(h3Request("lock-mismatch", ir));
    expect(compiled.ok).toBe(false);
    expect(compiled.issues.some((item) => item.code === LOCK_HASH_MISMATCH_CODE)).toBe(true);
  });

  it("compile injects voice/appearance/manner verbatim on dialogue shots", async () => {
    const ir = withLocks(await loadT2v(), {
      voice: VOICE_TEXT,
      appearance: APPEARANCE_TEXT,
      manner: MANNER_TEXT
    });
    const compiled = compileH3Request(h3Request("lock-inject", ir));
    expect(compiled.ok).toBe(true);
    const prompt = compiled.compilation!.canonical_prompt;
    expect(prompt).toContain(VOICE_TEXT);
    expect(prompt).toContain(APPEARANCE_TEXT);
    expect(prompt).toContain(MANNER_TEXT);
    expect(prompt).toContain("VOICE:\n" + VOICE_TEXT);
    expect(prompt).toContain("CHARACTER APPEARANCE:\n" + APPEARANCE_TEXT);
    expect(prompt).toContain("CHARACTER MANNER:\n" + MANNER_TEXT);
    // Dialogue lock_text still preserved.
    expect(prompt).toContain(
      "<d>[Japanese]AIと自然が、やっと同じ場所で動き始めた。</d>"
    );
  });

  it("does not paraphrase locked text (trailing space and newlines preserved)", async () => {
    const voice = "register mid  \ntempo slow  ";
    const ir = withLocks(await loadT2v(), { voice });
    const prompt = renderH3Prompt(ir).text;
    expect(prompt).toContain(voice);
    expect(prompt).toContain(`VOICE:\n${voice}`);
  });

  it("records locked_block_hashes on lineage", async () => {
    const ir = withLocks(await loadT2v(), {
      voice: VOICE_TEXT,
      appearance: APPEARANCE_TEXT
    });
    const compiled = compileH3Request(h3Request("lock-lineage", ir));
    expect(compiled.ok).toBe(true);
    expect(compiled.compilation!.lineage.locked_block_hashes).toEqual({
      "hero.voice": hashLockedText(VOICE_TEXT),
      "hero.appearance": hashLockedText(APPEARANCE_TEXT)
    });
    expect(collectLockedBlockHashes(ir)).toEqual(
      compiled.compilation!.lineage.locked_block_hashes
    );
  });

  it("omits locked_block_hashes when no locked_blocks present", async () => {
    const ir = await loadT2v();
    const compiled = compileH3Request(h3Request("no-lock", ir));
    expect(compiled.ok).toBe(true);
    expect(compiled.compilation!.lineage.locked_block_hashes).toBeUndefined();
  });

  it("plain renderer also injects locked blocks", async () => {
    const ir = withLocks(await loadT2v(), {
      voice: VOICE_TEXT,
      appearance: APPEARANCE_TEXT,
      manner: MANNER_TEXT
    });
    const plain = renderPlainPrompt(ir);
    expect(plain.text).toContain(VOICE_TEXT);
    expect(plain.text).toContain(APPEARANCE_TEXT);
    expect(plain.text).toContain(MANNER_TEXT);
  });

  it("IR without locked_blocks matches baseline t2v render", async () => {
    const ir = await loadT2v();
    const golden = JSON.parse(
      await readFile(join("test/fixtures/h3/goldens/t2v.json"), "utf8")
    ) as { canonical_prompt: string };
    expect(renderH3Prompt(ir).text).toBe(golden.canonical_prompt);
  });

  it("lockSubjectBlock writes sha256 and preserves unrelated fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsugite-lock-block-"));
    const configPath = join(dir, "project.yaml");
    const intent = "keep-this-intent-marker";
    await writeFile(
      configPath,
      [
        "slug: lock-block-demo",
        "title: Lock Block Demo",
        "aspect: \"16:9\"",
        "duration_seconds: 10",
        "manifest: manifest.json",
        "generation:",
        "  requests:",
        "    - id: shot_a",
        "      prompt: \"\"",
        "      creative:",
        `        intent: ${intent}`,
        "      h3:",
        "        version: 1",
        "        target:",
        "          model: minimax-h3",
        "          mode: text-to-video",
        "          duration: 6",
        "          quality: 1440p",
        "          aspect: \"16:9\"",
        "          audio: true",
        "        subjects:",
        "          - id: hero",
        "            description: Japanese man",
        "            speaker_id: S1",
        "        assets: []",
        "        shots:",
        "          - id: s1",
        "            start_ms: 0",
        "            end_ms: 6000",
        "            visual: A man stands by the lake.",
        "        sound:",
        "          soundscape: wind",
        "          music:",
        "            enabled: false",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await lockSubjectBlock({
      configPath,
      subjectId: "hero",
      field: "voice",
      text: VOICE_TEXT,
      requestId: "shot_a"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.sha256).toBe(hashLockedText(VOICE_TEXT));
    expect(result.sha256).toBe(sha256Text(VOICE_TEXT));

    const written = await readFile(configPath, "utf8");
    expect(written).toContain(intent);
    expect(written).toContain("lock-block-demo");
    expect(written).toContain(VOICE_TEXT);
    expect(written).toContain(result.sha256);
  });

  it("CLI lock-block updates project yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsugite-lock-cli-"));
    const configPath = join(dir, "project.yaml");
    await writeFile(
      configPath,
      [
        "slug: lock-cli",
        "title: Lock CLI",
        "aspect: \"16:9\"",
        "duration_seconds: 6",
        "manifest: manifest.json",
        "generation:",
        "  requests:",
        "    - id: r1",
        "      prompt: \"\"",
        "      h3:",
        "        version: 1",
        "        target:",
        "          model: minimax-h3",
        "          mode: text-to-video",
        "          duration: 6",
        "          quality: 1440p",
        "          aspect: \"16:9\"",
        "          audio: true",
        "        subjects:",
        "          - id: cal",
        "            description: sailor",
        "            speaker_id: S1",
        "        assets: []",
        "        shots:",
        "          - id: s1",
        "            start_ms: 0",
        "            end_ms: 6000",
        "            visual: Dock at night.",
        "        sound:",
        "          soundscape: water",
        "          music:",
        "            enabled: false",
        ""
      ].join("\n"),
      "utf8"
    );

    const { status, stdout } = await captureCli([
      "lock-block",
      "--config",
      configPath,
      "--subject",
      "cal",
      "--field",
      "manner",
      "--text",
      MANNER_TEXT,
      "--json"
    ]);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      field: string;
      sha256: string;
      subject_id: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.subject_id).toBe("cal");
    expect(payload.field).toBe("manner");
    expect(payload.sha256).toBe(hashLockedText(MANNER_TEXT));

    const written = await readFile(configPath, "utf8");
    // YAML may fold long lines; assert by normalized whitespace and hash.
    expect(written.replace(/\s+/g, " ")).toContain(MANNER_TEXT.replace(/\s+/g, " "));
    expect(written).toContain(payload.sha256);
  });
});
