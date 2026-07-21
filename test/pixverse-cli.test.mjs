import { describe, expect, it } from "vitest";
import {
  buildPixverseCreateArgs,
  findNumberByKeys,
  findTaskId,
  pixverseOperationContract
} from "../adapters/pixverse/pixverseCli.mjs";

describe("PixVerse CLI request mapping", () => {
  it("covers every create operation exposed by PixVerse CLI 1.2.6", () => {
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
