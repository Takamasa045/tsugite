import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPixverseCreateArgs,
  findNumberByKeys,
  findTaskId,
  preflightPixverseRequest,
  pixverseOperationContract
} from "../adapters/pixverse/pixverseCli.mjs";
import {
  applyH3ExecutionRouteProfile,
  compileH3Request,
  parseH3CreativeIr
} from "../src/h3/index.js";
import { loadH3ExecutionRouteProfile, validateGenerationConstraints } from "../src/adapters/constraints.js";
import { loadAdapterDefinition } from "../src/adapters/registry.js";
import { loadProject } from "../src/project/loadProject.js";
import { projectSchema } from "../src/project/schema.js";

async function loadH3Fixture(name) {
  const raw = JSON.parse(await readFile(join("test/fixtures/h3", name), "utf8"));
  return parseH3CreativeIr(raw);
}

function h3Request(id, ir, overrides = {}) {
  return {
    id,
    prompt: "",
    params: {},
    h3: ir,
    ...overrides
  };
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function flagValues(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return [];
  const values = [];
  for (let i = index + 1; i < args.length; i += 1) {
    if (String(args[i]).startsWith("--")) break;
    values.push(args[i]);
  }
  return values;
}

function assertNoRawH3Leak(args, ir) {
  const joined = args.join("\u0000");
  expect(args).not.toContain("h3");
  expect(args).not.toContain("creative_ir");
  expect(joined).not.toContain("\"version\"");
  expect(joined).not.toContain("creative_ir");
  // Fixture paths may appear as media inputs; the IR object itself must not.
  expect(joined).not.toContain(JSON.stringify(ir));
  expect(joined).not.toContain("\"shots\"");
  expect(joined).not.toContain("\"subjects\"");
}

describe("PixVerse CLI request mapping", () => {
  it("preflights a new model id without running a credit-consuming create command", () => {
    const commands = [];
    const result = preflightPixverseRequest({
      id: "future-shot",
      operation: "video",
      prompt: "a robot crossing a summer field",
      model: "minimax-h3",
      duration: 10,
      aspect: "16:9",
      params: { quality: "1440p", audio: true }
    }, {
      runCommand(executable, args) {
        commands.push([executable, ...args]);
        return { status: 0, stdout: "1.3.5\n", stderr: "" };
      }
    });

    expect(commands).toEqual([["pixverse", "--version"]]);
    expect(result).toEqual({
      request_id: "future-shot",
      status: "provider-validation-required",
      source: "pixverse-cli-runtime",
      model: "minimax-h3",
      operation: "video",
      runtime_version: "1.3.5",
      checked_parameters: ["aspect-ratio", "audio", "count", "duration", "idempotency-key", "model", "no-wait", "prompt", "quality"]
    });
  });

  it("covers every create operation exposed by PixVerse CLI 1.3.5", () => {
    expect(Object.keys(pixverseOperationContract)).toEqual([
      "video",
      "image",
      "transition",
      "voice",
      "music",
      "extend",
      "modify",
      "upscale",
      "reference",
      "motion-control",
      "template"
    ]);
  });

  it("passes gateway model names through without a provider allowlist", () => {
    const args = buildPixverseCreateArgs({
      id: "gateway-shot",
      operation: "video",
      prompt: "a connected creative workflow",
      model: "kling-o3-pro",
      duration: 5,
      aspect: "16:9",
      params: {}
    }, "demo-run");

    expect(args).toEqual(expect.arrayContaining(["--model", "kling-o3-pro"]));
  });

  it("maps image, voice, and template requests to their native create commands", () => {
    expect(buildPixverseCreateArgs({
      id: "still",
      operation: "image",
      prompt: "a calm workshop",
      model: "gemini-3.1-flash-image",
      aspect: "1:1",
      params: { detail_level: "high" }
    }, "run")).toEqual(expect.arrayContaining([
      "create", "image", "--model", "gemini-3.1-flash-image", "--detail-level", "high"
    ]));

    expect(buildPixverseCreateArgs({
      id: "voice",
      operation: "voice",
      prompt: "こんにちは",
      model: "speech-2.8-hd",
      params: { voice_id: "preset-1" }
    }, "run")).toEqual(expect.arrayContaining([
      "create", "voice", "--text", "こんにちは", "--voice-id", "preset-1"
    ]));

    expect(buildPixverseCreateArgs({
      id: "template",
      operation: "template",
      prompt: "soft motion",
      output_kind: "image",
      params: { template_id: "tpl-1" }
    }, "run")).toEqual(expect.arrayContaining([
      "create", "template", "--template-id", "tpl-1"
    ]));
  });

  it("does not send unsupported generic fields to specialized commands", () => {
    const args = buildPixverseCreateArgs({
      id: "upscale",
      operation: "upscale",
      prompt: "must not be forwarded",
      model: "must-not-be-forwarded",
      duration: 5,
      aspect: "16:9",
      input_video: "/run/source.mp4",
      params: { quality: "1080p" }
    }, "run");
    expect(args).toEqual(expect.arrayContaining(["create", "upscale", "--video", "/run/source.mp4", "--quality", "1080p"]));
    expect(args).not.toContain("--prompt");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--duration");
    expect(args).not.toContain("--aspect-ratio");
  });

  it("keeps PixVerse music on provider auto-duration", () => {
    const args = buildPixverseCreateArgs({
      id: "music-bed",
      operation: "music",
      prompt: "instrumental wooden electronic promo bed",
      model: "music-2.6",
      duration: 30,
      params: { instrumental: true }
    }, "run");

    expect(args).toEqual(expect.arrayContaining([
      "create", "music", "--model", "music-2.6", "--instrumental"
    ]));
    expect(args).not.toContain("--duration-seconds");
    expect(args).not.toContain("--duration");
  });

  it("forwards explicit music duration_seconds without using project duration", () => {
    const args = buildPixverseCreateArgs({
      id: "music-bed",
      operation: "music",
      prompt: "instrumental wooden electronic promo bed",
      model: "music-3.0",
      duration: 30,
      params: { instrumental: true, duration_seconds: 45 }
    }, "run");

    expect(args).toEqual(expect.arrayContaining(["--duration-seconds", "45"]));
    expect(args.filter((value) => value === "30")).toHaveLength(0);
  });

  it("maps Seedance 2.5 reference task type and auto duration", () => {
    const args = buildPixverseCreateArgs({
      id: "seedance-ref",
      operation: "reference",
      prompt: "continue the scene",
      model: "seedance-2.5",
      duration: "auto",
      aspect: "auto",
      input_videos: ["/run/source.mp4"],
      params: { task_type: "extend" }
    }, "run");

    expect(args).toEqual(expect.arrayContaining([
      "create", "reference",
      "--model", "seedance-2.5",
      "--duration", "auto",
      "--aspect-ratio", "auto",
      "--task-type", "extend",
      "--videos", "/run/source.mp4"
    ]));
  });

  it("validates a Seedance 2.5 auto-duration reference project through the pipeline", async () => {
    const project = await loadProject("fixtures/projects/pixverse-seedance-reference-auto.yaml");
    const constraints = await validateGenerationConstraints(project, ["adapters"]);
    expect(constraints.ok).toBe(true);
    expect(project.generation?.requests[0]).toMatchObject({
      operation: "reference",
      duration: "auto",
      aspect: "auto",
      params: { task_type: "extend" }
    });
    const request = project.generation?.requests[0];
    expect(request).toBeDefined();
    expect(buildPixverseCreateArgs(request, "demo-run")).toEqual(expect.arrayContaining([
      "create", "reference",
      "--duration", "auto",
      "--aspect-ratio", "auto",
      "--task-type", "extend"
    ]));
  });

  it("rejects duration auto on non-reference operations", () => {
    const parsed = projectSchema.safeParse({
      slug: "auto-video",
      name: "auto-video",
      run_id: "auto-video-run",
      manifest: "fixtures/manifests/minimal.valid.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "pixverse",
        connection: "pixverse",
        requests: [{
          id: "video-001",
          operation: "video",
          prompt: "a lantern over water",
          model: "v6",
          duration: "auto",
          aspect: "16:9"
        }]
      }
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."))).toContain(
      "generation.requests.0.duration"
    );
  });

  it("omits aspect-ratio for image-to-video because framing comes from the image", () => {
    const args = buildPixverseCreateArgs({
      id: "i2v-shot",
      prompt: "lanterns rise from the river",
      model: "v6",
      duration: 5,
      aspect: "16:9",
      input_mode: "image-to-video",
      params: { image: "references/shot.png" }
    }, "demo-run");

    expect(args).toContain("--image");
    expect(args).not.toContain("--aspect-ratio");
  });

  it("includes first_frame in image lists for list-based operations", () => {
    const args = buildPixverseCreateArgs({
      id: "transition-shot",
      operation: "transition",
      prompt: "move between frames",
      model: "v6",
      first_frame: "/run/first.png",
      input_images: ["/run/last.png"],
      params: {}
    }, "demo-run");

    const imagesIndex = args.indexOf("--images");
    expect(imagesIndex).toBeGreaterThan(-1);
    expect(args.slice(imagesIndex + 1, imagesIndex + 3)).toEqual([
      "/run/first.png",
      "/run/last.png"
    ]);
  });

  it("keeps both first_frame and legacy params.image in list-based operations", () => {
    const args = buildPixverseCreateArgs({
      id: "legacy-transition",
      operation: "transition",
      prompt: "move between frames",
      model: "v6",
      first_frame: "/run/first.png",
      params: { image: "/run/last.png" }
    }, "demo-run");

    const imagesIndex = args.indexOf("--images");
    expect(args.slice(imagesIndex + 1, imagesIndex + 3)).toEqual([
      "/run/first.png",
      "/run/last.png"
    ]);
  });

  it("deduplicates the same image across modern and legacy fields", () => {
    const args = buildPixverseCreateArgs({
      id: "deduplicated-transition",
      operation: "transition",
      prompt: "hold the frame",
      model: "v6",
      first_frame: "/run/frame.png",
      input_images: ["/run/frame.png"],
      params: { image: "/run/frame.png" }
    }, "demo-run");

    expect(args.filter((value) => value === "/run/frame.png")).toHaveLength(1);
  });

  it("does not repeat a primary image in single-image and image-list flags", () => {
    const args = buildPixverseCreateArgs({
      id: "deduplicated-image",
      operation: "image",
      prompt: "refine the frame",
      model: "gemini-3.1-flash-image",
      first_frame: "/run/frame.png",
      input_images: ["/run/frame.png"],
      params: {}
    }, "demo-run");

    expect(args).toEqual(expect.arrayContaining(["--image", "/run/frame.png"]));
    expect(args).not.toContain("--images");
    expect(args.filter((value) => value === "/run/frame.png")).toHaveLength(1);
  });

  it("keeps aspect-ratio for text-to-video", () => {
    const args = buildPixverseCreateArgs({
      id: "t2v-shot",
      prompt: "lanterns rise from the river",
      model: "v6",
      duration: 5,
      aspect: "9:16",
      input_mode: "text-to-video",
      params: {}
    }, "demo-run");

    expect(args).toEqual(expect.arrayContaining(["--aspect-ratio", "9:16"]));
  });

  it("maps the catalog C1 id to the model name accepted by PixVerse CLI", () => {
    const args = buildPixverseCreateArgs({
      id: "c1-shot",
      prompt: "a connected creative workflow",
      model: "c1",
      duration: 10,
      aspect: "9:16",
      input_mode: "text-to-video",
      params: {}
    }, "demo-run");

    expect(args).toEqual(expect.arrayContaining(["--model", "pixverse-c1"]));
  });

  it("normalizes a numeric video_id and prefers it over trace_id", () => {
    expect(findTaskId({ video_id: 413102731506491, trace_id: "trace-should-not-be-used" })).toBe("413102731506491");
  });

  it("accepts a string task id without treating trace_id as a fallback", () => {
    expect(findTaskId({ task_id: "task-123", trace_id: "trace-456" })).toBe("task-123");
    expect(findTaskId({ trace_id: "trace-456" })).toBeUndefined();
  });

  it("reads cost credits only from the declared credit keys", () => {
    expect(findNumberByKeys({ cost_credits: 125, video_id: 413102731506491 }, ["cost_credits"])).toBe(125);
    expect(findNumberByKeys({ video_id: 413102731506491 }, ["cost_credits"])).toBeUndefined();
  });
});

describe("H3 IR compile → PixVerse create args", () => {
  it("maps T2V IR through compileH3Request into a pure create video argv", async () => {
    const ir = await loadH3Fixture("t2v.json");
    const compiled = compileH3Request(h3Request("h3-t2v", ir));
    expect(compiled.ok).toBe(true);

    const execution = compiled.compilation.execution_request;
    expect(execution).not.toHaveProperty("h3");
    expect(execution.prompt).toBe(compiled.compilation.canonical_prompt);
    expect(execution.prompt).toBe(compiled.compilation.adapter_prompt);
    expect(execution.prompt).toContain("<d>[Japanese]AIと自然が、やっと同じ場所で動き始めた。</d>");

    const args = buildPixverseCreateArgs(execution, "demo-run");
    expect(args.slice(0, 2)).toEqual(["create", "video"]);
    expect(flagValue(args, "--model")).toBe("minimax-h3");
    expect(flagValue(args, "--duration")).toBe("10");
    expect(flagValue(args, "--aspect-ratio")).toBe("16:9");
    expect(flagValue(args, "--quality")).toBe("1440p");
    expect(args).toContain("--audio");
    expect(flagValue(args, "--prompt")).toBe(execution.prompt);
    expect(flagValue(args, "--idempotency-key")).toBe("tsugite-demo-run-h3-t2v");
    expect(args).toEqual(expect.arrayContaining(["--no-wait", "--json"]));
    expect(args).not.toContain("--image");
    expect(args).not.toContain("--images");
    expect(args).not.toContain("--videos");
    expect(args).not.toContain("--audios");
    assertNoRawH3Leak(args, ir);
  });

  it("maps first-frame IR to image-to-video without aspect-ratio", async () => {
    const ir = await loadH3Fixture("first-frame.json");
    const compiled = compileH3Request(h3Request("h3-ff", ir));
    expect(compiled.ok).toBe(true);

    const execution = compiled.compilation.execution_request;
    expect(execution).toMatchObject({
      operation: "video",
      input_mode: "image-to-video",
      first_frame: "assets/start.png",
      model: "minimax-h3",
      duration: 5,
      aspect: "16:9",
      params: expect.objectContaining({ quality: "768p", audio: true })
    });
    expect(execution.prompt).toBe(compiled.compilation.canonical_prompt);
    expect(execution.prompt).toBe(compiled.compilation.adapter_prompt);

    const args = buildPixverseCreateArgs(execution, "demo-run");
    expect(args.slice(0, 2)).toEqual(["create", "video"]);
    expect(flagValue(args, "--model")).toBe("minimax-h3");
    expect(flagValue(args, "--duration")).toBe("5");
    expect(flagValue(args, "--quality")).toBe("768p");
    expect(args).toContain("--audio");
    expect(flagValue(args, "--image")).toBe("assets/start.png");
    expect(args).not.toContain("--aspect-ratio");
    expect(args).not.toContain("--images");
    expect(flagValue(args, "--prompt")).toBe(execution.prompt);
    expect(flagValue(args, "--idempotency-key")).toBe("tsugite-demo-run-h3-ff");
    expect(args).toEqual(expect.arrayContaining(["--no-wait", "--json"]));
    assertNoRawH3Leak(args, ir);
  });

  it("maps first-last IR to transition with first then last image order", async () => {
    const ir = await loadH3Fixture("first-last.json");
    const compiled = compileH3Request(h3Request("h3-fl", ir));
    expect(compiled.ok).toBe(true);
    // Stage 1 is provider-neutral; PixVerse packs first/last via route binding.
    expect(compiled.compilation.execution_request).toMatchObject({
      operation: "video",
      input_mode: "first-last-frame-to-video",
      first_frame: "assets/start.png",
      last_frame: "assets/end.png"
    });

    const adapter = await loadAdapterDefinition("pixverse", ["adapters"]);
    const profile = await loadH3ExecutionRouteProfile(adapter.root);
    const project = projectSchema.parse({
      slug: "h3-fl-pixverse",
      name: "h3-fl-pixverse",
      manifest: "manifest.json",
      edit: { backend: "fixture" },
      generation: {
        adapter: "pixverse",
        requests: [h3Request("h3-fl", ir)]
      }
    });
    const bound = applyH3ExecutionRouteProfile([compiled.compilation], profile, {
      project,
      adapterName: "pixverse"
    });
    expect(bound.ok).toBe(true);

    const execution = bound.compilations[0].execution_request;
    expect(execution).toMatchObject({
      operation: "transition",
      input_mode: "transition",
      input_images: ["assets/start.png", "assets/end.png"],
      model: "minimax-h3",
      duration: 5,
      aspect: "9:16",
      params: expect.objectContaining({ quality: "1440p", audio: true })
    });
    expect(execution).not.toHaveProperty("first_frame");
    expect(execution.prompt).toBe(compiled.compilation.canonical_prompt);

    const args = buildPixverseCreateArgs(execution, "demo-run");
    expect(args.slice(0, 2)).toEqual(["create", "transition"]);
    expect(flagValue(args, "--model")).toBe("minimax-h3");
    expect(flagValue(args, "--duration")).toBe("5");
    expect(flagValue(args, "--quality")).toBe("1440p");
    expect(args).toContain("--audio");
    expect(flagValues(args, "--images")).toEqual(["assets/start.png", "assets/end.png"]);
    expect(args).not.toContain("--image");
    expect(args).not.toContain("--aspect-ratio");
    expect(flagValue(args, "--prompt")).toBe(execution.prompt);
    expect(flagValue(args, "--idempotency-key")).toBe("tsugite-demo-run-h3-fl");
    expect(args).toEqual(expect.arrayContaining(["--no-wait", "--json"]));
    assertNoRawH3Leak(args, ir);
  });

  it("maps reference IR to type-partitioned images/videos/audios argv", async () => {
    const ir = await loadH3Fixture("reference.json");
    const compiled = compileH3Request(h3Request("h3-ref", ir));
    expect(compiled.ok).toBe(true);

    const execution = compiled.compilation.execution_request;
    expect(execution).toMatchObject({
      operation: "reference",
      input_mode: "reference",
      input_images: ["assets/hero.png"],
      input_videos: ["assets/lakeside-motion.mp4"],
      input_audios: ["assets/voice.wav"],
      model: "minimax-h3",
      duration: 10,
      aspect: "16:9",
      params: expect.objectContaining({ quality: "1440p", audio: true })
    });
    expect(execution.prompt).toBe(compiled.compilation.canonical_prompt);
    expect(execution.prompt).toBe(compiled.compilation.adapter_prompt);
    expect(execution.prompt).toContain("<d>[Japanese]AIと自然が、やっと同じ場所で動き始めた。</d>");

    const args = buildPixverseCreateArgs(execution, "demo-run");
    expect(args.slice(0, 2)).toEqual(["create", "reference"]);
    expect(flagValue(args, "--model")).toBe("minimax-h3");
    expect(flagValue(args, "--duration")).toBe("10");
    expect(flagValue(args, "--aspect-ratio")).toBe("16:9");
    expect(flagValue(args, "--quality")).toBe("1440p");
    expect(args).toContain("--audio");
    expect(flagValues(args, "--images")).toEqual(["assets/hero.png"]);
    expect(flagValues(args, "--videos")).toEqual(["assets/lakeside-motion.mp4"]);
    expect(flagValues(args, "--audios")).toEqual(["assets/voice.wav"]);
    expect(flagValue(args, "--prompt")).toBe(execution.prompt);
    expect(flagValue(args, "--idempotency-key")).toBe("tsugite-demo-run-h3-ref");
    expect(args).toEqual(expect.arrayContaining(["--no-wait", "--json"]));
    assertNoRawH3Leak(args, ir);
  });

  it("keeps Japanese dialogue and on-screen text byte-stable through compile and argv prompt", async () => {
    const base = await loadH3Fixture("voiceover.json");
    const dialogueText = "  あの日から、すべてが変わった。  \n二行目  ";
    const onScreen = "  字幕DAY 01  \n続き  ";
    const ir = parseH3CreativeIr({
      ...base,
      shots: [
        {
          ...base.shots[0],
          dialogue: {
            ...base.shots[0].dialogue,
            text: dialogueText,
            lock_text: true
          },
          on_screen_text: onScreen
        }
      ]
    });

    const compiled = compileH3Request(h3Request("h3-voiceover", ir));
    expect(compiled.ok).toBe(true);
    const execution = compiled.compilation.execution_request;
    expect(execution.prompt).toBe(compiled.compilation.canonical_prompt);
    expect(execution.prompt).toContain(`<d>[Japanese]${dialogueText}</d>`);
    expect(execution.prompt).toContain(`On-screen text: ${onScreen}`);
    expect(execution.prompt).toContain(dialogueText);
    expect(execution.prompt).toContain(onScreen);

    const args = buildPixverseCreateArgs(execution, "demo-run");
    const promptArg = flagValue(args, "--prompt");
    expect(promptArg).toBe(execution.prompt);
    expect(promptArg).toContain(`<d>[Japanese]${dialogueText}</d>`);
    expect(promptArg).toContain(`On-screen text: ${onScreen}`);
    expect(promptArg).toContain(dialogueText);
    expect(promptArg).toContain(onScreen);
    expect(args.slice(0, 2)).toEqual(["create", "video"]);
    expect(flagValue(args, "--model")).toBe("minimax-h3");
    expect(flagValue(args, "--idempotency-key")).toBe("tsugite-demo-run-h3-voiceover");
    expect(args).toEqual(expect.arrayContaining(["--no-wait", "--json"]));
    assertNoRawH3Leak(args, ir);
  });

  it("does not leak raw h3 when a project-shaped request still carries h3 alongside execution fields", async () => {
    const ir = await loadH3Fixture("t2v.json");
    const compiled = compileH3Request(h3Request("h3-leak", ir));
    expect(compiled.ok).toBe(true);

    // Project digests may keep h3 on the request; argv must still stay adapter-safe.
    const dirty = {
      ...compiled.compilation.execution_request,
      h3: ir,
      creative_ir: ir
    };
    const args = buildPixverseCreateArgs(dirty, "demo-run");
    expect(flagValue(args, "--prompt")).toBe(compiled.compilation.adapter_prompt);
    expect(args).toEqual(expect.arrayContaining(["create", "video", "--no-wait", "--json"]));
    assertNoRawH3Leak(args, ir);
  });
});
