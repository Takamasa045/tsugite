import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CARDS,
  FAST_EDIT_CAPABILITIES,
  fastEditSchema,
} from "../src/fastEdit/schema.js";
import {
  buildJevRequest,
  compileFastEdit,
  decisionsFromAnswers,
  splitBeats,
  wordsFromAnalysis,
} from "../src/fastEdit/compile.js";
import {
  prepareFastEdit,
  loadFastEdit,
  fastEditContext,
} from "../src/fastEdit/artifacts.js";
import { manifestSchema } from "../src/manifest/schema.js";
import { projectSchema } from "../src/project/schema.js";
import { validateManifest } from "../src/manifest/validate.js";
import {
  loadBackendCapabilities,
  validateBackendCapabilities,
} from "../src/backends/capabilities.js";
import { validateProject } from "../src/project/validateProject.js";
// @ts-expect-error native browser math
import {
  sampleFastEdit,
  browserSceneSource,
} from "../backends/fastEditScene.mjs";
// @ts-expect-error native audio
import { synthesizeSfx } from "../backends/fastEditAudio.mjs";
const source = () =>
  manifestSchema.parse({
    meta: {
      slug: "fast",
      aspect: "16:9",
      fps: 30,
      target_duration_seconds: 40,
    },
    clips: [
      {
        id: "source",
        src: "source.mp4",
        in: 0,
        out: 40,
        duration: 40,
        fps: 30,
        resolution: { width: 640, height: 360 },
        audio: true,
      },
    ],
  });
const words = Array.from({ length: 16 }, (_, i) => ({
  id: `word-${i}`,
  text: `Caption ${i}`,
  start: i * 2.5 + 0.1,
  end: i * 2.5 + 1,
}));
const beats = splitBeats(words, 40);
const request = buildJevRequest(words, beats);
const answers = () => ({
  answers: Object.fromEntries(
    request.questions.map((q) => [
      q.id,
      { choice: Object.keys(q.options)[0], action: "act" },
    ]),
  ),
});
const decisions = () => decisionsFromAnswers(words, beats, answers());

describe("Fast Edit neutral contract", () => {
  it("batches exactly 16 x 7 + 5 independent questions", () => {
    expect(request.questions).toHaveLength(117);
    expect(new Set(request.questions.map((q) => q.id)).size).toBe(117);
    expect(CARDS).toHaveLength(18);
  });
  it("splits on word boundaries, retains gaps and source duration", () => {
    const b = splitBeats(
      [{ id: "word-1", text: "hello", start: 0.3, end: 3 }],
      4,
      2.5,
    );
    expect(b.map((x) => [x.start, x.end])).toEqual([
      [0, 3],
      [3, 4],
    ]);
  });
  it("rejects empty, overlapping, duplicate, out of range words and invalid targets", () => {
    for (const w of [
      [],
      [words[0], words[0]],
      [{ ...words[0], end: 50 }],
      [{ ...words[0], end: 0 }],
    ])
      expect(() => splitBeats(w, 40)).toThrow();
    expect(() => splitBeats(words, 40, 0)).toThrow();
  });
  it("compiles captions and a neutral EDL without changing source or source timing", () => {
    const m = source(),
      before = structuredClone(m),
      c = compileFastEdit(m, decisions());
    expect(m).toEqual(before);
    expect(c.manifest.clips).toEqual(m.clips);
    expect(c.manifest.captions).toHaveLength(16);
    expect(c.edl.fast_edit).toEqual(c.manifest.fast_edit);
    expect(JSON.stringify(c.edl)).not.toMatch(/remotion|hyperframes|editframe/);
  });
  it("rejects incomplete, unknown, low-confidence Jev answers without fallback", () => {
    for (const change of ["missing", "choice", "review", "abstain", "extra"]) {
      const a = answers();
      if (change === "missing") delete a.answers["global.style"];
      else if (change === "extra")
        a.answers["extra"] = { choice: "yes", action: "act" };
      else if (change === "choice")
        a.answers["global.style"].choice = "execute-code";
      else a.answers["global.style"].action = change;
      expect(() => decisionsFromAnswers(words, beats, a)).toThrow();
    }
    expect(() => decisionsFromAnswers(words, beats, {})).toThrow();
  });
  it("validates emphasis by word identity and blocks backend/code fields", () => {
    for (const mutate of [
      (d: any) => (d.beats[0].edit.emphasis_word_id = "word-15"),
      (d: any) => (d.beats[0].edit.remotion_component = "eval"),
      (d: any) => (d.beats[0].end = 9),
      (d: any) => (d.words[0].end = 0),
      (d: any) => (d.beats[1].id = d.beats[0].id),
      (d: any) => (d.beats[0].word_ids = []),
    ]) {
      const d = decisions();
      mutate(d);
      expect(fastEditSchema.safeParse(d).success).toBe(false);
    }
  });
  it("rejects duration drift and legacy mixed presentation", () => {
    const d = decisions();
    d.beats.at(-1)!.end = 41;
    expect(() => compileFastEdit(source(), d)).toThrow();
    expect(
      validateManifest({
        ...compileFastEdit(source(), decisions()).manifest,
        meta: { ...source().meta, target_duration_seconds: 41 },
      }).ok,
    ).toBe(false);
    expect(() =>
      compileFastEdit(
        { ...source(), presentation: { preset: "other", draft: false } },
        decisions(),
      ),
    ).toThrow();
  });
  it.each(["remotion", "hyperframes", "editframe"])(
    "requires all Fast Edit capabilities on %s",
    async (name) => {
      const backend = (await loadBackendCapabilities(name))!,
        m = compileFastEdit(source(), decisions()).manifest;
      expect(validateBackendCapabilities(m, backend).ok).toBe(true);
      for (const key of FAST_EDIT_CAPABILITIES) {
        const b = structuredClone(backend);
        b.capabilities.fast_edit![key] = false;
        expect(validateBackendCapabilities(m, b).ok).toBe(false);
      }
    },
  );
  it("evaluates every card distinctly and emphasis at exact word times", () => {
    const m = compileFastEdit(source(), decisions()).manifest;
    const signatures = new Set();
    for (const card of CARDS) {
      m.fast_edit!.beats[0].edit.card = card;
      const scene = sampleFastEdit(m, 0.5, { width: 640, height: 360 });
      signatures.add(
        JSON.stringify(scene.layers.find((n: any) => n.id === "fe-card")),
      );
    }
    expect(signatures.size).toBe(18);
    const a = sampleFastEdit(m, 0.5, { width: 640, height: 360 }),
      b = sampleFastEdit(m, 1.1, { width: 640, height: 360 });
    expect(a.layers[0].children[0].style.color).not.toEqual(
      b.layers[0].children[0].style.color,
    );
  });
  it("all style/color/pacing/effect/transition choices change sampled output", () => {
    const m = compileFastEdit(source(), decisions()).manifest;
    for (const [key, values] of Object.entries({
      style: ["energetic", "minimal", "editorial"],
      color: ["source", "warm", "cool", "mono"],
      caption_style: ["bold", "outlined", "clean"],
      energy: ["high", "medium", "low"],
      progress_bar: ["bottom", "top", "none"],
    })) {
      const samples = values.map((v) => {
        (m.fast_edit!.global as any)[key] = v;
        m.fast_edit!.beats[0].edit.text_effect = "pop";
        return JSON.stringify(
          sampleFastEdit(m, 0.1, { width: 640, height: 360 }),
        );
      });
      expect(new Set(samples).size).toBe(values.length);
    }
  });
  it("escapes user text in executable browser data and synthesizes distinct audible SFX", () => {
    const m = compileFastEdit(source(), decisions()).manifest;
    m.fast_edit!.words[0].text = "</script><script>alert(1)</script>";
    expect(browserSceneSource(m, { width: 640, height: 360 })).not.toContain(
      "</script>",
    );
    const sounds = ["whoosh", "pop", "chime"].map((k) => synthesizeSfx(k));
    expect(sounds.every((s) => s.toString("ascii", 0, 4) === "RIFF")).toBe(
      true,
    );
    expect(new Set(sounds.map((s) => s.toString("base64"))).size).toBe(3);
    expect(() => synthesizeSfx("bad")).toThrow();
  });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tsugite-fast-edit-test-"));
  const m = source(),
    project = projectSchema.parse({
      slug: "fast",
      name: "Fast Edit fixture",
      manifest: "manifest.json",
      edit: { backend: "remotion", fast_edit: { enabled: true } },
      analysis: {
        adapter: "local-whisper-analysis",
        requests: [
          { id: "transcript", output: "transcript", source_clip_id: "source" },
        ],
      },
    });
  await writeFile(join(root, "source.mp4"), "test-source-bytes");
  const sha = createHash("sha256").update("test-source-bytes").digest("hex");
  const raw = {
    results: [
      {
        adapter: "local-whisper-analysis",
        metadata: { api_used: false, network_used: false },
        output: "transcript",
        source: {
          clip_id: "source",
          sha256: sha,
          analysis_start_seconds: 0,
          analysis_end_seconds: 40,
        },
        data: {
          segments: [
            {
              words: words.map((w) => ({
                text: w.text,
                source_start: w.start,
                source_end: w.end,
              })),
            },
          ],
        },
      },
    ],
  };
  await mkdir(join(root, "dist/fast/analysis"), { recursive: true });
  await writeFile(
    join(root, "dist/fast/analysis/raw-analysis.json"),
    JSON.stringify(raw),
  );
  await writeFile(join(root, "manifest.json"), JSON.stringify(m));
  return { root, m, project, raw, config: join(root, "project.yaml") };
}
describe("Fast Edit artifact integration", () => {
  it("reuses Whisper word timestamps and fails missing/ambiguous transcript", async () => {
    const f = await fixture();
    expect(wordsFromAnalysis(f.m, f.raw)).toHaveLength(16);
    expect(() => wordsFromAnalysis(f.m, {})).toThrow();
    f.raw.results.push(f.raw.results[0]);
    expect(() => wordsFromAnalysis(f.m, f.raw)).toThrow();
  });
  it("prepares request, compiles once, persists in Artifact Store and validates all three backends", async () => {
    const f = await fixture();
    const p = await prepareFastEdit(f.config, f.project, f.m);
    expect(p.status).toBe("awaiting_decisions");
    expect(p.question_count).toBe(117);
    const ctx = await fastEditContext(f.config, f.project, f.m);
    const a = {
      answers: Object.fromEntries(
        ctx.request.questions.map((q) => [
          q.id,
          { choice: Object.keys(q.options)[0], action: "act" },
        ]),
      ),
    };
    let calls = 0;
    const result = await prepareFastEdit(f.config, f.project, f.m, {
      ask: async () => {
        calls++;
        return a;
      },
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("compiled");
    expect(
      (await prepareFastEdit(f.config, f.project, f.m, { answers: a })).status,
    ).toBe("compiled");
    const compiled = await loadFastEdit(f.config, f.project, f.m);
    expect(compiled.manifest.fast_edit?.beats).toHaveLength(16);
    for (const backend of ["remotion", "hyperframes", "editframe"]) {
      await writeFile(
        f.config,
        JSON.stringify({ ...f.project, edit: { ...f.project.edit, backend } }),
      );
      const valid = await validateProject(f.config);
      expect(valid.issues).toEqual([]);
      expect(valid.manifest?.fast_edit).toEqual(compiled.manifest.fast_edit);
    }
    expect(await readFile(join(f.root, "manifest.json"), "utf8")).toBe(
      JSON.stringify(f.m),
    );
  });
  it("blocks stale source, changed analysis, edit conflicts and disabled mode", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "source.mp4"), "changed");
    await expect(fastEditContext(f.config, f.project, f.m)).rejects.toThrow(
      /source bytes/,
    );
    f.project.edit.fast_edit!.enabled = false;
    await expect(fastEditContext(f.config, f.project, f.m)).rejects.toThrow(
      /enabled/,
    );
  });
  it("rejects source symlink escaping the project before reading its contents", async () => {
    const f = await fixture();
    await symlink("/etc/hosts", join(f.root, "external.mp4"));
    f.m.clips[0].src = "external.mp4";
    await expect(fastEditContext(f.config, f.project, f.m)).rejects.toThrow(
      /escapes/,
    );
  });
});

describe("Fast Edit CLI and Gate review", () => {
  it("prepares and compiles through the public CLI, exposes decisions in review, and preserves human Gates", async () => {
    const { spawnSync } = await import("node:child_process");
    const { createEditorialProposal } =
      await import("../src/orchestrator/editorialProposal.js");
    const f = await fixture();
    const raw = {
      schema_version: 1 as const,
      run_id: "fast",
      slug: "fast",
      input_digest: "a".repeat(64),
      ...f.raw,
      results: f.raw.results.map((r) => ({ ...r, request_id: "transcript" })),
    };
    await writeFile(
      join(f.root, "dist/fast/analysis/raw-analysis.json"),
      JSON.stringify(raw),
    );
    await writeFile(
      join(f.root, "dist/fast/analysis/editorial-proposal.json"),
      JSON.stringify(createEditorialProposal(raw)),
    );
    await writeFile(f.config, JSON.stringify(f.project));
    const run = (args: string[]) => {
      const p = spawnSync(
        process.execPath,
        ["bin/pipeline", ...args, "--config", f.config, "--json"],
        {
          encoding: "utf8",
          env: { ...process.env, TSUGITE_PROJECTS_HOME: join(f.root, "shelf") },
        },
      );
      return { code: p.status, data: JSON.parse(p.stdout || p.stderr) };
    };
    expect(run(["fast-edit"]).data.issues[0].code).toBe(
      "cli.coordinator_required",
    );
    expect(run(["render", "--actor", "coordinator"]).code).toBe(1);
    const prepared = run(["fast-edit", "--actor", "coordinator"]);
    expect(prepared.code).toBe(0);
    expect(prepared.data.question_count).toBe(117);
    const ctx = await fastEditContext(f.config, f.project, f.m);
    const a = {
      answers: Object.fromEntries(
        ctx.request.questions.map((q) => [
          q.id,
          { choice: Object.keys(q.options)[0], action: "act" },
        ]),
      ),
    };
    await writeFile(join(f.root, "answers.json"), JSON.stringify(a));
    const compiled = run([
      "fast-edit",
      "--actor",
      "coordinator",
      "--decisions",
      join(f.root, "answers.json"),
    ]);
    expect(compiled.data).toMatchObject({
      ok: true,
      status: "compiled",
      gate_state: "unchanged",
    });
    expect(run(["plan"]).data.plan.backend).toBe("remotion");
    const review = run(["review"]);
    expect(review.code).toBe(0);
    const data = JSON.parse(
      await readFile(join(f.root, "dist/fast/review/review-data.json"), "utf8"),
    );
    expect(data.fast_edit.beats).toHaveLength(16);
    expect(
      await readFile(join(f.root, "dist/fast/review/index.html"), "utf8"),
    ).toContain("fast-edit-review");
    const render = run(["render", "--actor", "coordinator"]);
    expect(render.code).toBe(1);
    expect(render.data.issues[0].code).toBe("render.requires_gate_2_approval");
    expect(await readFile(join(f.root, "manifest.json"), "utf8")).toBe(
      JSON.stringify(f.m),
    );
  }, 20000);
});

// Preparation validates the selected mode before its compiled Manifest exists.
it.each(["remotion", "hyperframes", "editframe"])("prepares vertical Fast Edit with %s capabilities", async backend => {
  const f = await fixture();
  f.m.meta.aspect = "9:16";
  f.project.edit.backend = backend;
  await writeFile(join(f.root, "manifest.json"), JSON.stringify(f.m));
  await writeFile(f.config, JSON.stringify(f.project));
  const result = await validateProject(f.config, {prepareFastEdit: true});
  expect(result.issues).toEqual([]);
});
