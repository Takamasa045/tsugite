import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadTopviewCredentials,
  prepareTopviewRequest,
  runTopviewMcpMedia,
  selectTopviewModel
} from "../adapters/topview/topviewMcp.mjs";

function generationConfig(models) {
  return { result: { models } };
}

describe("TopView MCP adapter", () => {
  it("uses runtime model config and normalizes an image result", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-topview-mcp-"));
    const calls = [];
    const client = {
      async call(name, args) {
        calls.push({ name, args });
        if (name === "topview_get_generation_config") {
          return generationConfig([{
            submitModel: "GPT Image 2",
            displayName: "GPT Image 2",
            preferred: true,
            defaultSubmitParameters: { aspectRatio: "1:1", resolution: "2K" }
          }]);
        }
        if (name === "topview_generate_image") return { result: { taskId: "task-image-1" } };
        if (name === "topview_query_task") {
          return {
            result: {
              status: "success",
              costCredit: 2,
              images: [{ filePath: "https://cdn.example.com/generated/result.png" }]
            }
          };
        }
        throw new Error(`unexpected tool ${name}`);
      }
    };

    const result = await runTopviewMcpMedia({
      run_id: "run-1",
      run_dir: runDir,
      request: {
        id: "image-1",
        operation: "image",
        prompt: "misty mountain lodge",
        model: "gpt-image-2"
      }
    }, {
      client,
      sleep: vi.fn(),
      download: vi.fn(async (_url, target) => writeFile(target, "image"))
    });

    expect(calls[0]).toEqual({
      name: "topview_get_generation_config",
      args: { req: { type: "image", taskType: "text_to_image" } }
    });
    expect(calls[1]).toMatchObject({
      name: "topview_generate_image",
      args: { req: { taskType: "text_to_image", model: "GPT Image 2", prompt: "misty mountain lodge" } }
    });
    expect(result).toMatchObject({
      request_id: "image-1",
      credits: 2,
      images: [{ id: "image-1-image-1", src: expect.stringMatching(/generated[\\/]image-1[\\/]001\.png$/) }],
      metadata: {
        adapter: "topview",
        transport: "mcp",
        tool: "topview_generate_image",
        task_type: "text_to_image",
        task_id: "task-image-1"
      }
    });
  });

  it("uploads an image and maps image-to-video fields without sending aspect ratio", async () => {
    const client = {
      call: vi.fn(async (name) => {
        if (name === "topview_get_generation_config") {
          return generationConfig([{
            submitModel: "Kling V3",
            requiredSubmitFields: ["taskType", "model", "prompt", "duration", "cameraControl"],
            defaultSubmitParameters: { aspectRatio: "16:9", duration: 5 },
            submitParameterOptions: { cameraControl: ["static", "push-in"] }
          }]);
        }
        throw new Error(`unexpected tool ${name}`);
      })
    };
    const upload = vi.fn(async () => "file-first-frame");

    const prepared = await prepareTopviewRequest(client, {
      id: "video-1",
      operation: "video",
      prompt: "camera pushes in",
      first_frame: "/safe/project/frame.png",
      aspect: "9:16",
      duration: 8,
      params: { camera_control: "push-in" }
    }, { upload });

    expect(upload).toHaveBeenCalledWith("/safe/project/frame.png");
    expect(prepared).toMatchObject({
      tool: "topview_generate_video",
      taskType: "image_to_video",
      outputKind: "video",
      args: {
        model: "Kling V3",
        taskType: "image_to_video",
        prompt: "camera pushes in",
        firstFrameFileId: "file-first-frame",
        duration: 8,
        cameraControl: "push-in"
      }
    });
    expect(prepared.args).not.toHaveProperty("aspectRatio");

    await expect(prepareTopviewRequest(client, {
      id: "video-2",
      operation: "video",
      prompt: "camera pushes in",
      first_frame: "/safe/project/frame.png",
      duration: 8,
      params: { camera_control: "unsupported-value" }
    }, { upload })).rejects.toMatchObject({ exitCode: 40 });
  });

  it("requires an explicit TopView voice id for text-to-speech", async () => {
    await expect(prepareTopviewRequest({ call: vi.fn() }, {
      id: "voice-1",
      operation: "voice",
      prompt: "こんにちは"
    })).rejects.toMatchObject({ exitCode: 40 });

    await expect(prepareTopviewRequest({ call: vi.fn() }, {
      id: "voice-1",
      operation: "voice",
      prompt: "こんにちは",
      params: { voice_id: "voice-jp-1", speed: 1.05 }
    })).resolves.toMatchObject({
      tool: "topview_generate_voice",
      taskType: "text_to_speech",
      args: { voiceId: "voice-jp-1", voiceText: "こんにちは", voiceSpeed: 1.05 }
    });
  });

  it("uses TopView instant voice generation when a reference audio file is supplied", async () => {
    const client = {
      call: vi.fn(async (name) => {
        if (name === "topview_get_generation_config") {
          return generationConfig([{
            submitModel: "Seed Audio 1.0",
            requiredSubmitFields: ["taskType", "model"]
          }]);
        }
        throw new Error(`unexpected tool ${name}`);
      })
    };
    const upload = vi.fn(async () => "reference-audio-file");

    await expect(prepareTopviewRequest(client, {
      id: "voice-clone-1",
      operation: "voice",
      prompt: "参照音声の話者で読み上げる",
      input_audios: ["/safe/project/reference.wav"]
    }, { upload })).resolves.toMatchObject({
      tool: "topview_generate_audio",
      taskType: "instant_voice_clone",
      outputKind: "audio",
      args: {
        model: "Seed Audio 1.0",
        text: "参照音声の話者で読み上げる",
        referenceAudioFileId: "reference-audio-file"
      }
    });
    expect(upload).toHaveBeenCalledWith("/safe/project/reference.wav");
  });

  it("routes explicit TopView templates without guessing from the input file", async () => {
    const upload = vi.fn()
      .mockResolvedValueOnce("product-image")
      .mockResolvedValueOnce("template-image");

    await expect(prepareTopviewRequest({ call: vi.fn() }, {
      id: "product-avatar-1",
      operation: "template",
      output_kind: "image",
      prompt: "商品を自然に持たせる",
      first_frame: "/safe/project/product.png",
      input_images: ["/safe/project/model.png"],
      params: { template_id: "product-avatar", generate_image_mode: "auto" }
    }, { upload })).resolves.toMatchObject({
      tool: "topview_product_avatar",
      taskType: "product_avatar",
      outputKind: "image",
      args: {
        productImageWithoutBackgroundFileId: "product-image",
        templateImageFileId: "template-image",
        generateImageMode: "auto",
        imageEditPrompt: "商品を自然に持たせる"
      }
    });

    const unexpectedUpload = vi.fn(async () => "product-image");
    await expect(prepareTopviewRequest({ call: vi.fn() }, {
      id: "unknown-template",
      operation: "template",
      prompt: "test",
      first_frame: "/safe/project/product.png",
      params: { template_id: "unknown" }
    }, { upload: unexpectedUpload })).rejects.toMatchObject({ exitCode: 40 });
    expect(unexpectedUpload).not.toHaveBeenCalled();
  });

  it("maps storyboard and motion-control to the runtime MCP task types", async () => {
    const client = {
      call: vi.fn(async (name, args) => {
        if (name !== "topview_get_generation_config") throw new Error(`unexpected tool ${name}`);
        if (args.req.taskType === "storyboard") {
          return generationConfig([{
            submitModel: "Storyboard Model",
            requiredSubmitFields: ["taskType", "model", "story", "resolution"],
            defaultSubmitParameters: { resolution: "1K" }
          }]);
        }
        return generationConfig([{
          submitModel: "Motion Model",
          requiredSubmitFields: ["taskType", "model", "prompt"]
        }]);
      })
    };

    await expect(prepareTopviewRequest(client, {
      id: "story-1",
      operation: "image",
      prompt: "山荘に到着する三場面",
      params: { task_type: "storyboard" }
    })).resolves.toMatchObject({
      tool: "topview_generate_image",
      taskType: "storyboard",
      args: { story: "山荘に到着する三場面", resolution: "1K" }
    });

    const upload = vi.fn()
      .mockResolvedValueOnce("character-image")
      .mockResolvedValueOnce("motion-video");
    await expect(prepareTopviewRequest(client, {
      id: "motion-1",
      operation: "motion-control",
      prompt: "参照動画の動きを反映する",
      first_frame: "/safe/project/character.png",
      input_video: "/safe/project/motion.mp4"
    }, { upload })).resolves.toMatchObject({
      tool: "topview_generate_video",
      taskType: "motion_control",
      args: {
        inputImages: [{ fileId: "character-image", name: "Image1" }],
        inputVideos: [{ fileId: "motion-video", name: "Video1" }]
      }
    });
  });

  it("accepts only a private local credential file and never returns extra fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-topview-auth-"));
    const credentialsPath = join(root, "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({
      uid: "user-1",
      api_key: "secret-key",
      balance: 999
    }), { mode: 0o600 });

    await expect(loadTopviewCredentials({ credentialsPath, environment: {}, platform: "win32" })).resolves.toEqual({
      uid: "user-1",
      apiKey: "secret-key"
    });
    await chmod(credentialsPath, 0o644);
    await expect(loadTopviewCredentials({ credentialsPath, environment: {}, platform: "linux" }))
      .rejects.toMatchObject({ exitCode: 40 });
  });

  it("rejects a requested model that is absent from the runtime config", () => {
    expect(() => selectTopviewModel({ models: [{ submitModel: "Seedance 2.0" }] }, "Kling V3"))
      .toThrow(/is not available/);
  });

  it("rejects unsafe request ids and input files outside the pinned run directory", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-topview-contained-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "tsugite-topview-outside-"));
    const outsideImage = join(outsideDir, "outside.png");
    await writeFile(outsideImage, "not-uploaded");
    const client = { call: vi.fn() };

    await expect(runTopviewMcpMedia({
      run_id: "run-1",
      run_dir: runDir,
      request: { id: "../escape", operation: "image", prompt: "test" }
    }, { client })).rejects.toMatchObject({ exitCode: 40 });

    await expect(runTopviewMcpMedia({
      run_id: "run-1",
      run_dir: runDir,
      request: {
        id: "safe-id",
        operation: "video",
        prompt: "test",
        first_frame: outsideImage
      }
    }, { client })).rejects.toMatchObject({ exitCode: 40 });
    expect(client.call).not.toHaveBeenCalled();
  });
});
