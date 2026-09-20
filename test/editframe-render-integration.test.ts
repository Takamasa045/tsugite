import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error backend modules are plain ESM without type declarations
import { createAuthoringCopy, startPreviewServer } from "../backends/editframe/preview.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import { childEnv, listGroupPids, pidAlive, stopOwned } from "../backends/editframe/processGroup.mjs";
// @ts-expect-error backend modules are plain ESM without type declarations
import { resolveEditframeCli } from "../backends/editframe/runtimePath.mjs";

const runtime = resolveEditframeCli();
const runReal =
  process.env.TSUGITE_EDITFRAME_REAL === "1" && process.platform === "darwin" && runtime.ok === true;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function ffmpegMake(args: string[]) {
  return spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" });
}

function meanVolume(stderr: string): number {
  return Number(/mean_volume:\s+([-0-9.]+)/.exec(stderr)?.[1]);
}

async function captureStage(
  page: {
    evaluate: (fn: (time: number) => Promise<unknown>, time: number) => Promise<unknown>;
    locator: (selector: string) => { first: () => { screenshot: (opts: { path: string }) => Promise<unknown> } };
    screenshot: (opts: { path: string }) => Promise<unknown>;
  },
  time: number,
  shotPath: string
) {
  const info = (await page.evaluate(async (t: number) => {
    await Promise.all(["ef-timegroup", "ef-video", "ef-text"].map((name) => customElements.whenDefined(name)));
    const root = document.querySelector("ef-timegroup#root") as {
      seekForRender: (time: number, options?: { strictVideoPaint?: boolean }) => Promise<void>;
      currentTime: number;
      duration: number;
      contentReadyState: string;
    } | null;
    if (!root) throw new Error("missing ef-timegroup#root");
    await root.seekForRender(t, { strictVideoPaint: true });
    const visible = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        text: (el.textContent ?? "").trim(),
        display: s.display,
        color: s.color,
        fontSize: s.fontSize,
        bounds: { x: r.x, y: r.y, w: r.width, h: r.height }
      };
    };
    const videos = [...document.querySelectorAll("ef-video")].map((el) => visible(el));
    const captions = [...document.querySelectorAll("ef-text")].map((el) => visible(el));
    return {
      currentTime: root.currentTime,
      duration: root.duration,
      contentReadyState: root.contentReadyState,
      defined: {
        timegroup: Boolean(customElements.get("ef-timegroup")),
        video: Boolean(customElements.get("ef-video")),
        text: Boolean(customElements.get("ef-text"))
      },
      root: visible(root),
      videos,
      captions
    };
  }, time)) as {
    currentTime: number;
    duration: number;
    contentReadyState: string;
    defined: { timegroup: boolean; video: boolean; text: boolean };
    root: { bounds: { w: number; h: number } };
    videos: Array<{ bounds: { w: number; h: number } } | null>;
    captions: Array<{ text: string; bounds: { w: number; h: number; y: number }; color: string; fontSize: string } | null>;
  };
  try {
    await page.locator("ef-timegroup#root").first().screenshot({ path: shotPath });
  } catch {
    await page.screenshot({ path: shotPath });
  }
  return info;
}

describe.skipIf(!runReal)("editframe real local render", () => {
  it(
    "renders two local clips with Japanese timed captions and embedded then silent audio",
    async () => {
      const runDir = await mkdtemp(join(tmpdir(), "tsugite-editframe-real-"));
      temporaryDirectories.push(runDir);
      await mkdir(join(runDir, "media"), { recursive: true });
      const clipA = join(runDir, "media", "clip-a.mp4");
      const clipB = join(runDir, "media", "clip-b.mp4");
      const makeA = ffmpegMake([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=30:duration=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=3",
        "-shortest",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        clipA
      ]);
      const makeB = ffmpegMake([
        "-f",
        "lavfi",
        "-i",
        "smptebars=size=1280x720:rate=30:duration=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=48000:duration=2",
        "-shortest",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        clipB
      ]);
      expect(makeA.status, makeA.stderr).toBe(0);
      expect(makeB.status, makeB.stderr).toBe(0);
      const hasAudio = spawnSync(
        "ffprobe",
        ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", clipB],
        { encoding: "utf8" }
      );
      expect(hasAudio.stdout).toContain("audio");
      const manifest = {
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 2, slug: "editframe-real" },
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
        provenance: []
      };
      const manifestPath = join(runDir, "manifest.json");
      const outputPath = join(runDir, "final.mp4");
      const reportPath = join(runDir, "render-report.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const originalA = await readFile(clipA);
      const payload = JSON.stringify({ runDir, manifestPath, outputPath, reportPath });
      const first = spawnSync(process.execPath, [resolve("backends/editframe/render.mjs")], {
        cwd: process.cwd(),
        input: payload,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 10
      });
      expect(first.status, first.stderr).toBe(0);
      const firstReport = JSON.parse(await readFile(reportPath, "utf8"));
      const firstComposition = firstReport.composition_dir as string;
      expect(firstComposition).toContain("editframe-renders");
      const generatedHtml = await readFile(join(firstComposition, "index.html"), "utf8");
      expect(generatedHtml).toMatch(/src="\/media\/clip-0-[a-f0-9]{16}\.mp4"/);
      expect(generatedHtml).toMatch(
        /<ef-video[\s\S]*id="clip-0"[\s\S]*<\/ef-video>\s*<ef-text class="caps" duration="1s">クリップA 一秒<\/ef-text>/
      );
      expect(generatedHtml).not.toContain('src="assets/');

      const second = spawnSync(process.execPath, [resolve("backends/editframe/render.mjs")], {
        cwd: process.cwd(),
        input: payload,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 10
      });
      expect(second.status, second.stderr).toBe(0);
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      expect(report.composition_dir).not.toBe(firstComposition);
      expect(report.composition_dir).toContain("editframe-renders");
      const composition = report.composition_dir as string;

      const probe = spawnSync(
        "ffprobe",
        ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", outputPath],
        { encoding: "utf8" }
      );
      expect(probe.status).toBe(0);
      const probed = JSON.parse(probe.stdout);
      const video = probed.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
      const audio = probed.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
      expect(report.backend).toBe("editframe");
      expect(report.duration_seconds).toBeCloseTo(Number(probed.format.duration), 2);
      expect(report.width).toBe(Number(video.width));
      expect(report.height).toBe(Number(video.height));
      expect(audio).toBeTruthy();
      expect(Buffer.compare(originalA, await readFile(clipA))).toBe(0);

      const evidenceDir = resolve("dist/verification/editframe-support/implementation");
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(evidenceDir, "final.mp4"), await readFile(outputPath));
      await writeFile(join(evidenceDir, "render-report.json"), `${JSON.stringify(report, null, 2)}\n`);
      spawnSync("ffmpeg", [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        "0.3",
        "-i",
        outputPath,
        "-frames:v",
        "1",
        "-update",
        "1",
        join(evidenceDir, "frame-300ms.png")
      ]);
      spawnSync("ffmpeg", [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        "1.3",
        "-i",
        outputPath,
        "-frames:v",
        "1",
        "-update",
        "1",
        join(evidenceDir, "frame-1300ms.png")
      ]);
      const loud = spawnSync(
        "ffmpeg",
        ["-hide_banner", "-ss", "0.1", "-t", "0.7", "-i", outputPath, "-af", "volumedetect", "-f", "null", "-"],
        { encoding: "utf8" }
      );
      const quiet = spawnSync(
        "ffmpeg",
        ["-hide_banner", "-ss", "1.2", "-t", "0.6", "-i", outputPath, "-af", "volumedetect", "-f", "null", "-"],
        { encoding: "utf8" }
      );
      await writeFile(join(evidenceDir, "volumedetect-first.txt"), loud.stderr);
      await writeFile(join(evidenceDir, "volumedetect-second.txt"), quiet.stderr);
      const firstMean = meanVolume(loud.stderr);
      const secondMean = meanVolume(quiet.stderr);
      expect(firstMean).toBeGreaterThan(-40);
      expect(secondMean).toBeLessThan(-50);

      const originalHtml = await readFile(join(composition, "index.html"));
      const originalHash = createHash("sha256").update(originalHtml).digest("hex");
      const authoring = join(runDir, "authoring-copy");
      await createAuthoringCopy(composition, authoring);
      await writeFile(
        join(authoring, "index.html"),
        (await readFile(join(authoring, "index.html"), "utf8")).replace("クリップA 一秒", "コピー編集の字幕")
      );
      const preview = await startPreviewServer(authoring);
      const pageerrors: string[] = [];
      const requestfailed: Array<{ url: string; failure?: string }> = [];
      const consoleLines: Array<{ type: string; text: string }> = [];
      try {
        const pageRes = await fetch(preview.url);
        const body = await pageRes.text();
        expect(body).toContain("コピー編集の字幕");
        expect(body).not.toContain("クリップA 一秒");
        expect(createHash("sha256").update(await readFile(join(composition, "index.html"))).digest("hex")).toBe(
          originalHash
        );
        const playwright = await import(pathToFileURL(join(runtime.root, "node_modules", "playwright", "index.mjs")).href);
        const browser = await playwright.chromium.launch({ channel: "chrome", headless: true });
        const browserPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        browserPage.on("pageerror", (error: Error) => pageerrors.push(String(error.stack ?? error)));
        browserPage.on("requestfailed", (req: { url: () => string; failure: () => { errorText?: string } | null }) => {
          requestfailed.push({ url: req.url(), failure: req.failure()?.errorText });
        });
        browserPage.on("console", (msg: { type: () => string; text: () => string }) => {
          consoleLines.push({ type: msg.type(), text: msg.text() });
        });
        await browserPage.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 15000 });
        await browserPage.waitForFunction(() => customElements.get("ef-timegroup") && customElements.get("ef-text"));
        const at03 = await captureStage(browserPage, 0.3, join(evidenceDir, "preview-backend-0p3s.png"));
        const at13 = await captureStage(browserPage, 1.3, join(evidenceDir, "preview-backend-1p3s.png"));
        await browserPage.locator("ef-timegroup#root").first().screenshot({ path: join(evidenceDir, "preview-authoring-copy.png") });
        await browser.close();

        expect(pageerrors, JSON.stringify(pageerrors)).toEqual([]);
        const blockingFailed = requestfailed.filter(
          (item) => /\.(css|js)(\?|$)/.test(item.url) || item.url.includes("/src/")
        );
        expect(blockingFailed, JSON.stringify(blockingFailed)).toEqual([]);
        expect(at03.defined.timegroup).toBe(true);
        expect(at03.defined.video).toBe(true);
        expect(at03.defined.text).toBe(true);
        expect(at03.currentTime).toBeCloseTo(0.3, 2);
        expect(at13.currentTime).toBeCloseTo(1.3, 2);
        expect(at03.root.bounds.w).toBe(1280);
        expect(at03.root.bounds.h).toBe(720);
        const visible03 = at03.captions.find((caption) => caption && caption.bounds.w > 100 && caption.bounds.h > 20);
        const visible13 = at13.captions.find((caption) => caption && caption.bounds.w > 100 && caption.bounds.h > 20);
        expect(visible03?.text).toContain("コピー編集の字幕");
        expect(visible13?.text).toContain("クリップB 無音映像");
        expect(visible03?.bounds.y).toBeGreaterThan(500);
        expect(visible13?.bounds.y).toBeGreaterThan(500);
        expect(Number.parseInt(visible03?.fontSize ?? "0", 10)).toBeGreaterThanOrEqual(40);
        const visibleVideo03 = at03.videos.find((item) => item && item.bounds.w >= 1280 && item.bounds.h >= 720);
        const visibleVideo13 = at13.videos.find((item) => item && item.bounds.w >= 1280 && item.bounds.h >= 720);
        expect(visibleVideo03).toBeTruthy();
        expect(visibleVideo13).toBeTruthy();
        await writeFile(
          join(evidenceDir, "preview-backend-debug.json"),
          `${JSON.stringify({ pageerrors, requestfailed, consoleLines, at03, at13, viteRoot: composition }, null, 2)}\n`
        );
      } finally {
        const group = await listGroupPids(preview.handle.pgid);
        await stopOwned(preview.handle);
        expect(pidAlive(preview.handle.pid)).toBe(false);
        for (const pid of group) {
          expect(pidAlive(pid)).toBe(false);
        }
      }

      const wrapper = spawn(process.execPath, [resolve("backends/editframe/preview.mjs"), composition], {
        cwd: process.cwd(),
        env: childEnv(),
        detached: true,
        stdio: "ignore"
      });
      const wrapperDir = join(dirname(composition), `${composition.split("/").pop()}-authoring`);
      temporaryDirectories.push(wrapperDir);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      const listed = spawnSync("ps", ["-ax", "-o", "pid=,ppid="], { encoding: "utf8" });
      const byParent = new Map<number, number[]>();
      for (const line of listed.stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) continue;
        const pid = Number(match[1]);
        const ppid = Number(match[2]);
        const list = byParent.get(ppid) ?? [];
        list.push(pid);
        byParent.set(ppid, list);
      }
      const descendants: number[] = [];
      const stack = [wrapper.pid!];
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const childPid of byParent.get(current) ?? []) {
          descendants.push(childPid);
          stack.push(childPid);
        }
      }
      const tracked = new Set<number>([wrapper.pid!, ...descendants]);
      for (const pid of descendants) {
        for (const grouped of await listGroupPids(pid)) tracked.add(grouped);
      }
      process.kill(wrapper.pid!, "SIGTERM");
      await new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error("preview CLI did not exit after SIGTERM")), 10000);
        wrapper.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
      expect(pidAlive(wrapper.pid!)).toBe(false);
      for (const pid of tracked) {
        expect(pidAlive(pid)).toBe(false);
      }
    },
    240000
  );
});
