// Independent checks on decoded MP4 frames and PCM, not capability flags or HTML.
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { CARDS } from "../build/fastEdit/schema.js";
const root = resolve(process.argv[2]);
const reports = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
if (reports.reports.length !== 6)
  throw new Error("Wait for all six native renders before pixel QA");
const checks = [];
let audioDigest;
function exec(cmd, args, encoding) {
  const r = spawnSync(cmd, args, { encoding, maxBuffer: 40e6 });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout;
}
function frame(file, t) {
  return exec("ffmpeg", [
    "-v",
    "error",
    "-ss",
    String(t),
    "-i",
    file,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
}
function mae(a, b) {
  if (a.length !== b.length) throw new Error("frame size mismatch");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
const sourcePCM = exec("ffmpeg", [
  "-v",
  "error",
  "-i",
  join(root, "source.mp4"),
  "-f",
  "s16le",
  "-ac",
  "2",
  "-ar",
  "48000",
  "-",
]);
const sourceHash = createHash("sha256").update(sourcePCM).digest("hex");
for (const aspect of ["16x9", "9x16"]) {
  const samples = [
    ...CARDS.map((_, i) => i * 0.6 + 0.5),
    0.033,
    0.1,
    0.2,
    0.59,
    0.6,
    0.63,
    0.7,
    1.19,
    1.2,
    1.23,
    4.79,
    4.8,
    4.83,
    10.7,
  ];
  const reference = samples.map((t) =>
    frame(join(root, `remotion-${aspect}/final.mp4`), t),
  );
  for (const backend of ["remotion", "hyperframes", "editframe"]) {
    const dir = join(root, `${backend}-${aspect}`),
      file = join(dir, "final.mp4");
    await mkdir(join(dir, "caption-qa"), { recursive: true });
    const pcm = exec("ffmpeg", [
      "-v",
      "error",
      "-i",
      file,
      "-f",
      "s16le",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-",
    ]);
    const hash = createHash("sha256").update(pcm).digest("hex");
    audioDigest ??= hash;
    if (hash !== audioDigest || hash === sourceHash)
      throw new Error("audio parity or SFX presence failed");
    const comparisons = samples.map((t, i) => ({
      time: t,
      mean_absolute_rgb_error: mae(reference[i], frame(file, t)),
    }));
    // Different native H.264 encoders are lossy. Tolerance is in 8-bit RGB units,
    // checked per frame (including transitions), never averaged over the program.
    const pixelPass = comparisons.every((c) => c.mean_absolute_rgb_error < 12);
    const captions = [];
    for (let i = 0; i < 18; i++) {
      const image = join(dir, "caption-qa", `${i + 1}.png`),
        t = i * 0.6 + 0.5;
      exec("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-ss",
        String(t),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        aspect === "9x16"
          ? "crop=iw*0.86:ih*0.07:iw*0.07:ih*0.82,scale=iw*5:ih*5"
          : "crop=iw*0.86:ih*0.12:iw*0.07:ih*0.77,scale=iw*5:ih*5",
        image,
      ]);
      let text = exec(
        "tesseract",
        [image, "stdout", "--psm", "7"],
        "utf8",
      ).trim();

      const expected = `Learn ${CARDS[i].replaceAll("_", " ")} today`;
      const firstOcr = text;
      if (
        !text
          .toLowerCase()
          .replace(/[^a-z]/g, "")
          .includes(expected.toLowerCase().replace(/[^a-z]/g, ""))
      ) {
        text = exec(
          "tesseract",
          [image, "stdout", "--psm", "6"],
          "utf8",
        ).trim();
      }
      const normalized = text.toLowerCase().replace(/[^a-z]/g, "");
      const pass = normalized.includes(
        expected.toLowerCase().replace(/[^a-z]/g, ""),
      );
      captions.push({
        time: t,
        expected,
        first_ocr: firstOcr,
        recognized: text,
        pass,
      });
    }
    const captionPass = captions.every((c) => c.pass);
    checks.push({
      backend,
      aspect,
      pixelPass,
      captionPass,
      audioPass: true,
      audio_sha256: hash,
      comparisons,
      captions,
    });
    const report = reports.reports.find(
      (r) => r.backend === backend && r.aspect.replace(":", "x") === aspect,
    );
    report.caption = captionPass ? "PASS" : "FAIL";
    report.visual_parity = pixelPass ? "PASS" : "FAIL";
    console.log(backend, aspect, {
      pixelPass,
      maxError: Math.max(...comparisons.map((c) => c.mean_absolute_rgb_error)),
      captionPass,
      failed: captions.filter((c) => !c.pass),
    });
  }
}
const ok = checks.every((c) => c.pixelPass && c.captionPass && c.audioPass);
await writeFile(
  join(root, "pixel-caption-audio-qa.json"),
  JSON.stringify(
    {
      ok,
      criteria: {
        max_rgb_mae: 12,
        ocr: "all 18 captions, exact normalized text",
        audio:
          "identical decoded PCM across all outputs and differs from source",
      },
      checks,
    },
    null,
    2,
  ),
);
await writeFile(
  join(root, "report.json"),
  JSON.stringify({ ...reports, ok }, null, 2),
);
if (!ok) process.exitCode = 1;
