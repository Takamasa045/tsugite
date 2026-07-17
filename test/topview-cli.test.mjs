import { describe, expect, it } from "vitest";
import {
  buildTopviewVideoArgs,
  defaultTopviewPython
} from "../adapters/topview/topviewCli.mjs";

describe("Topview CLI request mapping", () => {
  it("uses the native Python command name for each platform", () => {
    expect(defaultTopviewPython("win32")).toBe("python");
    expect(defaultTopviewPython("linux")).toBe("python3");
    expect(defaultTopviewPython("darwin")).toBe("python3");
  });

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

  it("can keep the internal aspect while omitting the unsupported provider argument", () => {
    const args = buildTopviewVideoArgs({
      id: "seedance-image",
      mode: "image-to-video",
      first_frame: "/safe/run/assets/generation-inputs/seedance.png",
      prompt: "run through the forest",
      model: "Seedance 1.5 Pro",
      duration: 10,
      aspect: "16:9",
      params: {
        resolution: 1080,
        sound: true,
        omit_aspect_ratio: true
      }
    }, "/safe/run/generated/seedance-image");

    expect(args).not.toContain("--aspect-ratio");
    expect(args).toEqual(expect.arrayContaining([
      "--type", "i2v",
      "--model", "Seedance 1.5 Pro",
      "--resolution", "1080"
    ]));
  });

  it("keeps the storyboard separate from material references for TopView Omni", () => {
    const args = buildTopviewVideoArgs({
      id: "act-1",
      mode: "image-to-video",
      first_frame: "/safe/run/assets/generation-inputs/act-1/001-first-frame.png",
      reference_images: [
        "/safe/run/assets/generation-inputs/act-1/002-reference.png",
        "/safe/run/assets/generation-inputs/act-1/003-reference.png"
      ],
      prompt: "four-shot historical action sequence",
      model: "Standard",
      duration: 15,
      aspect: "16:9",
      params: {
        omni_reference: true,
        reference_image_descriptions: ["Gashadokuro and shrine lock", "ronin character lock"],
        resolution: 720,
        sound: true
      }
    }, "/safe/run/generated/act-1");

    expect(args).toEqual(expect.arrayContaining([
      "run",
      "--type", "omni",
      "--storyboard-image", "/safe/run/assets/generation-inputs/act-1/001-first-frame.png",
      "--input-images",
      "/safe/run/assets/generation-inputs/act-1/002-reference.png",
      "/safe/run/assets/generation-inputs/act-1/003-reference.png",
      "--reference-image-descriptions",
      "Gashadokuro and shrine lock",
      "ronin character lock",
      "--model", "Standard",
      "--resolution", "720"
    ]));
    expect(args).not.toContain("--first-frame");
    expect(args).not.toContain("--sound");
  });

  it("rejects TopView Omni without material reference images", () => {
    expect(() => buildTopviewVideoArgs({
      id: "missing-materials",
      mode: "image-to-video",
      first_frame: "/safe/run/assets/generation-inputs/storyboard.png",
      prompt: "move",
      model: "Standard",
      duration: 15,
      aspect: "16:9",
      params: { omni_reference: true }
    }, "/safe/run/generated/missing-materials")).toThrow(/reference_images/);
  });
});
