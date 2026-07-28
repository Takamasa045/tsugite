import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

try {
  const input = parsePayload(JSON.parse(await readStdin()));
  await mkdir(resolve(input.previewPath, ".."), { recursive: true });
  const realReviewDir = await realpath(input.reviewDir);
  const previewParent = dirname(input.previewPath);
  if ((await lstat(previewParent)).isSymbolicLink() || !isWithin(realReviewDir, await realpath(previewParent))) {
    throw new Error("preview output directory must stay within the real review directory");
  }
  try {
    if ((await lstat(input.previewPath)).isSymbolicLink()) throw new Error("preview output must not be a symbolic link");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  const bundleDir = await mkdtemp(join(tmpdir(), "tsugite-review-preview-"));
  const mediaDir = await mkdtemp(join(previewParent, ".review-preview-"));
  const renderedPath = join(mediaDir, "render.mp4");
  const finalizedPath = join(mediaDir, "final.mp4");
  try {
    const serveUrl = await bundle({
      entryPoint: fileURLToPath(new URL("./root.js", import.meta.url)),
      publicDir: input.reviewDir,
      rootDir: process.cwd(),
      outDir: bundleDir,
      onProgress: () => undefined
    });
    const inputProps = { manifest: input.manifest };
    const composition = await selectComposition({
      serveUrl,
      id: "tsugite-render",
      inputProps,
      logLevel: "error",
      timeoutInMilliseconds: 120000
    });
    await renderMedia({
      serveUrl,
      composition,
      codec: "h264",
      audioCodec: null,
      outputLocation: renderedPath,
      inputProps,
      overwrite: true,
      concurrency: 1,
      logLevel: "error",
      timeoutInMilliseconds: 120000
    });
    await stripAudio(renderedPath, finalizedPath);
    try {
      if ((await lstat(input.previewPath)).isSymbolicLink()) throw new Error("preview output must not be a symbolic link");
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
    await rename(finalizedPath, input.previewPath);
  } finally {
    await Promise.all([
      rm(bundleDir, { recursive: true, force: true }),
      rm(mediaDir, { recursive: true, force: true })
    ]);
  }
  if (!(await stat(input.previewPath)).isFile()) throw new Error("preview output is missing");
  console.log(JSON.stringify({ ok: true, preview_path: input.previewPath }));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}

async function stripAudio(inputPath, outputPath) {
  await promisify(execFile)("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-c:v", "copy",
    "-an",
    outputPath
  ], { maxBuffer: 1024 * 1024 });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parsePayload(value) {
  if (!value || typeof value !== "object") throw new Error("preview payload must be an object");
  const reviewDir = requiredPath(value.reviewDir, "reviewDir");
  const previewPath = requiredPath(value.previewPath, "previewPath");
  if (!isWithin(reviewDir, previewPath) || !previewPath.endsWith(".mp4")) {
    throw new Error("previewPath must be an MP4 inside reviewDir");
  }
  if (!value.manifest || typeof value.manifest !== "object") throw new Error("manifest is required");
  return { reviewDir, previewPath, manifest: value.manifest };
}

function requiredPath(value, name) {
  if (typeof value !== "string" || !value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
