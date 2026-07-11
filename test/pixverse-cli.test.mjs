import { describe, expect, it } from "vitest";
import { buildPixverseCreateArgs } from "../adapters/pixverse/pixverseCli.mjs";

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
});
