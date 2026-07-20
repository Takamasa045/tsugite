import { describe, expect, it } from "vitest";
import { buildKlingCreateArgs, klingOperationContract } from "../adapters/kling/klingCli.mjs";

describe("Kling CLI request mapping", () => {
  it("supports every generation tool exposed by Kling CLI 0.1.1", () => {
    expect(klingOperationContract).toEqual({
      "text-to-image": "text_to_image",
      "image-to-image": "image_to_image",
      "text-to-video": "text_to_video",
      "image-to-video": "image_to_video"
    });
  });

  it("passes runtime model names and server-declared parameters through as argv", () => {
    expect(buildKlingCreateArgs({
      id: "direct-kling",
      operation: "video",
      prompt: "a quiet mountain house",
      model: "kling-video-v3-omni",
      duration: 10,
      aspect: "16:9",
      params: { mode: "pro", sound: true }
    })).toEqual(expect.arrayContaining([
      "text_to_video", "--model", "kling-video-v3-omni", "--duration", "10",
      "--aspectRatio", "16:9", "--mode", "pro", "--sound", "true"
    ]));
  });

  it("selects image-to-image and image-to-video from pinned inputs", () => {
    expect(buildKlingCreateArgs({
      id: "image-edit",
      operation: "image",
      prompt: "make it dusk",
      model: "kling-image-o1",
      input_images: ["/run/input.png"],
      params: {}
    })[0]).toBe("image_to_image");
    expect(buildKlingCreateArgs({
      id: "image-video",
      operation: "video",
      prompt: "camera pushes in",
      model: "kling-video-v2_5",
      first_frame: "/run/first.png",
      params: {}
    })[0]).toBe("image_to_video");
  });
});
