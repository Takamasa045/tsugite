import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBackendCapabilities } from "../src/backends/capabilities.js";
// @ts-expect-error backend modules are plain ESM without type declarations
import { assertSupportedManifest, canonicalPath, publicMediaUrl, renderIndexHtml } from "../backends/editframe/document.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import { copyPublicMedia, planPublicMedia, uniquePublicName } from "../backends/editframe/media.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import { PINNED_RUNTIME, missingRuntimeMessage, resolveEditframeCli } from "../backends/editframe/runtimePath.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import { assertSupportedProcessPlatform, childEnv, listGroupPids, pidAlive, spawnOwned, spawnOwnedUntil, stopOwned, waitExit, waitForHttp } from "../backends/editframe/processGroup.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import { createAuthoringCopy } from "../backends/editframe/preview.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import { inspectCliArgs } from "../backends/editframe/cli.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import { COMPOSITION_MARKER, createFreshOwnedCompositionDir, ensureOwnedCompositionDir } from "../backends/editframe/ownedDir.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import { writeSafeFile } from "../backends/editframe/confine.mjs";

const temporaryDirectories: string[] = [];
const extraPids: number[] = [];

afterEach(async () => {
  for (const pid of extraPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function descendantPids(rootPid: number): Promise<number[]> {
  const listed = await new Promise<string>((resolveListed) => {
    const child = spawn("ps", ["-ax", "-o", "pid=,ppid="], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", () => resolveListed(Buffer.concat(chunks).toString("utf8")));
    child.on("error", () => resolveListed(""));
  });
  const byParent = new Map<number, number[]>();
  for (const line of listed.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const list = byParent.get(ppid) ?? [];
    list.push(pid);
    byParent.set(ppid, list);
  }
  const found: number[] = [];
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const childPid of byParent.get(current) ?? []) {
      found.push(childPid);
      stack.push(childPid);
    }
  }
  return found;
}

function twoClipManifest(overrides: Record<string, unknown> = {}) {
  return {
    meta: { aspect: "16:9", fps: 30, target_duration_seconds: 2, slug: "editframe-test" },
    clips: [
      {
        id: "clip-a",
        src: "media/clip-a.mp4",
        in: 1,
        out: 2,
        duration: 1,
        fps: 30,
        resolution: { width: 1280, height: 720 },
        audio: true
      },
      {
        id: "clip-b",
        src: "media/clip-b.mp4",
        in: 0.5,
        out: 1.5,
        duration: 1,
        fps: 30,
        resolution: { width: 1280, height: 720 },
        audio: false
      }
    ],
    audio: { bgm: [], narration: [], sfx: [] },
    captions: [
      { id: "c1", text: "クリップA 一秒", start: 0, end: 1 },
      { id: "c2", text: "クリップB 無音映像", start: 1, end: 2 }
    ],
    provenance: [],
    ...overrides
  };
}

describe("editframe capabilities", () => {
  it("declares only the locally proven sequential 16:9 30fps slice", async () => {
    const backend = await loadBackendCapabilities("editframe");
    expect(backend?.name).toBe("editframe");
    expect(backend?.capabilities).toEqual({
      captions: true,
      transitions: false,
      audio_mix: false,
      vertical: false,
      fps: [30],
      presets: []
    });
    expect(backend?.checks.setup).toContainEqual(
      expect.objectContaining({
        type: "command",
        name: "tool:editframe",
        command: ["node", "backends/editframe/cli.mjs", "--version"]
      })
    );
  });
});

describe("editframe document generator", () => {
  it("emits sequential local clips at public/media URLs with timed Japanese ef-text", () => {
    const mediaByClipId = Object.create(null);
    mediaByClipId["clip-a"] = { publicUrl: "/media/clip-0-aaaa.mp4" };
    mediaByClipId["clip-b"] = { publicUrl: "/media/clip-1-bbbb.mp4" };
    const html = renderIndexHtml(twoClipManifest(), { mediaByClipId });
    expect(html).toContain('src="/media/clip-0-aaaa.mp4"');
    expect(html).toContain('src="/media/clip-1-bbbb.mp4"');
    expect(html).not.toContain('src="assets/');
    expect(html).not.toContain("/assets/");
    expect(html).toContain('sourcein="1s"');
    expect(html).toContain('sourceout="2s"');
    expect(html).toContain('sourcein="0.5s"');
    expect(html).toContain('sourceout="1.5s"');
    expect(html).toContain("クリップA 一秒");
    expect(html).toContain("クリップB 無音映像");
    expect(html).toContain("<ef-text");
    expect(html).not.toContain("ef-captions");
    expect(html).not.toContain("workbench");
    expect(html).toContain('mode="sequence"');
    expect(html).toContain('id="clip-0"');
    expect(html).toContain('id="clip-1"');
    expect(html).toContain('class="fill-media"\n          ></ef-video>');
    expect(html).toContain('class="fill-media" mute');
    expect(html).toMatch(
      /<ef-video[\s\S]*id="clip-0"[\s\S]*<\/ef-video>\s*<ef-text class="caps" duration="1s">クリップA 一秒<\/ef-text>/
    );
    expect(html).toContain('duration="1s">クリップA 一秒</ef-text>');
    expect(html).toContain('duration="1s">クリップB 無音映像</ef-text>');
  });

  it("keeps caption local offset and duration instead of snapping to the whole clip", () => {
    const mediaByClipId = Object.create(null);
    mediaByClipId["clip-a"] = { publicUrl: "/media/clip-0-aaaa.mp4" };
    mediaByClipId["clip-b"] = { publicUrl: "/media/clip-1-bbbb.mp4" };
    const html = renderIndexHtml(
      twoClipManifest({
        captions: [
          { id: "mid", text: "途中だけ", start: 0.25, end: 0.75 },
          { id: "span", text: "クリップ跨ぎ", start: 0.5, end: 1.5 }
        ]
      }),
      { mediaByClipId }
    );
    expect(html).toContain('offset="0.25s" duration="0.5s">途中だけ</ef-text>');
    expect(html).toContain('offset="0.5s" duration="0.5s">クリップ跨ぎ</ef-text>');
    expect(html).toMatch(/id="clip-1"[\s\S]*duration="0.5s">クリップ跨ぎ<\/ef-text>/);
    expect(html).not.toContain('duration="1s">途中だけ</ef-text>');
  });

  it("escapes caption text and hostile identifiers", () => {
    const html = renderIndexHtml(
      twoClipManifest({
        captions: [{ id: "x", text: '<script>alert("xss")</script>', start: 0, end: 1 }]
      }),
      {
        mediaByClipId: {
          "clip-a": { publicUrl: "/media/clip-0-aaaa.mp4" },
          "clip-b": { publicUrl: "/media/clip-1-bbbb.mp4" }
        }
      }
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("rejects unsupported fps, vertical, transitions, presets, extra audio, images, motion, and styled captions", () => {
    expect(() => assertSupportedManifest(twoClipManifest({ meta: { aspect: "16:9", fps: 24, target_duration_seconds: 2, slug: "x" } }))).toThrow(
      /fps/
    );
    expect(() => assertSupportedManifest(twoClipManifest({ meta: { aspect: "9:16", fps: 30, target_duration_seconds: 2, slug: "x" } }))).toThrow(
      /16:9/
    );
    expect(() => assertSupportedManifest(twoClipManifest({ transitions: [{ type: "fade" }] }))).toThrow(/transition/);
    expect(() => assertSupportedManifest(twoClipManifest({ presentation: { preset: "orbital-showreel-16x9" } }))).toThrow(
      /preset/
    );
    expect(() =>
      assertSupportedManifest(twoClipManifest({ audio: { bgm: [{ src: "media/bgm.mp3" }], narration: [], sfx: [] } }))
    ).toThrow(/audio/);
    expect(() => assertSupportedManifest(twoClipManifest({ images: [{ id: "i", src: "media/x.png" }] }))).toThrow(/image/);
    expect(() =>
      assertSupportedManifest(
        twoClipManifest({
          clips: [
            {
              id: "clip-a",
              src: "media/clip-a.mp4",
              in: 0,
              out: 1,
              duration: 1,
              fps: 30,
              resolution: { width: 1280, height: 720 },
              audio: false,
              motion: { kind: "pan" }
            }
          ]
        })
      )
    ).toThrow(/motion/);
    expect(() =>
      assertSupportedManifest(twoClipManifest({ captions: [{ id: "c", text: "x", start: 0, end: 1, visual: { headline: "no" } }] }))
    ).toThrow(/visual/);
    expect(() =>
      assertSupportedManifest(twoClipManifest({ captions: [{ id: "c", text: "x", start: 0, end: 1, pose: "open" }] }))
    ).toThrow(/pose/);
    expect(() =>
      assertSupportedManifest(twoClipManifest({ captions: [{ id: "c", text: "x", start: 0, end: 1, emphasis: ["x"] }] }))
    ).toThrow(/emphasis/);
    expect(() =>
      assertSupportedManifest(
        twoClipManifest({
          clips: [
            {
              id: "dup",
              src: "media/clip-a.mp4",
              in: 0,
              out: 1,
              duration: 1,
              fps: 30,
              resolution: { width: 1280, height: 720 },
              audio: false
            },
            {
              id: "dup",
              src: "media/clip-b.mp4",
              in: 0,
              out: 1,
              duration: 1,
              fps: 30,
              resolution: { width: 1280, height: 720 },
              audio: false
            }
          ]
        })
      )
    ).toThrow(/duplicate clip id/);
  });

  it("uses the public media URL helper", () => {
    expect(publicMediaUrl("clip-0-abcd.mp4")).toBe("/media/clip-0-abcd.mp4");
  });

  it("canonicalizes macOS tmpdir for Vite fs.allow", () => {
    const temp = tmpdir();
    const canonical = canonicalPath(temp);
    expect(canonical).toBe(realpathSync(temp));
  });
});

describe("editframe public media copies", () => {
  it("copies run-local clips into unique public/media names", async () => {
    const runDir = await tempDir("tsugite-editframe-media-");
    await mkdir(join(runDir, "media"), { recursive: true });
    await writeFile(join(runDir, "media", "clip-a.mp4"), "clip-a-bytes");
    await writeFile(join(runDir, "media", "clip-b.mp4"), "clip-b-bytes");
    const compositionDir = join(runDir, "editframe-composition");
    const plan = await planPublicMedia(twoClipManifest(), runDir);
    expect(plan[0].publicUrl).toBe(`/media/${uniquePublicName(0, "clip-a", "media/clip-a.mp4")}`);
    expect(plan[1].publicUrl).not.toBe(plan[0].publicUrl);
    await copyPublicMedia(plan, compositionDir);
    expect(await readFile(join(compositionDir, "public", "media", plan[0].publicName), "utf8")).toBe("clip-a-bytes");
    expect(await readFile(join(compositionDir, "public", "media", plan[1].publicName), "utf8")).toBe("clip-b-bytes");
  });

  it("keeps Japanese, duplicate basename, and hostile IDs on unique filenames", async () => {
    const runDir = await tempDir("tsugite-editframe-names-");
    await mkdir(join(runDir, "media"), { recursive: true });
    await writeFile(join(runDir, "media", "same.mp4"), "one");
    await writeFile(join(runDir, "media", "other.mp4"), "two");
    const manifest = twoClipManifest({
      clips: [
        { id: "日本語", src: "media/same.mp4", in: 0, out: 1, duration: 1, fps: 30, resolution: { width: 1280, height: 720 }, audio: false },
        { id: "__proto__", src: "media/same.mp4", in: 0, out: 1, duration: 1, fps: 30, resolution: { width: 1280, height: 720 }, audio: false },
        { id: "constructor", src: "media/other.mp4", in: 0, out: 1, duration: 1, fps: 30, resolution: { width: 1280, height: 720 }, audio: false }
      ]
    });
    const plan = await planPublicMedia(manifest, runDir);
    const names = plan.map((item: { publicName: string }) => item.publicName);
    expect(new Set(names).size).toBe(3);
    const compositionDir = join(runDir, "editframe-composition");
    await copyPublicMedia(plan, compositionDir);
    expect(await readFile(join(compositionDir, "public", "media", plan[0].publicName), "utf8")).toBe("one");
    expect(await readFile(join(compositionDir, "public", "media", plan[2].publicName), "utf8")).toBe("two");
  });

  it("rejects a destination media symlink before writing outside", async () => {
    const runDir = await tempDir("tsugite-editframe-destlink-");
    const outside = await tempDir("tsugite-editframe-dest-outside-");
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "untouched");
    await mkdir(join(runDir, "media"), { recursive: true });
    await writeFile(join(runDir, "media", "clip-a.mp4"), "clip-a-bytes");
    await writeFile(join(runDir, "media", "clip-b.mp4"), "clip-b-bytes");
    const compositionDir = join(runDir, "editframe-composition");
    await mkdir(join(compositionDir, "public"), { recursive: true });
    await symlink(outside, join(compositionDir, "public", "media"));
    const plan = await planPublicMedia(twoClipManifest(), runDir);
    await expect(copyPublicMedia(plan, compositionDir)).rejects.toThrow(/symlink/);
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
  });
});

describe("editframe render runner", () => {
  it("rejects backend payload paths outside the run directory contract", () => {
    const result = spawnSync(process.execPath, [resolve("backends/editframe/render.mjs")], {
      cwd: process.cwd(),
      input: JSON.stringify({
        runDir: resolve("."),
        manifestPath: resolve("backends/editframe/render.mjs"),
        outputPath: resolve("final.mp4"),
        reportPath: resolve("render-report.json")
      }),
      encoding: "utf8"
    });
    expect(result.status).toBe(40);
    expect(result.stderr).toContain("manifestPath must equal");
  });

  it("returns a structured missing-runtime result without invoking npx or unscoped editframe", async () => {
    const runDir = await tempDir("tsugite-editframe-missing-");
    const manifestPath = join(runDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(twoClipManifest()));
    await mkdir(join(runDir, "media"), { recursive: true });
    await writeFile(join(runDir, "media", "clip-a.mp4"), "a");
    await writeFile(join(runDir, "media", "clip-b.mp4"), "b");
    const result = spawnSync(process.execPath, [resolve("backends/editframe/render.mjs")], {
      cwd: process.cwd(),
      input: JSON.stringify({
        runDir,
        manifestPath,
        outputPath: join(runDir, "final.mp4"),
        reportPath: join(runDir, "render-report.json")
      }),
      encoding: "utf8",
      env: { ...process.env, TSUGITE_EDITFRAME_RUNTIME: join(runDir, "missing-runtime") }
    });
    expect(result.status).toBe(30);
    const stdout = JSON.parse(result.stdout);
    expect(stdout.ok).toBe(false);
    expect(stdout.code).toBe("editframe.dependency_missing");
    expect(JSON.stringify(stdout)).not.toMatch(/npx/);
    expect(result.stderr + result.stdout).not.toContain("npx");
  });

  it("rejects external media before starting Vite or the CLI", async () => {
    const runDir = await tempDir("tsugite-editframe-external-");
    const manifestPath = join(runDir, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify(
        twoClipManifest({
          clips: [
            {
              id: "clip-a",
              src: "https://example.invalid/video.mp4",
              in: 0,
              out: 1,
              duration: 1,
              fps: 30,
              resolution: { width: 1280, height: 720 },
              audio: false
            }
          ]
        })
      )
    );
    const result = spawnSync(process.execPath, [resolve("backends/editframe/render.mjs")], {
      cwd: process.cwd(),
      input: JSON.stringify({
        runDir,
        manifestPath,
        outputPath: join(runDir, "final.mp4"),
        reportPath: join(runDir, "render-report.json")
      }),
      encoding: "utf8"
    });
    expect(result.status).toBe(10);
    expect(result.stderr).toMatch(/local asset path|must stay inside runDir/);
  });

  it("rejects symlink media that escapes runDir and leaves the outside sentinel unchanged", async () => {
    const runDir = await tempDir("tsugite-editframe-symlink-");
    const outside = await tempDir("tsugite-editframe-outside-");
    await writeFile(join(outside, "escaped.mp4"), "secret");
    await mkdir(join(runDir, "media"), { recursive: true });
    await symlink(join(outside, "escaped.mp4"), join(runDir, "media", "clip-a.mp4"));
    await writeFile(join(runDir, "media", "clip-b.mp4"), "b");
    const manifestPath = join(runDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(twoClipManifest()));
    const result = spawnSync(process.execPath, [resolve("backends/editframe/render.mjs")], {
      cwd: process.cwd(),
      input: JSON.stringify({
        runDir,
        manifestPath,
        outputPath: join(runDir, "final.mp4"),
        reportPath: join(runDir, "render-report.json")
      }),
      encoding: "utf8"
    });
    expect(result.status).toBe(10);
    expect(result.stderr).toMatch(/symlink|stay inside runDir/);
    expect(await readFile(join(outside, "escaped.mp4"), "utf8")).toBe("secret");
  });
});

describe("editframe owned composition dir", () => {
  it("creates a missing composition directory on first use", async () => {
    const runDir = await tempDir("tsugite-editframe-owned-missing-");
    const compositionDir = join(runDir, "editframe-composition");
    await ensureOwnedCompositionDir(compositionDir, runDir);
    expect(await readFile(join(compositionDir, COMPOSITION_MARKER), "utf8")).toContain("editframe");
  });

  it("refuses an unowned preexisting composition directory", async () => {
    const runDir = await tempDir("tsugite-editframe-owned-refuse-");
    const compositionDir = join(runDir, "editframe-composition");
    await mkdir(compositionDir);
    await writeFile(join(compositionDir, "user.txt"), "keep");
    await expect(ensureOwnedCompositionDir(compositionDir, runDir)).rejects.toThrow(/unowned/);
    expect(await readFile(join(compositionDir, "user.txt"), "utf8")).toBe("keep");
  });

  it("copies media twice into fresh owned dirs and leaves an outside sentinel unchanged", async () => {
    const runDir = await tempDir("tsugite-editframe-twice-");
    const outside = await tempDir("tsugite-editframe-twice-out-");
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "untouched");
    await mkdir(join(runDir, "media"), { recursive: true });
    await writeFile(join(runDir, "media", "clip-a.mp4"), "clip-a-bytes");
    await writeFile(join(runDir, "media", "clip-b.mp4"), "clip-b-bytes");
    const plan = await planPublicMedia(twoClipManifest(), runDir);
    const first = await createFreshOwnedCompositionDir(runDir);
    await copyPublicMedia(plan, first);
    const second = await createFreshOwnedCompositionDir(runDir);
    await copyPublicMedia(plan, second);
    expect(second).not.toBe(first);
    expect(await readFile(join(first, "public", "media", plan[0].publicName), "utf8")).toBe("clip-a-bytes");
    expect(await readFile(join(second, "public", "media", plan[1].publicName), "utf8")).toBe("clip-b-bytes");
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
  });

  it("refuses a generated destination symlink and leaves the sentinel unchanged", async () => {
    const runDir = await tempDir("tsugite-editframe-genlink-");
    const outside = await tempDir("tsugite-editframe-genlink-out-");
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "untouched");
    const compositionDir = await createFreshOwnedCompositionDir(runDir);
    await symlink(sentinel, join(compositionDir, "index.html"));
    await expect(writeSafeFile(join(compositionDir, "index.html"), "hacked", compositionDir)).rejects.toThrow(/symlink/);
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
  });
});

describe("editframe CLI wrapper", () => {
  it("rejects unknown commands even when --help is present and rejects non-loopback --url", () => {
    expect(inspectCliArgs(["cloud-render", "--help"]).ok).toBe(false);
    expect(inspectCliArgs(["webhook"]).ok).toBe(false);
    expect(inspectCliArgs(["render", "--url", "https://example.invalid/x"]).ok).toBe(false);
    expect(inspectCliArgs(["render", "--url", "http://127.0.0.1:4174/index.html"]).ok).toBe(true);
    expect(inspectCliArgs(["render", "--url", "http://127.0.0.1:4174/index.html", "--help"]).ok).toBe(true);
  });

  it("rejects equals-form and duplicate --url flags, including a later non-loopback value", () => {
    expect(inspectCliArgs(["render", "--url=https://example.com"]).ok).toBe(false);
    expect(inspectCliArgs(["render", "--url=http://127.0.0.1:4174/index.html"]).ok).toBe(true);
    expect(inspectCliArgs(["render", "--url=http://localhost:4174/index.html"]).ok).toBe(true);
    expect(
      inspectCliArgs(["render", "--url", "http://127.0.0.1:4174/index.html", "--url", "https://example.com"]).ok
    ).toBe(false);
    expect(
      inspectCliArgs(["render", "--url", "http://127.0.0.1:4174/index.html", "--url=https://example.com"]).ok
    ).toBe(false);
    expect(
      inspectCliArgs(["render", "--url", "http://127.0.0.1:1/", "--url", "http://127.0.0.1:2/"]).reason
    ).toMatch(/must not be repeated/);
  });

  it("refuses cloud subcommands and does not auto-install", () => {
    const result = spawnSync(process.execPath, [resolve("backends/editframe/cli.mjs"), "cloud-render"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not allowed|unsupported/i);
    expect(result.stderr).not.toContain("npx");
  });

  it("prints an actionable missing-runtime error", () => {
    const result = spawnSync(process.execPath, [resolve("backends/editframe/cli.mjs"), "--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TSUGITE_EDITFRAME_RUNTIME: join(tmpdir(), "no-such-editframe-runtime") }
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm run editframe:install");
    expect(missingRuntimeMessage()).toContain("npm run editframe:install");
  });
});

describe.skipIf(process.platform !== "darwin")("editframe process ownership (macOS)", () => {
  it("stops owned descendants and leaves an unrelated sentinel alive", async () => {
    const handle = spawnOwned(
      [
        process.execPath,
        "-e",
        "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(child.pid)); setInterval(()=>{},1000);"
      ],
      { cwd: process.cwd(), env: childEnv() }
    );
    expect(handle.pid).toBeGreaterThan(0);
    const descendantPid = await new Promise<number>((resolvePid, reject) => {
      const timer = setTimeout(() => reject(new Error("did not receive descendant pid")), 2000);
      handle.child.stdout?.once("data", (chunk: Buffer) => {
        clearTimeout(timer);
        resolvePid(Number(String(chunk)));
      });
    });
    const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    extraPids.push(sentinel.pid!);
    await stopOwned(handle);
    expect(pidAlive(handle.pid)).toBe(false);
    expect(pidAlive(descendantPid)).toBe(false);
    expect(pidAlive(sentinel.pid!)).toBe(true);
  });

  it("rejects waitExit on timeout even when the child exits 0 from SIGTERM", async () => {
    const handle = spawnOwned(
      [process.execPath, "-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);"],
      { cwd: process.cwd(), env: childEnv() }
    );
    extraPids.push(handle.pid);
    await expect(waitExit(handle, 200)).rejects.toThrow(/timed out/);
    expect(pidAlive(handle.pid)).toBe(false);
  });

  it("aborts spawnOwnedUntil before ready and owned pids disappear", async () => {
    const ac = new AbortController();
    let handle: { pid: number } | undefined;
    const pending = spawnOwnedUntil(
      [process.execPath, "-e", "setInterval(()=>{},1000);"],
      { cwd: process.cwd(), env: childEnv(), signal: ac.signal },
      async (owned) => {
        handle = owned;
        await new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("ready timed out")), 8000);
          ac.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true }
          );
        });
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    ac.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(handle?.pid).toBeGreaterThan(0);
    expect(pidAlive(handle!.pid)).toBe(false);
  });
});

describe("editframe process helpers", () => {
  it("rejects owned-process APIs unless the host is macOS", async () => {
    if (process.platform === "darwin") {
      expect(() => assertSupportedProcessPlatform()).not.toThrow();
      return;
    }
    expect(() => assertSupportedProcessPlatform()).toThrow(/macOS only/);
    expect(() =>
      spawnOwned([process.execPath, "-e", "process.exit(0)"], { cwd: process.cwd(), env: childEnv() })
    ).toThrow(/macOS only/);
    await expect(listGroupPids(1)).rejects.toThrow(/macOS only/);
  });

  it("does not treat HTTP 404 as ready", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
    });
    await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await expect(waitForHttp(`http://127.0.0.1:${port}/missing`, { timeoutMs: 400, expectedText: "ef-timegroup" })).rejects.toThrow(
      /did not become ready/
    );
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("does not forward Editframe cloud env into children", () => {
    const env = childEnv({
      PATH: process.env.PATH,
      EF_TOKEN: "secret",
      EF_HOST: "https://editframe.com",
      EF_RENDER_HOST: "https://editframe.com"
    });
    expect(env.EF_NO_TELEMETRY).toBe("1");
    expect(env.EF_TOKEN).toBeUndefined();
    expect(env.EF_HOST).toBeUndefined();
    expect(env.EF_RENDER_HOST).toBeUndefined();
  });
});

describe("editframe preview authoring copy", () => {
  it("copies composition into an authoring directory and does not rewrite the source", async () => {
    const source = await tempDir("tsugite-editframe-preview-src-");
    await writeFile(join(source, "index.html"), "<html>source</html>");
    const dest = join(dirname(source), `${source.split("/").pop()}-authoring`);
    temporaryDirectories.push(dest);
    const copy = await createAuthoringCopy(source, dest);
    expect(copy).toBe(dest);
    expect(await readFile(join(dest, "index.html"), "utf8")).toBe("<html>source</html>");
    expect(await readFile(join(source, "index.html"), "utf8")).toBe("<html>source</html>");
    await writeFile(join(dest, "index.html"), "<html>edited</html>");
    expect(await readFile(join(source, "index.html"), "utf8")).toBe("<html>source</html>");
  });

  it("rejects a preexisting destination, nested destination, and source symlink", async () => {
    const source = await tempDir("tsugite-editframe-preview-bad-");
    await writeFile(join(source, "index.html"), "<html>source</html>");
    const nested = join(source, "inside");
    await expect(createAuthoringCopy(source, nested)).rejects.toThrow(/inside the source/);
    const dest = join(dirname(source), `${source.split("/").pop()}-authoring`);
    temporaryDirectories.push(dest);
    await mkdir(dest);
    await expect(createAuthoringCopy(source, dest)).rejects.toThrow(/already exists/);
    const linked = await tempDir("tsugite-editframe-preview-link-");
    await symlink(join(source, "index.html"), join(linked, "index.html"));
    const linkedDest = join(dirname(linked), `${linked.split("/").pop()}-authoring`);
    temporaryDirectories.push(linkedDest);
    await expect(createAuthoringCopy(linked, linkedDest)).rejects.toThrow(/symlink/);
  });

  it.skipIf(process.env.TSUGITE_EDITFRAME_REAL !== "1" || process.platform !== "darwin")(
    "stops owned processes when the preview wrapper receives SIGTERM during startup",
    async () => {
    const runtime = resolveEditframeCli();
    if (!runtime.ok) return;
    const source = await tempDir("tsugite-editframe-preview-sig-");
    await writeFile(join(source, "index.html"), "<!DOCTYPE html><html><body><ef-timegroup id=\"root\"></ef-timegroup></body></html>");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "src", "index.js"), "import \"@editframe/elements\";\n");
    await writeFile(join(source, "src", "styles.css"), "body { background: #111; }\n");
    const dest = join(dirname(source), `${basename(source)}-authoring`);
    temporaryDirectories.push(dest);
    const child = spawn(process.execPath, [resolve("backends/editframe/preview.mjs"), source], {
      cwd: process.cwd(),
      env: childEnv(),
      detached: true,
      stdio: "ignore"
    });
    extraPids.push(child.pid!);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const descendants = await descendantPids(child.pid!);
    const groups = new Set<number>([child.pid!, ...descendants]);
    for (const pid of descendants) {
      for (const grouped of await listGroupPids(pid)) groups.add(grouped);
    }
    process.kill(child.pid!, "SIGTERM");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("preview wrapper did not exit after SIGTERM")), 8000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    expect(pidAlive(child.pid!)).toBe(false);
    for (const pid of groups) {
      expect(pidAlive(pid)).toBe(false);
    }
  }
  );
});

describe("editframe runtime resolver", () => {
  it("rejects a mismatched runtime override instead of treating it as pinned", async () => {
    const fake = await tempDir("tsugite-editframe-fake-runtime-");
    for (const name of ["cli", "elements", "vite-plugin"]) {
      const dir = join(fake, "node_modules", "@editframe", name, "dist");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "index.js"), "export {}\n");
      await writeFile(join(fake, "node_modules", "@editframe", name, "package.json"), JSON.stringify({ name: `@editframe/${name}`, version: "0.0.1" }));
    }
    await writeFile(join(fake, "node_modules", "@editframe", "elements", "dist", "style.css"), "/* css */");
    const viteDir = join(fake, "node_modules", "vite", "bin");
    await mkdir(viteDir, { recursive: true });
    await writeFile(join(viteDir, "vite.js"), "export {}\n");
    await mkdir(join(fake, "node_modules", "vite", "dist", "node"), { recursive: true });
    await writeFile(join(fake, "node_modules", "vite", "dist", "node", "index.js"), "export {}\n");
    await writeFile(join(fake, "node_modules", "vite", "package.json"), JSON.stringify({ name: "vite", version: "8.0.0" }));
    const previous = process.env.TSUGITE_EDITFRAME_RUNTIME;
    process.env.TSUGITE_EDITFRAME_RUNTIME = fake;
    try {
      const resolved = resolveEditframeCli();
      expect(resolved.ok).toBe(false);
      expect(resolved.message).toMatch(/do not match the pin/);
    } finally {
      if (previous === undefined) delete process.env.TSUGITE_EDITFRAME_RUNTIME;
      else process.env.TSUGITE_EDITFRAME_RUNTIME = previous;
    }
  });

  it("points at the pinned runtime CLI entry when present", () => {
    const resolved = resolveEditframeCli();
    if (resolved.ok) {
      expect(resolved.cliPath).toContain("backends/editframe/runtime/node_modules/@editframe/cli");
      expect(resolved.versions).toEqual(PINNED_RUNTIME);
    } else {
      expect(resolved.message).toContain("npm run editframe:install");
    }
  });
});
