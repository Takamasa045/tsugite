import { Client } from "@modelcontextprotocol/sdk/client";
// The workspace directory intentionally contains a literal `*`. Node's package-export
// wildcard resolution replaces that character, so load the official SSE transport by
// its stable package-relative file until Node fixes wildcard exports for such paths.
import { SSEClientTransport } from "../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/sse.js";
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const TRANSIENT = 20;
const RATE_LIMITED = 21;
const INVALID_REQUEST = 40;
const TOPVIEW_MCP_URL = "https://mcp.topview.ai/sse";
const MAX_MEDIA_BYTES = 1024 * 1024 * 500;
const MAX_OUTPUT_FILES = 20;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const toolContract = Object.freeze({
  image: "topview_generate_image",
  video: "topview_generate_video",
  reference: "topview_generate_video",
  "motion-control": "topview_generate_video",
  music: "topview_generate_music",
  voice: "topview_generate_voice",
  instantVoice: "topview_generate_audio",
  template: "topview_template_router"
});

export async function connectTopviewMcp(options = {}) {
  const credentials = options.credentials ?? await loadTopviewCredentials(options);
  const client = new Client(
    { name: "tsugite-topview-mcp", version: "0.5.0" },
    { capabilities: {} }
  );
  const transport = new SSEClientTransport(new URL(TOPVIEW_MCP_URL), {
    requestInit: {
      headers: {
        "Topview-Uid": credentials.uid,
        Authorization: `Bearer ${credentials.apiKey}`
      }
    }
  });
  await client.connect(transport, { timeout: 20_000 });
  return {
    async listTools() {
      const response = await client.listTools(undefined, { timeout: 20_000 });
      return response.tools.map((tool) => tool.name);
    },
    async describeTools() {
      const response = await client.listTools(undefined, { timeout: 20_000 });
      return response.tools;
    },
    async call(name, args) {
      const response = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: 45_000 }
      );
      return parseMcpToolResponse(response, name);
    },
    async close() {
      await client.close();
    }
  };
}

export async function loadTopviewCredentials(options = {}) {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const envUid = environment.TOPVIEW_UID?.trim();
  const envKey = environment.TOPVIEW_API_KEY?.trim();
  if (envUid || envKey) {
    if (!envUid || !envKey) throw new AdapterError("TopView credentials are incomplete", INVALID_REQUEST);
    return { uid: envUid, apiKey: envKey };
  }

  const credentialsPath = options.credentialsPath ?? join(homedir(), ".topview", "credentials.json");
  let fileStat;
  try {
    fileStat = await stat(credentialsPath);
  } catch {
    throw new AdapterError("TopView sign-in is required", INVALID_REQUEST);
  }
  if (!fileStat.isFile() || (platform !== "win32" && (fileStat.mode & 0o077) !== 0)) {
    throw new AdapterError("TopView credentials must be a private file", INVALID_REQUEST);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(credentialsPath, "utf8"));
  } catch {
    throw new AdapterError("TopView credentials could not be read", INVALID_REQUEST);
  }
  if (!nonEmptyString(parsed?.uid) || !nonEmptyString(parsed?.api_key)) {
    throw new AdapterError("TopView sign-in is required", INVALID_REQUEST);
  }
  return { uid: parsed.uid, apiKey: parsed.api_key };
}

export async function runTopviewMcpMedia(input, options = {}) {
  const payload = parsePayload(input);
  const request = payload.request;
  const client = options.client ?? await connectTopviewMcp(options);
  const ownsClient = !options.client;
  try {
    const prepared = await prepareTopviewRequest(client, request, {
      ...options,
      allowedRoot: resolve(payload.run_dir)
    });
    const submitted = await client.call(prepared.tool, { req: prepared.args });
    const taskId = findStringByKeys(submitted, ["taskId", "task_id"]);
    if (!taskId) throw new AdapterError("TopView MCP did not return a task id", TRANSIENT);
    const completed = await pollTopviewTask(client, {
      taskId,
      taskType: prepared.taskType,
      timeoutSeconds: timeoutSeconds(request, prepared.outputKind),
      intervalSeconds: intervalSeconds(request),
      sleep: options.sleep
    });
    const urls = findMediaUrls(completed, prepared.outputKind);
    if (urls.length === 0) throw new AdapterError("TopView MCP completed without downloadable media", TRANSIENT);
    if (urls.length > MAX_OUTPUT_FILES) throw new AdapterError("TopView MCP returned too many media files", INVALID_REQUEST);

    const outputDir = resolve(payload.run_dir, "generated", request.id);
    await mkdir(outputDir, { recursive: true });
    await assertContainedDirectory(resolve(payload.run_dir), outputDir);
    const paths = [];
    for (const [index, url] of urls.entries()) {
      const target = join(outputDir, `${String(index + 1).padStart(3, "0")}${safeExtension(url, prepared.outputKind)}`);
      if (options.download) await options.download(url, target);
      else await downloadPublicHttps(url, target, prepared.outputKind);
      paths.push(target);
    }

    const credits = findNumberByKeys(completed, ["costCredit", "credits", "credit", "cost"]) ?? 0;
    const boardTaskId = findStringByKeys(completed, ["boardTaskId", "board_task_id"]);
    return {
      request_id: request.id,
      credits,
      clips: prepared.outputKind === "video"
        ? paths.map((src, index) => videoAsset(request, src, index))
        : [],
      images: prepared.outputKind === "image"
        ? paths.map((src, index) => ({ id: `${request.id}-image-${index + 1}`, src }))
        : [],
      audio: prepared.outputKind === "audio"
        ? paths.map((src, index) => ({
            id: `${request.id}-audio-${index + 1}`,
            src,
            role: request.audio_role ?? (request.operation === "music" ? "music" : "narration"),
            start: Number(request.params?.start) || 0,
            ...(Number.isFinite(request.params?.end) ? { end: Number(request.params.end) } : {}),
            ...(Number.isFinite(request.params?.volume) ? { volume: Number(request.params.volume) } : {})
          }))
        : [],
      metadata: {
        adapter: "topview",
        transport: "mcp",
        tool: prepared.tool,
        task_type: prepared.taskType,
        task_id: taskId,
        ...(boardTaskId ? { board_task_id: boardTaskId } : {})
      }
    };
  } finally {
    if (ownsClient) await client.close();
  }
}

export async function prepareTopviewRequest(client, request, options = {}) {
  const operation = request.operation ?? "video";
  if (!Object.hasOwn(toolContract, operation)) {
    throw new AdapterError(`TopView MCP operation '${operation}' is not automated`, INVALID_REQUEST);
  }
  const outputKind = operation === "image"
    ? "image"
    : ["video", "reference", "motion-control", "template"].includes(operation)
      ? request.output_kind ?? "video"
      : "audio";
  validateRequestMediaUsage(request, operation);
  if (operation === "voice" && !(request.input_audios?.length > 0)) {
    return prepareVoiceRequest(request, outputKind);
  }

  const media = await uploadRequestMedia(client, request, options);
  if (operation === "template") return prepareTopviewTemplateRequest(request, media);
  if (operation === "voice") return prepareInstantVoiceRequest(client, request, media, outputKind);
  const taskType = topviewTaskType(request, media);
  const configResponse = await client.call("topview_get_generation_config", {
    req: { type: operation === "music" ? "music" : outputKind, taskType }
  });
  const model = selectTopviewModel(unwrapResult(configResponse), request.model);
  const common = modelAwareArgs(request, model);

  if (operation === "image") {
    const inputImageFileIds = [media.firstFrame, ...media.images].filter(Boolean);
    const storyboard = taskType === "storyboard";
    const args = compactObject({
      ...common,
      taskType,
      prompt: storyboard ? undefined : request.prompt,
      story: storyboard ? request.params?.story ?? request.prompt : undefined,
      inputImageFileIds: inputImageFileIds.length > 0 ? inputImageFileIds : undefined
    });
    validateModelArgs(model, args);
    return {
      tool: toolContract.image,
      taskType,
      outputKind,
      args
    };
  }
  if (operation === "music") {
    const args = compactObject({
      ...common,
      lyrics: request.prompt,
      styles: request.params?.styles ?? request.params?.style,
      instrumental: request.params?.instrumental,
      referenceAudio: media.audios[0] ? { fileId: media.audios[0], fileName: "reference-audio" } : undefined
    });
    validateModelArgs(model, args, new Set(["taskType"]));
    return {
      tool: toolContract.music,
      taskType,
      outputKind,
      args
    };
  }

  const videoArgs = compactObject({
    ...common,
    taskType,
    prompt: request.prompt,
    firstFrameFileId: taskType === "image_to_video" ? media.firstFrame : undefined,
    referenceImageFileIds: taskType === "image_to_video" && media.images.length > 0 ? media.images : undefined,
    inputImages: ["omni_reference", "motion_control"].includes(taskType)
      ? [media.firstFrame, ...media.images].filter(Boolean).map((fileId, index) => ({ fileId, name: `Image${index + 1}` }))
      : undefined,
    inputVideos: ["omni_reference", "motion_control"].includes(taskType)
      ? media.videos.map((fileId, index) => ({ fileId, name: `Video${index + 1}` }))
      : undefined
  });
  if (taskType === "image_to_video") delete videoArgs.aspectRatio;
  validateModelArgs(model, videoArgs);
  return { tool: toolContract.video, taskType, outputKind, args: videoArgs };
}

function prepareVoiceRequest(request, outputKind) {
  const voiceId = request.params?.voice_id ?? request.params?.voiceId;
  if (!nonEmptyString(voiceId)) throw new AdapterError("TopView voice generation requires params.voice_id", INVALID_REQUEST);
  return {
    tool: toolContract.voice,
    taskType: "text_to_speech",
    outputKind,
    args: compactObject({
      voiceId,
      voiceText: request.prompt,
      voiceSpeed: request.params?.speed ?? request.params?.voiceSpeed,
      emotionName: request.params?.emotion ?? request.params?.emotionName,
      boardId: request.params?.board_id ?? request.params?.boardId
    })
  };
}

async function prepareInstantVoiceRequest(client, request, media, outputKind) {
  const referenceAudioFileId = media.audios[0];
  if (!referenceAudioFileId) {
    throw new AdapterError("TopView instant voice generation requires one input audio file", INVALID_REQUEST);
  }
  const configResponse = await client.call("topview_get_generation_config", { req: { type: "audio" } });
  const model = selectTopviewModel(unwrapResult(configResponse), request.model);
  const args = compactObject({
    model: model.submitModel,
    text: request.prompt,
    referenceAudioFileId,
    emotionMode: request.params?.emotion_mode ?? request.params?.emotionMode,
    emotionVector: request.params?.emotion_vector ?? request.params?.emotionVector,
    emotionText: request.params?.emotion_text ?? request.params?.emotionText,
    boardId: request.params?.board_id ?? request.params?.boardId
  });
  validateModelArgs(model, args, new Set(["taskType"]));
  return {
    tool: toolContract.instantVoice,
    taskType: "instant_voice_clone",
    outputKind,
    args
  };
}

function prepareTopviewTemplateRequest(request, media) {
  const templateId = normalizeName(request.params?.template_id ?? "");
  const allImages = [media.firstFrame, ...media.images].filter(Boolean);
  if (templateId === "removebackground") {
    if (allImages.length > 2 || media.videos.length > 0 || media.audios.length > 0) {
      throw new AdapterError("TopView remove-background accepts one image and one optional mask", INVALID_REQUEST);
    }
    if (!allImages[0]) throw new AdapterError("TopView remove-background requires one input image", INVALID_REQUEST);
    return {
      tool: "topview_remove_background",
      taskType: "remove_background",
      outputKind: "image",
      args: compactObject({
        productImageFileId: allImages[0],
        productImageMaskFileId: allImages[1]
      })
    };
  }
  if (templateId === "productavatar") {
    if (allImages.length > 3 || media.videos.length > 0 || media.audios.length > 0) {
      throw new AdapterError("TopView product-avatar accepts product, template, and optional face images only", INVALID_REQUEST);
    }
    if (!allImages[0]) throw new AdapterError("TopView product-avatar requires a product image", INVALID_REQUEST);
    const generateImageMode = request.params?.generate_image_mode ?? request.params?.generateImageMode;
    const avatarId = request.params?.avatar_id ?? request.params?.avatarId;
    const templateImageFileId = allImages[1];
    if (!nonEmptyString(generateImageMode) || (!nonEmptyString(avatarId) && !templateImageFileId)) {
      throw new AdapterError("TopView product-avatar requires generate_image_mode and an avatar or template image", INVALID_REQUEST);
    }
    return {
      tool: "topview_product_avatar",
      taskType: "product_avatar",
      outputKind: "image",
      args: compactObject({
        avatarId,
        templateImageFileId,
        productImageWithoutBackgroundFileId: allImages[0],
        userFaceImageFileId: allImages[2],
        imageEditPrompt: request.prompt || undefined,
        productSize: request.params?.product_size ?? request.params?.productSize,
        generateImageMode,
        keepTarget: request.params?.keep_target ?? request.params?.keepTarget,
        location: request.params?.location,
        boardId: request.params?.board_id ?? request.params?.boardId
      })
    };
  }
  if (templateId === "avatarvideo") {
    if (allImages.length > 1 || media.videos.length > 0 || media.audios.length > 1) {
      throw new AdapterError("TopView avatar-video accepts one template image and one optional audio file", INVALID_REQUEST);
    }
    const mode = request.params?.mode;
    const avatarId = request.params?.avatar_id ?? request.params?.avatarId;
    const templateImageFileId = allImages[0];
    const scriptMode = request.params?.script_mode ?? request.params?.scriptMode ?? (media.audios[0] ? "audio" : "text");
    if (!nonEmptyString(mode) || (!nonEmptyString(avatarId) && !templateImageFileId)) {
      throw new AdapterError("TopView avatar-video requires mode and an avatar or template image", INVALID_REQUEST);
    }
    const voiceId = request.params?.voice_id ?? request.params?.voiceId;
    if (scriptMode === "text" && (!request.prompt || !nonEmptyString(voiceId))) {
      throw new AdapterError("TopView avatar-video text mode requires prompt and params.voice_id", INVALID_REQUEST);
    }
    if (scriptMode === "audio" && !media.audios[0]) {
      throw new AdapterError("TopView avatar-video audio mode requires one input audio file", INVALID_REQUEST);
    }
    return {
      tool: "topview_avatar_video",
      taskType: "avatar_video",
      outputKind: "video",
      args: compactObject({
        avatarId,
        templateImageFileId,
        mode,
        scriptMode,
        ttsText: scriptMode === "text" ? request.prompt : undefined,
        voiceId: scriptMode === "text" ? voiceId : undefined,
        voiceModel: request.params?.voice_model ?? request.params?.voiceModel,
        voiceSettings: request.params?.voice_settings ?? request.params?.voiceSettings,
        audioFileId: scriptMode === "audio" ? media.audios[0] : undefined,
        captionId: request.params?.caption_id ?? request.params?.captionId,
        customMotion: request.params?.custom_motion ?? request.params?.customMotion,
        offPeak: request.params?.off_peak ?? request.params?.offPeak,
        boardId: request.params?.board_id ?? request.params?.boardId
      })
    };
  }
  throw new AdapterError(`TopView template '${request.params?.template_id}' is not automated`, INVALID_REQUEST);
}

export function selectTopviewModel(config, requestedModel) {
  const models = Array.isArray(config?.models) ? config.models : [];
  const requested = nonEmptyString(requestedModel) ? normalizeName(requestedModel) : undefined;
  const selected = requested
    ? models.find((candidate) => [candidate.submitModel, candidate.displayName, candidate.backendModelCode]
        .filter(nonEmptyString)
        .some((name) => normalizeName(name) === requested))
    : models.find((candidate) => candidate.submitModel === config?.modelSelectionPolicy?.preferredSubmitModel)
      ?? models.find((candidate) => candidate.preferred === true)
      ?? models[0];
  if (!selected || !nonEmptyString(selected.submitModel)) {
    throw new AdapterError(
      requested ? `TopView MCP model '${requestedModel}' is not available for this operation` : "TopView MCP returned no compatible model",
      INVALID_REQUEST
    );
  }
  return selected;
}

export async function pollTopviewTask(client, input) {
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const deadline = Date.now() + input.timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const latest = await client.call("topview_query_task", {
      req: { taskType: input.taskType, taskId: input.taskId, needCloudFrontUrl: true }
    });
    const status = normalizeName(findStringByKeys(latest, ["status", "taskStatus", "task_status"]) ?? "");
    if (["success", "completed", "complete", "done", "finished"].includes(status)) return latest;
    if (["fail", "failed", "error", "cancelled", "canceled"].includes(status)) {
      throw new AdapterError("TopView MCP generation failed", INVALID_REQUEST);
    }
    await sleep(input.intervalSeconds * 1000);
  }
  throw new AdapterError("TopView MCP generation timed out", TRANSIENT);
}

async function uploadRequestMedia(client, request, options) {
  const upload = options.upload ?? (async (path) => {
    if (options.allowedRoot) await assertContainedRegularFile(options.allowedRoot, path);
    return uploadTopviewFile(client, path);
  });
  const firstFrame = request.first_frame ? await upload(request.first_frame) : undefined;
  const images = [];
  for (const path of [...(request.input_images ?? []), ...(request.reference_images ?? [])]) images.push(await upload(path));
  const videos = [];
  for (const path of [request.input_video, ...(request.input_videos ?? [])].filter(Boolean)) videos.push(await upload(path));
  const audios = [];
  for (const path of request.input_audios ?? []) audios.push(await upload(path));
  return { firstFrame, images, videos, audios };
}

export async function uploadTopviewFile(client, path) {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_MEDIA_BYTES) {
    throw new AdapterError("TopView input media is invalid or too large", INVALID_REQUEST);
  }
  const format = extname(path).replace(/^\./, "").toLowerCase();
  if (!/^(?:png|jpe?g|webp|gif|avif|mp4|mov|webm|mp3|wav|m4a|aac)$/.test(format)) {
    throw new AdapterError("TopView input media format is unsupported", INVALID_REQUEST);
  }
  const credential = unwrapResult(await client.call("ta_upload_credential", {
    format: format === "jpeg" ? "jpg" : format,
    needAccelerateUrl: true,
    storage: "s3"
  }));
  if (!nonEmptyString(credential.fileId) || !nonEmptyString(credential.uploadUrl)) {
    throw new AdapterError("TopView MCP did not return an upload credential", TRANSIENT);
  }
  const body = createReadStream(path);
  let response;
  try {
    response = await fetch(await assertPublicHttpsTarget(credential.uploadUrl), {
      method: "PUT",
      body,
      duplex: "half",
      redirect: "error"
    });
  } finally {
    body.destroy();
  }
  if (!response.ok) throw new AdapterError("TopView media upload failed", TRANSIENT);
  const checked = unwrapResult(await client.call("ta_upload_check_file", { fileId: credential.fileId }));
  if (String(checked?.code ?? "200") !== "200") throw new AdapterError("TopView media upload could not be verified", TRANSIENT);
  return credential.fileId;
}

function topviewTaskType(request, media) {
  if (request.operation === "image") {
    if (normalizeName(request.params?.task_type ?? "") === "storyboard") return "storyboard";
    return media.images.length > 0 || media.firstFrame ? "image_edit" : "text_to_image";
  }
  if (request.operation === "music") return "ai_music";
  if (request.operation === "motion-control") return "motion_control";
  if (request.operation === "reference" || media.videos.length > 0) return "omni_reference";
  if (media.firstFrame || media.images.length > 0) return "image_to_video";
  return "text_to_video";
}

function modelAwareArgs(request, model) {
  const defaults = model.defaultSubmitParameters && typeof model.defaultSubmitParameters === "object"
    ? model.defaultSubmitParameters
    : {};
  const params = request.params ?? {};
  const allowedRuntimeKeys = new Set([
    ...Object.keys(defaults),
    ...(Array.isArray(model.requiredSubmitFields) ? model.requiredSubmitFields : []),
    ...Object.keys(model.submitParameterOptions ?? {})
  ]);
  const runtimeParams = {};
  for (const [rawKey, value] of Object.entries(params)) {
    const key = snakeToCamel(rawKey);
    if (!allowedRuntimeKeys.has(key) || PROTECTED_MCP_FIELDS.has(key)) continue;
    runtimeParams[key] = value;
  }
  return compactObject({
    ...defaults,
    ...runtimeParams,
    model: model.submitModel,
    aspectRatio: allowedRuntimeKeys.has("aspectRatio")
      ? request.aspect ?? params.aspectRatio ?? params.aspect_ratio ?? defaults.aspectRatio
      : undefined,
    resolution: allowedRuntimeKeys.has("resolution") ? params.resolution ?? defaults.resolution : undefined,
    duration: allowedRuntimeKeys.has("duration") ? request.duration ?? params.duration ?? defaults.duration : undefined,
    quality: allowedRuntimeKeys.has("quality") ? params.quality ?? defaults.quality : undefined,
    generateCount: params.count ?? params.generateCount,
    generatingCount: params.count ?? params.generatingCount,
    boardId: params.board_id ?? params.boardId
  });
}

function validateRequestMediaUsage(request, operation) {
  const imageCount = (request.first_frame ? 1 : 0)
    + (request.input_images?.length ?? 0)
    + (request.reference_images?.length ?? 0);
  const videoCount = (request.input_video ? 1 : 0) + (request.input_videos?.length ?? 0);
  const hasImages = imageCount > 0;
  const hasVideos = videoCount > 0;
  const audioCount = request.input_audios?.length ?? 0;
  if (operation === "image" && (hasVideos || audioCount > 0)) {
    throw new AdapterError("TopView image generation does not accept video or audio inputs", INVALID_REQUEST);
  }
  if (operation === "music" && (hasImages || hasVideos || audioCount > 1)) {
    throw new AdapterError("TopView music generation accepts at most one reference audio file", INVALID_REQUEST);
  }
  if (operation === "voice" && (hasImages || hasVideos || audioCount > 1)) {
    throw new AdapterError("TopView voice generation accepts at most one reference audio file", INVALID_REQUEST);
  }
  if (["video", "reference", "motion-control"].includes(operation) && audioCount > 0) {
    throw new AdapterError("TopView video generation does not accept audio reference files", INVALID_REQUEST);
  }
  if (operation === "template") {
    const templateId = normalizeName(request.params?.template_id ?? "");
    if (!["removebackground", "productavatar", "avatarvideo"].includes(templateId)) {
      throw new AdapterError(`TopView template '${request.params?.template_id}' is not automated`, INVALID_REQUEST);
    }
    if (templateId === "removebackground" && (imageCount > 2 || videoCount > 0 || audioCount > 0)) {
      throw new AdapterError("TopView remove-background accepts one image and one optional mask", INVALID_REQUEST);
    }
    if (templateId === "productavatar" && (imageCount > 3 || videoCount > 0 || audioCount > 0)) {
      throw new AdapterError("TopView product-avatar accepts product, template, and optional face images only", INVALID_REQUEST);
    }
    if (templateId === "avatarvideo" && (imageCount > 1 || videoCount > 0 || audioCount > 1)) {
      throw new AdapterError("TopView avatar-video accepts one template image and one optional audio file", INVALID_REQUEST);
    }
  }
}

const PROTECTED_MCP_FIELDS = new Set([
  "model", "taskType", "prompt", "noticeUrl",
  "firstFrameFileId", "referenceImageFileIds", "inputImageFileIds", "inputImages", "inputVideos"
]);

function validateModelArgs(model, args, ignoredRequiredFields = new Set()) {
  const required = Array.isArray(model.requiredSubmitFields) ? model.requiredSubmitFields : [];
  const missing = required.filter((field) => !ignoredRequiredFields.has(field) && (
    args[field] === undefined || args[field] === null || args[field] === ""
  ));
  if (missing.length > 0) {
    throw new AdapterError(`TopView MCP model '${model.submitModel}' requires params: ${missing.join(", ")}`, INVALID_REQUEST);
  }
  for (const [field, options] of Object.entries(model.submitParameterOptions ?? {})) {
    if (args[field] === undefined || !Array.isArray(options) || options.length === 0) continue;
    if (!options.some((candidate) => JSON.stringify(candidate) === JSON.stringify(args[field]))) {
      throw new AdapterError(`TopView MCP parameter '${field}' is invalid for model '${model.submitModel}'`, INVALID_REQUEST);
    }
  }
}

function snakeToCamel(value) {
  return value.replace(/_([a-z0-9])/g, (_, character) => character.toUpperCase());
}

function parsePayload(input) {
  if (!input || typeof input !== "object" || !input.request || typeof input.request !== "object") {
    throw new AdapterError("payload.request is required", INVALID_REQUEST);
  }
  if (
    !nonEmptyString(input.run_id)
    || !SAFE_ID.test(input.run_id)
    || !nonEmptyString(input.run_dir)
    || !nonEmptyString(input.request.id)
    || !SAFE_ID.test(input.request.id)
  ) {
    throw new AdapterError("payload run identifiers are required", INVALID_REQUEST);
  }
  return input;
}

async function assertContainedRegularFile(root, path) {
  const rootReal = await realpath(root);
  const fileReal = await realpath(path);
  const relativePath = relative(rootReal, fileReal);
  if (
    relativePath === ""
    || relativePath.startsWith("..")
    || isAbsolute(relativePath)
    || relativePath.includes("\0")
    || (await lstat(path)).isSymbolicLink()
    || !(await stat(fileReal)).isFile()
  ) {
    throw new AdapterError("TopView input media must be a pinned regular file inside the run directory", INVALID_REQUEST);
  }
}

async function assertContainedDirectory(root, path) {
  const rootReal = await realpath(root);
  const directoryReal = await realpath(path);
  const relativePath = relative(rootReal, directoryReal);
  const pathStat = await lstat(path);
  if (
    relativePath === ""
    || relativePath.startsWith("..")
    || isAbsolute(relativePath)
    || !pathStat.isDirectory()
    || pathStat.isSymbolicLink()
  ) {
    throw new AdapterError("TopView output directory is unsafe", INVALID_REQUEST);
  }
}

function parseMcpToolResponse(response, toolName) {
  if (response?.isError) throw new AdapterError(`TopView MCP tool '${toolName}' failed`, classifyMcpError(response));
  const text = response?.content?.find((item) => item?.type === "text" && nonEmptyString(item.text))?.text;
  let parsed = response?.structuredContent;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* structured content remains the fallback */ }
  }
  if (!parsed || typeof parsed !== "object") throw new AdapterError(`TopView MCP tool '${toolName}' returned invalid output`, TRANSIENT);
  if (String(parsed.code ?? "200") !== "200") {
    const message = nonEmptyString(parsed.message) ? parsed.message : "TopView MCP request failed";
    throw new AdapterError(message, /429|rate|busy/i.test(message) ? RATE_LIMITED : INVALID_REQUEST);
  }
  return parsed;
}

function classifyMcpError(response) {
  const text = JSON.stringify(response?.content ?? "");
  return /429|rate|busy/i.test(text) ? RATE_LIMITED : /invalid|required|unsupported|4000|4100/i.test(text) ? INVALID_REQUEST : TRANSIENT;
}

function unwrapResult(value) {
  return value?.result && typeof value.result === "object" ? value.result : value;
}

function findStringByKeys(value, keys) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKeys(item, keys);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const key of keys) if (nonEmptyString(value[key])) return value[key];
    for (const item of Object.values(value)) {
      const found = findStringByKeys(item, keys);
      if (found) return found;
    }
  }
  return undefined;
}

function findNumberByKeys(value, keys) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumberByKeys(item, keys);
      if (found !== undefined) return found;
    }
  } else if (value && typeof value === "object") {
    for (const key of keys) {
      const number = Number(value[key]);
      if (Number.isFinite(number) && number >= 0) return number;
    }
    for (const item of Object.values(value)) {
      const found = findNumberByKeys(item, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findMediaUrls(value, kind, urls = new Set(), keyHint = "") {
  if (typeof value === "string") {
    try {
      const url = validatePublicHttps(value);
      if (matchesMediaPath(url.pathname, kind) || /(?:filePath|cloudFrontUrl|downloadUrl|imageUrl|videoUrl|audioUrl)$/i.test(keyHint)) {
        urls.add(url.toString());
      }
    } catch { /* not a public media URL */ }
  } else if (Array.isArray(value)) {
    for (const item of value) findMediaUrls(item, kind, urls, keyHint);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) findMediaUrls(item, kind, urls, key);
  }
  return [...urls];
}

async function downloadPublicHttps(source, target, kind) {
  let url = await assertPublicHttpsTarget(source);
  let response;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    response = await fetch(url, { redirect: "manual" });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location || redirect === 3) throw new AdapterError("TopView media redirect was rejected", TRANSIENT);
    url = await assertPublicHttpsTarget(new URL(location, url));
  }
  if (!response?.ok || !response.body) throw new AdapterError("TopView media download failed", TRANSIENT);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && !contentTypeMatchesKind(contentType, kind)) {
    throw new AdapterError("TopView media download returned an unexpected content type", INVALID_REQUEST);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_MEDIA_BYTES) throw new AdapterError("TopView media download exceeds the size limit", INVALID_REQUEST);
  const file = await open(target, "w", 0o600);
  let size = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MEDIA_BYTES) {
        await reader.cancel();
        throw new AdapterError("TopView media download exceeds the size limit", INVALID_REQUEST);
      }
      await file.write(value);
    }
  } catch (error) {
    await file.close();
    await rm(target, { force: true });
    throw error;
  }
  await file.close();
  if (size === 0) {
    await rm(target, { force: true });
    throw new AdapterError("TopView media download was empty", TRANSIENT);
  }
}

function contentTypeMatchesKind(contentType, kind) {
  if (contentType === "application/octet-stream" || contentType === "binary/octet-stream") return true;
  if (kind === "image") return contentType.startsWith("image/");
  if (kind === "audio") return contentType.startsWith("audio/");
  return contentType.startsWith("video/");
}

function validatePublicHttps(source) {
  const url = source instanceof URL ? source : new URL(source);
  if (url.protocol !== "https:" || isPrivateHost(url.hostname)) {
    throw new AdapterError("TopView media URL must use public HTTPS", INVALID_REQUEST);
  }
  return url;
}

async function assertPublicHttpsTarget(source) {
  const url = validatePublicHttps(source);
  if (isIP(url.hostname)) return url;
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateHost(address))) {
    throw new AdapterError("TopView media URL must resolve to a public host", INVALID_REQUEST);
  }
  return url;
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isIP(host) === 6) {
    if (host === "::" || host === "::1" || /^(?:fc|fd|fe[89ab])/i.test(host)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
    return mapped ? isPrivateHost(mapped) : false;
  }
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split(".").map(Number);
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19));
}

function matchesMediaPath(path, kind) {
  if (kind === "image") return /\.(?:png|jpe?g|webp|gif|avif)$/i.test(path);
  if (kind === "audio") return /\.(?:mp3|wav|m4a|aac|flac|ogg)$/i.test(path);
  return /\.(?:mp4|mov|webm|mkv)$/i.test(path);
}

function safeExtension(source, kind) {
  try {
    const suffix = extname(new URL(source).pathname).toLowerCase();
    if (matchesMediaPath(`file${suffix}`, kind)) return suffix;
  } catch { /* use fallback */ }
  return kind === "image" ? ".png" : kind === "audio" ? ".mp3" : ".mp4";
}

function videoAsset(request, src, index) {
  const media = probeVideo(src, request);
  return {
    id: `${request.id}-clip-${index + 1}`,
    src,
    duration: media.duration,
    fps: media.fps,
    resolution: { width: media.width, height: media.height },
    audio: media.audio
  };
}

function probeVideo(path, request) {
  const fallback = request.aspect === "9:16"
    ? { width: 1080, height: 1920, audio: false }
    : { width: 1920, height: 1080, audio: false };
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration",
    "-of", "json", path
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 * 4 });
  if (result.status !== 0) return { duration: request.duration ?? 5, fps: 30, ...fallback };
  try {
    const parsed = JSON.parse(result.stdout);
    const stream = parsed.streams?.find((candidate) => candidate.codec_type === "video") ?? {};
    const [numerator, denominator = 1] = String(stream.r_frame_rate ?? "30/1").split("/").map(Number);
    return {
      duration: Number(parsed.format?.duration) || request.duration || 5,
      fps: numerator / denominator || 30,
      width: Number(stream.width) || fallback.width,
      height: Number(stream.height) || fallback.height,
      audio: parsed.streams?.some((candidate) => candidate.codec_type === "audio") ?? false
    };
  } catch {
    return { duration: request.duration ?? 5, fps: 30, ...fallback };
  }
}

function timeoutSeconds(request, kind) {
  const fallback = kind === "video" ? 1200 : 600;
  const value = Number(request.params?.timeout_seconds ?? fallback);
  return Number.isFinite(value) ? Math.max(30, Math.min(3600, Math.round(value))) : fallback;
}

function intervalSeconds(request) {
  const value = Number(request.params?.poll_interval_seconds ?? 5);
  return Number.isFinite(value) ? Math.max(2, Math.min(30, Math.round(value))) : 5;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function normalizeName(value) {
  return String(value).toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeError(error) {
  if (error instanceof AdapterError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const rateLimited = /429|rate|busy/i.test(message);
  return new AdapterError(rateLimited ? "TopView MCP is rate limited" : message, rateLimited ? RATE_LIMITED : TRANSIENT);
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

class AdapterError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}
