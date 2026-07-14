import { describe, expect, it } from "vitest";
import { buildPixverseCreateArgs, findNumberByKeys, findTaskId } from "../adapters/pixverse/pixverseCli.mjs";

describe("PixVerse CLI request mapping", () => {
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
