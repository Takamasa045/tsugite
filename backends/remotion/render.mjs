import { bundle } from "@remotion/bundler";
import { getVideoMetadata, renderMedia, selectComposition } from "@remotion/renderer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

try {
  const input = parsePayload(JSON.parse(await readStdin()));
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8"));
  const entryPoint = fileURLToPath(new URL("./root.js", import.meta.url));
  const bundleDir = await mkdtemp(join(tmpdir(), "tsugite-remotion-"));

  try {
    const serveUrl = await bundle({
      entryPoint,
      publicDir: input.runDir,
      rootDir: process.cwd(),
      outDir: bundleDir,
      onProgress: () => undefined
    });
    const inputProps = { manifest };
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
      outputLocation: input.outputPath,
      inputProps,
      overwrite: true,
      concurrency: 1,
      logLevel: "error",
      timeoutInMilliseconds: 120000
    });

    const metadata = await getVideoMetadata(input.outputPath, { logLevel: "error" });
    const report = {
      backend: "remotion",
      output_path: input.outputPath,
      manifest_path: input.manifestPath,
      duration_seconds: metadata.durationInSeconds,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      codec: metadata.codec,
      audio_codec: metadata.audioCodec,
      clip_count: manifest.clips.length,
      rendered_at: new Date().toISOString()
    };
    await writeFile(input.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, report_path: input.reportPath, output_path: input.outputPath }));
  } finally {
    await rm(bundleDir, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parsePayload(input) {
  if (!input || typeof input !== "object") {
    throw new Error("render payload must be an object");
  }

  const runDir = requiredPath(input.runDir, "runDir");
  const manifestPath = requiredPath(input.manifestPath, "manifestPath");
  const outputPath = requiredPath(input.outputPath, "outputPath");
  const reportPath = requiredPath(input.reportPath, "reportPath");

  assertExactPath(manifestPath, join(runDir, "manifest.json"), "manifestPath");
  assertExactPath(outputPath, join(runDir, "final.mp4"), "outputPath");
  assertExactPath(reportPath, join(runDir, "render-report.json"), "reportPath");

  return { runDir, manifestPath, outputPath, reportPath };
}

function requiredPath(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty path`);
  }
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be absolute`);
  }
  return resolve(value);
}

function assertExactPath(actual, expected, name) {
  const resolvedExpected = resolve(expected);
  if (actual !== resolvedExpected) {
    throw new Error(`${name} must equal ${resolvedExpected}`);
  }
}
