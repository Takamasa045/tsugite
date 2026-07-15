import { describe, expect, it } from "vitest";
import { buildTopviewVideoArgs } from "../adapters/topview/topviewCli.mjs";

describe("Topview CLI request mapping", () => {
  it("maps mode image-to-video and first_frame to i2v CLI arguments", () => {
    const args = buildTopviewVideoArgs({
      id: "opening-shot",
      mode: "image-to-video",
      first_frame: "/safe/run/assets/generation-inputs/opening.png",
      prompt: "turn slowly",
      model: "Standard",
      duration: 5,
      aspect: "9:16",
      params: { resolution: 720, sound: true }
    }, "/safe/run/generated/opening-shot");

    expect(args).toEqual(expect.arrayContaining([
      "run",
      "--type", "i2v",
      "--first-frame", "/safe/run/assets/generation-inputs/opening.png",
      "--model", "Standard",
      "--duration", "5",
      "--output-dir", "/safe/run/generated/opening-shot",
      "--sound", "on",
      "--json"
    ]));
  });

  it("keeps text-to-video support and rejects image mode without first_frame", () => {
    const t2v = buildTopviewVideoArgs({
      id: "text-shot",
      mode: "text-to-video",
      prompt: "lanterns rise",
      model: "Standard",
      duration: 5,
      aspect: "16:9",
      params: {}
    }, "/safe/run/generated/text-shot");

    expect(t2v).toEqual(expect.arrayContaining(["--type", "t2v", "--aspect-ratio", "16:9"]));
    expect(() => buildTopviewVideoArgs({
      id: "missing-image",
      mode: "image-to-video",
      prompt: "move",
      model: "Standard",
      duration: 5,
      aspect: "9:16",
      params: {}
    }, "/safe/run/generated/missing-image")).toThrow(/first_frame/);
  });
});
