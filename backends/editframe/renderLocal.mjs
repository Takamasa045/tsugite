import { spawn } from "node:child_process";
import { access, mkdtemp, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveEditframeCli } from "./runtimePath.mjs";

// CLI 0.60.34 moved to a separately installed native bridge. This HTML backend
// uses the current Elements SDK: deterministic seekForRender, local frames and
// FFmpeg. It needs no hosted API, bridge/browser download or authentication.
export function assertLocalCaptureUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Editframe capture requires an http loopback URL without credentials");
  }
  return url.href;
}

async function existingBrowser() {
  const selected = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (selected) { await access(selected, constants.X_OK); return selected; }
  for (const file of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]) {
    try { await access(file, constants.X_OK); return file; } catch { /* Existing browsers only. */ }
  }
  throw new Error("Select an existing Chrome executable with CHROME_PATH; no browser is downloaded");
}

export async function renderLocal({ url, output, fps = 30 }) {
  url = assertLocalCaptureUrl(url);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error("Invalid local capture fps");
  const runtime = resolveEditframeCli();
  if (!runtime.ok) throw new Error(runtime.message);
  const { default: puppeteer } = await import(pathToFileURL(runtime.puppeteerPath).href);
  const work = await mkdtemp(join(dirname(resolve(output)), ".editframe-capture-"));
  let browser, encoder;
  try {
    browser = await puppeteer.launch({ executablePath: await existingBrowser(), headless: true });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", request => {
      const value = request.url();
      if (/^(data|blob):/.test(value)) { void request.continue(); return; }
      try { assertLocalCaptureUrl(value); void request.continue(); }
      catch { void request.abort("blockedbyclient"); }
    });
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForFunction(() => {
      const root = document.querySelector("ef-timegroup#root");
      return root && typeof root.seekForRender === "function" && Number.isFinite(root.duration) && root.duration > 0;
    }, { timeout: 30000 });
    const size = await page.evaluate(() => {
      const root = document.querySelector("ef-timegroup#root"), rect = root.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height), seconds: root.duration };
    });
    if (![size.width, size.height].every(n => Number.isInteger(n) && n > 0 && n <= 4096) || !(size.seconds > 0 && size.seconds <= 3600)) {
      throw new Error("Invalid or oversized Editframe capture dimensions/duration");
    }
    await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
    const target = join(work, "video.mp4");
    encoder = spawn("ffmpeg", ["-nostdin", "-v", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "pipe:0", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", target], { stdio: ["pipe", "ignore", "pipe"], shell: false });
    let stderr = "";
    encoder.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-65536); });
    encoder.stdin.on("error", () => { /* Pending write/exit reports the error. */ });
    const completion = new Promise((accept, reject) => {
      encoder.once("error", reject);
      encoder.once("close", code => code === 0 ? accept() : reject(new Error(`Local Editframe encoder failed: ${stderr}`)));
    });
    void completion.catch(() => {});
    const root = await page.$("ef-timegroup#root");
    for (let frame = 0; frame < Math.ceil(size.seconds * fps); frame++) {
      await page.evaluate(async time => { await document.querySelector("ef-timegroup#root").seekForRender(time, { strictVideoPaint: true }); }, frame / fps);
      const bytes = await root.screenshot({ type: "png", omitBackground: false });
      await new Promise((accept, reject) => encoder.stdin.write(bytes, error => error ? reject(error) : accept()));
    }
    encoder.stdin.end();
    await completion;
    await rename(target, resolve(output));
    return size;
  } finally {
    if (encoder && encoder.exitCode === null && encoder.signalCode === null) encoder.kill("SIGTERM");
    if (browser) await browser.close();
    await rm(work, { recursive: true, force: true });
  }
}

export async function runLocalCapture(argv) {
  const { values } = parseArgs({ args: argv, options: { url: { type: "string" }, output: { type: "string", short: "o" }, fps: { type: "string" }, capture: { type: "string" } } });
  if (!values.url || !values.output) throw new Error("Local capture requires --url and --output");
  if (values.capture && values.capture !== "foreign-object") throw new Error("Unsupported capture mode");
  return renderLocal({ url: values.url, output: values.output, fps: Number(values.fps ?? 30) });
}
