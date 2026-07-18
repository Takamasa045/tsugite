import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const adapterRoot = resolve("adapters/hyperframes-media");

describe("HyperFrames media-use audio adapter", () => {
  it("probes the installed media-use skill without generating media", async () => {
    const skillDir = await createFakeMediaUseSkill();
    const result = spawnSync(process.execPath, [join(adapterRoot, "check.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, TSUGITE_HYPERFRAMES_MEDIA_SKILL_DIR: skillDir },
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("media-use ready");
  });

  it("uses only HyperFrames BGM/SFX, waits for output, and never forwards ElevenLabs", async () => {
    const skillDir = await createFakeMediaUseSkill();
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-hyperframes-media-run-"));
    const result = spawnSync(process.execPath, [join(adapterRoot, "generate.mjs")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ELEVENLABS_API_KEY: "must-not-be-forwarded",
        TSUGITE_HYPERFRAMES_MEDIA_SKILL_DIR: skillDir
      },
      input: `${JSON.stringify({
        run_id: "hyperframes-audio",
        run_dir: runDir,
        target_duration_seconds: 6,
        request: {
          bgm: {
            id: "main-bgm",
            mode: "generate",
            prompt: "warm cinematic underscore",
            start: 0,
            end: 6,
            volume: 0.2
          },
          sfx: [
            {
              id: "opening-whoosh",
              prompt: "whoosh",
              start: 0.25,
              volume: 0.35
            }
          ],
          params: { bgm_timeout_ms: 1000 }
        }
      })}\n`,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      credits: 0,
      bgm: {
        id: "main-bgm",
        start: 0,
        end: 6,
        volume: 0.2
      },
      sfx: [
        {
          id: "opening-whoosh",
          start: 0.25,
          volume: 0.35
        }
      ],
      metadata: {
        provider: "musicgen",
        elevenlabs_used: false,
        fallback_used: false
      }
    });
    expect(await realpath(output.bgm.src)).toBe(await realpath(join(runDir, "assets", "bgm", "track.wav")));
    expect(await realpath(output.sfx[0].src)).toBe(await realpath(join(runDir, "assets", "sfx", "whoosh.wav")));
    expect(JSON.parse(await readFile(join(runDir, ".hyperframes-media", "engine-observation.json"), "utf8"))).toEqual({
      only: "bgm,sfx",
      elevenlabs_visible: false,
      target_duration_seconds: 6
    });
  });

  it("fails closed when a requested SFX cannot be resolved", async () => {
    const skillDir = await createFakeMediaUseSkill({ omitSfx: true });
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-hyperframes-media-missing-sfx-"));
    const result = spawnSync(process.execPath, [join(adapterRoot, "generate.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, TSUGITE_HYPERFRAMES_MEDIA_SKILL_DIR: skillDir },
      input: `${JSON.stringify({
        run_id: "missing-sfx",
        run_dir: runDir,
        target_duration_seconds: 2,
        request: {
          sfx: [{ id: "missing", prompt: "missing sound", start: 0 }],
          params: {}
        }
      })}\n`,
      encoding: "utf8"
    });

    expect(result.status).toBe(20);
    expect(result.stderr).toContain("requested SFX was not resolved");
    expect(result.stderr).not.toContain("ELEVENLABS_API_KEY");
  });

  it("rejects unsafe track ids before invoking media-use", async () => {
    const skillDir = await createFakeMediaUseSkill();
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-hyperframes-media-unsafe-id-"));
    const result = spawnSync(process.execPath, [join(adapterRoot, "generate.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, TSUGITE_HYPERFRAMES_MEDIA_SKILL_DIR: skillDir },
      input: `${JSON.stringify({
        run_id: "unsafe-id",
        run_dir: runDir,
        target_duration_seconds: 2,
        request: {
          sfx: [{ id: "../escape", prompt: "unsafe", start: 0 }],
          params: {}
        }
      })}\n`,
      encoding: "utf8"
    });

    expect(result.status).toBe(40);
    expect(result.stderr).toContain("must be a safe id");
    await expect(readFile(join(runDir, ".hyperframes-media", "engine-observation.json"), "utf8")).rejects.toThrow();
  });
});

async function createFakeMediaUseSkill(options: { omitSfx?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-media-use-skill-"));
  const scripts = join(root, "audio", "scripts");
  await mkdir(scripts, { recursive: true });
  await writeFile(join(root, "SKILL.md"), "---\nname: media-use\n---\n");
  await writeFile(
    join(scripts, "audio.mjs"),
    fakeAudioEngine(options.omitSfx ?? false)
  );
  await writeFile(
    join(scripts, "wait-bgm.mjs"),
    "process.exit(0);\n"
  );
  return root;
}

function fakeAudioEngine(omitSfx: boolean): string {
  return `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf("--" + name) + 1];
const request = JSON.parse(readFileSync(flag("request"), "utf8"));
const previous = JSON.parse(readFileSync(flag("out"), "utf8"));
const runDir = flag("hyperframes");
mkdirSync(join(runDir, "assets", "bgm"), { recursive: true });
mkdirSync(join(runDir, "assets", "sfx"), { recursive: true });
writeFileSync(join(runDir, "assets", "bgm", "track.wav"), Buffer.alloc(64));
writeFileSync(join(runDir, "assets", "sfx", "whoosh.wav"), Buffer.alloc(64));
mkdirSync(join(runDir, ".hyperframes-media"), { recursive: true });
writeFileSync(join(runDir, ".hyperframes-media", "engine-observation.json"), JSON.stringify({
  only: flag("only"),
  elevenlabs_visible: Boolean(process.env.ELEVENLABS_API_KEY),
  target_duration_seconds: previous.voices[0].duration_s
}));
writeFileSync(flag("out"), JSON.stringify({
  ...previous,
  bgm: request.bgm ? { path: "assets/bgm/track.wav", volume: 0.9, duration_s: previous.voices[0].duration_s } : null,
  bgm_pending: false,
  bgm_provider: "musicgen",
  bgm_mode: "detached-seed-loop",
  sfx: ${omitSfx ? "[]" : "request.lines.map((line) => ({ id: line.id, name: line.sfx[0], file: \"assets/sfx/whoosh.wav\", offset_s: 0, duration_s: 0.5, volume: 0.35 }))"}
}));
`;
}
