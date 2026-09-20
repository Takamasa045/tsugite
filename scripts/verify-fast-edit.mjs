// Local parity fixture: no provider, no Gate decisions, no project media writes.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  CARDS,
  GLOBAL_OPTIONS,
  EDIT_OPTIONS,
} from "../build/fastEdit/schema.js";
import {
  buildJevRequest,
  splitBeats,
  compileFastEdit,
  decisionsFromAnswers,
} from "../build/fastEdit/compile.js";
import { validateManifest } from "../build/manifest/validate.js";
import {
  loadBackendCapabilities,
  validateBackendCapabilities,
} from "../build/backends/capabilities.js";
import { inspectGate3Output } from "../build/orchestrator/gate3Qc.js";
const root = resolve(
  process.argv[2] ?? `verification/evidence/fast-edit-${Date.now()}`,
);
await mkdir(root, { recursive: true });
const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], {
    encoding: "utf8",
    maxBuffer: 16e6,
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r;
};
const duration = 10.8;
const source = join(root, "source.mp4");
ff([
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=1024x576:rate=30",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=220:sample_rate=48000",
  "-t",
  String(duration),
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  source,
]);
const words = CARDS.flatMap((card, i) =>
  ["Learn", card.replaceAll("_", " "), "today"].map((text, j) => ({
    id: `word-${String(i * 3 + j + 1).padStart(3, "0")}`,
    text,
    start: Number((i * 0.6 + j * 0.18).toFixed(4)),
    end: Number((i * 0.6 + j * 0.18 + 0.16).toFixed(4)),
  })),
);
const beats = splitBeats(words, duration, 0.6),
  request = buildJevRequest(words, beats);
const answers = Object.fromEntries(
  request.questions.map((q) => {
    let choice;
    if (q.id.startsWith("global."))
      choice = {
        style: "energetic",
        color: "warm",
        caption_style: "bold",
        energy: "high",
        progress_bar: "bottom",
      }[q.id.split(".")[1]];
    else {
      const i = beats.findIndex((b) => q.id.startsWith(b.id + ".")),
        field = q.id.split(".")[1];
      choice =
        field === "emphasis_word"
          ? beats[i].word_ids[1]
          : field === "visual_needed"
            ? "yes"
            : field === "card"
              ? CARDS[i]
              : EDIT_OPTIONS[field][i % EDIT_OPTIONS[field].length];
    }
    return [q.id, { type: "choice", choice, action: "act", confidence: 1 }];
  }),
);
await writeFile(
  join(root, "jev-decision-fixture.json"),
  JSON.stringify({ answers }, null, 2),
);
await writeFile(
  join(root, "word-timestamps-fixture.json"),
  JSON.stringify(words, null, 2),
);
const decisions = decisionsFromAnswers(words, beats, { answers });
const reports = [];
for (const aspect of ["16:9", "9:16"])
  for (const backend of ["remotion", "hyperframes", "editframe"]) {
    const dir = join(root, `${backend}-${aspect.replace(":", "x")}`);
    await mkdir(dir, { recursive: true });
    await copyFile(source, join(dir, "source.mp4"));
    const sourceManifest = {
      meta: {
        aspect,
        fps: 30,
        target_duration_seconds: duration,
        slug: "fast-edit-parity",
      },
      clips: [
        {
          id: "source-a",
          src: "source.mp4",
          in: 0,
          out: 5.4,
          duration: 5.4,
          fps: 30,
          resolution: { width: 1024, height: 576 },
          audio: true,
        },
        {
          id: "source-b",
          src: "source.mp4",
          in: 5.4,
          out: duration,
          duration: 5.4,
          fps: 30,
          resolution: { width: 1024, height: 576 },
          audio: true,
        },
      ],
      images: [],
      speakers: [],
      captions: [],
      chapters: [],
      audio: { bgm: [], narration: [], sfx: [] },
      provenance: [],
    };
    const compiled = compileFastEdit(sourceManifest, decisions),
      manifest = compiled.manifest;
    const valid = validateManifest(manifest);
    if (!valid.ok) throw new Error(JSON.stringify(valid.issues));
    const caps = validateBackendCapabilities(
      manifest,
      await loadBackendCapabilities(backend),
    );
    if (!caps.ok) throw new Error(JSON.stringify(caps.issues));
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    await writeFile(
      join(dir, "fast-edit-edl.json"),
      JSON.stringify(compiled.edl, null, 2),
    );
    const payload = {
      runDir: dir,
      manifestPath: join(dir, "manifest.json"),
      outputPath: join(dir, "final.mp4"),
      reportPath: join(dir, "render-report.json"),
    };
    const start = Date.now();
    console.log(`render ${backend} ${aspect}`);
    const result = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [`backends/${backend}/render.mjs`],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(payload));
    });
    await writeFile(join(dir, "process.json"), JSON.stringify(result, null, 2));
    if (result.code !== 0)
      throw new Error(`${backend}: ${result.stderr.slice(-3000)}`);
    await copyFile(payload.outputPath, join(dir, "output.mp4"));
    const qa = inspectGate3Output(manifest, payload.outputPath);
    await writeFile(join(dir, "gate3-qc.json"), JSON.stringify(qa, null, 2));
    if (!qa.ok) throw new Error(JSON.stringify(qa.issues));
    // Decode the entire deliverable; make one frame per card for independent visual QA.
    ff(["-i", payload.outputPath, "-f", "null", "-"]);
    for (let i = 0; i < 18; i++)
      ff([
        "-ss",
        String(i * 0.6 + 0.27),
        "-i",
        payload.outputPath,
        "-frames:v",
        "1",
        join(dir, `card-${String(i + 1).padStart(2, "0")}.png`),
      ]);
    reports.push({
      backend,
      aspect,
      output: join(dir, "output.mp4"),
      source_sha256: createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
      decisions_sha256: createHash("sha256")
        .update(JSON.stringify(decisions))
        .digest("hex"),
      elapsed_ms: Date.now() - start,
      ffprobe: "PASS",
      audio: "PASS",
      duration: "PASS",
      capabilities: "PASS",
      caption: "pending visual/pixel verification",
      qa,
    });
    await writeFile(
      join(root, "report.json"),
      JSON.stringify({ root, reports }, null, 2),
    );
    console.log(`PASS ${backend} ${aspect} ${Date.now() - start}ms`);
  }
console.log(root);
