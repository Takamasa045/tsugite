import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse, parseDocument } from "yaml";
import { z } from "zod";
import {
  aggregateFeedback,
  decideProjectFeedbackPromotion,
  feedbackPathForProject,
  readProjectFeedback,
  type FeedbackAggregate,
  type FeedbackFileIdentity,
  type FeedbackRecord
} from "../feedback/index.js";
import { connectionExecutionMode, listConnectionOptions } from "../connections/registry.js";
import { createPlan } from "../orchestrator/plan.js";
import { inspectGate1Review } from "../orchestrator/review.js";
import { inspectGate2RunForApproval } from "../orchestrator/run.js";
import {
  acquireRunLock,
  LAUNCHER_EXPECTED_APPROVAL_DIGEST_ENV,
  readState,
  RUN_LOCK_INHERIT_ENV,
  type RunLock,
  type RunState
} from "../orchestrator/state.js";
import { loadProject } from "../project/loadProject.js";
import { validateProject, type ValidateProjectOptions } from "../project/validateProject.js";
import {
  generationRequestCapability,
  generationRequestMode,
  generationRequestOutputKind,
  type Project
} from "../project/schema.js";
import type { Issue } from "../types.js";
import {
  digestWorkflowViewerReview,
  getWorkflowViewerOpenCommand,
  prepareWorkflowViewerBundle,
  WORKFLOW_VIEWER_EVIDENCE_FILE,
  writeWorkflowViewer,
  type WorkflowViewerResult,
  type WriteWorkflowViewerOptions
} from "./artifact.js";

const LOOPBACK_HOST = "127.0.0.1";
const TSUGITE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PIPELINE_ENTRY = join(TSUGITE_ROOT, "bin", "pipeline");

export type LauncherProject = {
  id: string;
  name: string;
  slug: string;
  runId: string;
  revision: string;
  status: string;
  updatedAt: string | null;
  hasViewer: boolean;
  viewerUrl?: string;
  gate1ReviewUrl?: string;
  gate2ReviewUrl?: string;
  thumbnailUrl?: string;
  valid: boolean;
  refreshable: boolean;
  readOnly: boolean;
  workflowNodes: LauncherWorkflowNode[];
  availableActions: LauncherAction[];
  issues: Issue[];
  issue?: string;
};

export type LauncherAction =
  | "validate"
  | "plan"
  | "review"
  | "dry-run"
  | "run"
  | "render"
  | "gate-1-approve"
  | "gate-1-revise"
  | "gate-1-abort"
  | "gate-2-approve-all"
  | "gate-2-revise"
  | "gate-2-abort"
  | "gate-3-approve"
  | "gate-3-re-render"
  | "gate-3-abort";

export type LauncherWorkflowNode = {
  id: "validate" | "plan" | "review" | "gate-1" | "run" | "gate-2" | "render" | "gate-3";
  label: string;
  status: "pending" | "running" | "waiting_approval" | "completed" | "error";
  action: LauncherAction;
};

export type LauncherJob = {
  id: string;
  action: LauncherAction;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

export type LauncherProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type LauncherProcessRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
) => Promise<LauncherProcessResult>;

export type LauncherTemplate = {
  id: string;
  name: string;
  summary: string;
  category: string;
  useCases: string[];
  duration: string;
  aspectRatio: string;
  speakers?: number;
  requiredInputs: string[];
  requiredInputDetails: LauncherTemplateInput[];
  preview: LauncherTemplatePreview | null;
  notFor: string[];
  variants: LauncherTemplateVariant[];
  tags: string[];
  audio: string;
  status: "stable" | "experimental" | "deprecated" | "unknown";
  distribution: "bundled" | "local-only" | "unknown";
  valid: boolean;
  issue?: { code: string; message: string };
};

export type LauncherTemplateInput = {
  type: "text" | "image" | "audio" | "video" | "data" | "other";
  label: string;
};

export type LauncherTemplatePreview = {
  frames: Array<{
    kind: "product" | "person" | "interface" | "parts" | "hands" | "result" | "event" | "text";
    label: string;
  }>;
  flow: string[];
};

export type LauncherTemplateVariant = {
  id: string;
  label: string;
  defaultOptionId?: string;
  options: Array<{
    id: string;
    label: string;
    description: string;
  }>;
};

export type LauncherFeedback = FeedbackAggregate;

const TEMPLATE_METADATA_MAX_BYTES = 64 * 1024;
const LAUNCHER_FEEDBACK_MAX_PROJECTS = 128;
const LAUNCHER_FEEDBACK_MAX_ITEMS = 1_000;
const LAUNCHER_FEEDBACK_NOTICE_RESERVE = 3;
const REVIEW_PREVIEW_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const LAUNCHER_DECISION_BODY_MAX_BYTES = 8 * 1024;
const LAUNCHER_GENERATION_BODY_MAX_BYTES = 2 * 1024;
const LAUNCHER_JOB_OUTPUT_MAX_BYTES = 16 * 1024;
const LAUNCHER_VIEWER_EVIDENCE_MAX_BYTES = 512 * 1024;
const WORKFLOW_VIEWER_SNAPSHOT_FILE_LIMIT = 512;
const WORKFLOW_VIEWER_SNAPSHOT_BYTE_LIMIT = 16 * 1024 * 1024 * 1024;
const WORKFLOW_VIEWER_SNAPSHOT_PATH_BYTE_LIMIT = 512;
const WORKFLOW_VIEWER_DOCUMENT_BYTE_LIMIT = 16 * 1024 * 1024;
const LAUNCHER_GATE2_QC_MAX_BYTES = 8 * 1024 * 1024;
const LAUNCHER_GATE2_ASSET_LIMIT = 1024;
const LAUNCHER_GATE2_ASSET_DIGEST_CACHE_MAX_ENTRIES = 2048;
const LAUNCHER_SNAPSHOT_DIGEST_CACHE_MAX_ENTRIES = 2048;
const LAUNCHER_REVIEW_DIGEST_CACHE_MAX_ENTRIES = 256;
const LAUNCHER_REVIEW_FILE_LIMIT = 64;
const LAUNCHER_REVIEW_BYTE_LIMIT = 64 * 1024 * 1024;
const LAUNCHER_REVIEW_ENTRY_LIMIT = 512;
const LAUNCHER_REVIEW_DIRECTORY_DEPTH_LIMIT = 32;
const REGULAR_FILE_DIGEST_CACHE_MAX_ENTRIES = 512;
const regularFileDigestCache = new Map<string, {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string;
}>();
const gate2AssetDigestCache = new Map<string, {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  digest: string;
}>();
const snapshotArtifactDigestCache = new Map<string, {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  digest: string;
}>();
const reviewAggregateDigestCache = new Map<string, {
  signature: string;
  digest: string;
}>();
const VIEWER_REFRESH_CAPABILITY_ISSUES = new Set([
  "backend.capability.captions",
  "backend.capability.vertical",
  "backend.capability.fps",
  "backend.capability.audio_mix",
  "backend.capability.transitions",
  "backend.capability.preset"
]);
const promotionDecisionSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  proposalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  decision: z.enum(["approved", "rejected"])
}).strict();
const generationConnectionSchema = z.object({
  connection: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
}).strict();
const safeLauncherActionSchema = z.object({
  action: z.enum(["validate", "plan", "review", "dry-run"]),
  expectedRunId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(128),
  revision: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const confirmedLauncherActionSchema = z.object({
  action: z.enum([
    "run",
    "render",
    "gate-1-approve",
    "gate-1-revise",
    "gate-1-abort",
    "gate-2-approve-all",
    "gate-2-revise",
    "gate-2-abort",
    "gate-3-approve",
    "gate-3-re-render",
    "gate-3-abort"
  ]),
  expectedRunId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(128),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true)
}).strict();
const launcherActionSchema = z.union([
  safeLauncherActionSchema,
  confirmedLauncherActionSchema
]);
const viewerEvidenceSchema = z.object({
  schema_version: z.literal(1),
  review_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  gate2_qc_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  viewer_index_digest: z.string().regex(/^[a-f0-9]{64}$/),
  workflow_digest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({
    path: z.string().min(1).max(WORKFLOW_VIEWER_SNAPSHOT_PATH_BYTE_LIMIT)
      .refine(isSafeViewerManifestPath),
    size: z.number().int().nonnegative().max(WORKFLOW_VIEWER_SNAPSHOT_BYTE_LIMIT),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict()).min(2).max(WORKFLOW_VIEWER_SNAPSHOT_FILE_LIMIT)
}).strict().superRefine((evidence, context) => {
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const [index, file] of evidence.files.entries()) {
    if (Buffer.byteLength(file.path) > WORKFLOW_VIEWER_SNAPSHOT_PATH_BYTE_LIMIT) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "snapshot path is too long", path: ["files", index, "path"] });
    }
    if (paths.has(file.path)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "snapshot paths must be unique", path: ["files", index, "path"] });
    }
    paths.add(file.path);
    totalBytes += file.size;
  }
  if (totalBytes > WORKFLOW_VIEWER_SNAPSHOT_BYTE_LIMIT) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "snapshot is too large", path: ["files"] });
  }
  for (const required of ["index.html", "workflow.json"]) {
    if (!paths.has(required)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `snapshot is missing ${required}`, path: ["files"] });
    }
  }
});
const templateIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const nonEmptyText = z.string().trim().min(1).max(240);
const descriptionText = z.string().trim().min(1).max(600);
const templatePreviewFrameSchema = z.object({
  kind: z.enum(["product", "person", "interface", "parts", "hands", "result", "event", "text"]),
  label: nonEmptyText
}).strict();
const templatePreviewSchema = z.object({
  frames: z.tuple([
    templatePreviewFrameSchema,
    templatePreviewFrameSchema,
    templatePreviewFrameSchema
  ]),
  flow: z.array(nonEmptyText).min(3).max(5)
}).strict();
const templateVariantSchema = z.object({
  id: templateIdSchema,
  label: nonEmptyText,
  default_option: templateIdSchema.optional(),
  options: z.array(z.object({
    id: templateIdSchema,
    label: nonEmptyText,
    description: descriptionText
  }).strict()).min(2).max(12)
}).strict().superRefine((variant, context) => {
  const optionIds = new Set<string>();
  for (const [index, option] of variant.options.entries()) {
    if (optionIds.has(option.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "variant option ids must be unique",
        path: ["options", index, "id"]
      });
    }
    optionIds.add(option.id);
  }
  if (variant.default_option && !optionIds.has(variant.default_option)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "default_option must reference an option in the same variant",
      path: ["default_option"]
    });
  }
});
const templateMetadataSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("tsugite-template"),
  id: templateIdSchema,
  name: nonEmptyText,
  summary: descriptionText,
  category: nonEmptyText,
  use_cases: z.array(nonEmptyText).min(1).max(12),
  output: z.object({
    duration: z.object({
      mode: z.enum(["fixed", "variable"]),
      min_seconds: z.number().int().nonnegative().max(86_400),
      max_seconds: z.number().int().nonnegative().max(86_400),
      label: nonEmptyText
    }).strict().refine((duration) => duration.max_seconds >= duration.min_seconds, {
      message: "max_seconds must be greater than or equal to min_seconds"
    }),
    aspect_ratios: z.array(nonEmptyText).min(1).max(4),
    speaker_count: z.number().int().nonnegative().max(20).optional()
  }).strict(),
  required_inputs: z.array(z.object({
    type: z.enum(["text", "image", "audio", "video", "data", "other"]),
    label: nonEmptyText,
    required: z.boolean()
  }).strict()).min(1).max(16),
  preview: templatePreviewSchema.optional(),
  not_for: z.array(nonEmptyText).max(6).default([]),
  variants: z.array(templateVariantSchema).max(8).default([]).superRefine((variants, context) => {
    const variantIds = new Set<string>();
    for (const [index, variant] of variants.entries()) {
      if (variantIds.has(variant.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "variant ids must be unique",
          path: [index, "id"]
        });
      }
      variantIds.add(variant.id);
    }
  }),
  tags: z.array(nonEmptyText).max(16).default([]),
  audio: z.object({
    narration: z.enum(["required", "optional", "unsupported"]),
    bgm: z.enum(["required", "optional", "unsupported"]),
    silent_draft: z.boolean(),
    notes: descriptionText
  }).strict(),
  status: z.enum(["stable", "experimental", "deprecated"]),
  distribution: z.enum(["bundled", "local-only"])
}).strict();

class TemplateMetadataError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type LauncherProjectRecord = {
  id: string;
  name: string;
  configPath: string;
  sourceModifiedAtMs: number;
  readOnly: boolean;
  identity?: LauncherProjectIdentity;
  feedbackIdentity?: FeedbackFileIdentity;
  project?: Project;
  outputDir?: string;
  viewerRoot?: LauncherDirectoryIdentity;
  evidenceExpected?: boolean;
  evidenceInvalid?: boolean;
  thumbnailPath?: string;
  approvalDigests?: Partial<Record<
    "gate-1-approve" | "gate-2-approve-all" | "gate-3-approve",
    string
  >>;
  public: LauncherProject;
};

type LauncherProjectDirectory = {
  path: string;
  readOnly: boolean;
};

type LauncherProjectIdentity = {
  realProjectDir: string;
  realConfigPath: string;
  projectDevice: number;
  projectInode: number;
  configDevice: number;
  configInode: number;
};

type OpenedStaticFile = {
  handle: FileHandle;
  path: string;
  stats: Stats;
};

type LauncherDirectoryIdentity = {
  path: string;
  realPath: string;
  device: number;
  inode: number;
};

type LauncherViewerSnapshot = {
  outputDir: string;
  root: LauncherDirectoryIdentity;
};

function preserveViewerEvidenceRequirement(
  previous: LauncherProjectRecord | undefined,
  next: LauncherProjectRecord
): void {
  if (next.evidenceExpected || next.evidenceInvalid) return;
  if (previous?.evidenceExpected) next.evidenceExpected = true;
  if (previous?.evidenceInvalid) next.evidenceInvalid = true;
}

export type StartWorkflowViewerLauncherOptions = {
  projectsDir?: string;
  additionalProjectsDirs?: string[];
  templatesDir?: string;
  port?: number;
  bundleDir?: string;
  allowProjectActions?: boolean;
  beforeRefresh?: (project: LauncherProject) => void | Promise<void>;
  beforeProjectReloadCommit?: () => void | Promise<void>;
  beforeServeArtifact?: (path: string) => void | Promise<void>;
  onSnapshotFingerprint?: (path: string) => void | Promise<void>;
  onReviewFingerprint?: (root: string) => void | Promise<void>;
  writeViewer?: (options: WriteWorkflowViewerOptions) => Promise<WorkflowViewerResult>;
  runGeneration?: (configPath: string) => Promise<unknown>;
  canStartWork?: () => boolean;
  executePipeline?: LauncherProcessRunner;
  validationOptions?: ValidateProjectOptions;
};

export type WorkflowViewerLauncher = {
  url: string;
  artifactUrl: string;
  privateRoot?: string;
  port: number;
  token: string;
  projectCount: number;
  hasActive: () => boolean;
  hasBlockingWork: () => boolean;
  suspendWork: () => () => void;
  closed: Promise<void>;
  close: () => Promise<void>;
};

export async function startWorkflowViewerLauncher(
  options: StartWorkflowViewerLauncherOptions = {}
): Promise<WorkflowViewerLauncher> {
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("Viewer launcher port must be an integer between 0 and 65535");
  }

  const projectDirectories = await discoverLauncherProjectDirectories(
    options.projectsDir,
    options.additionalProjectsDirs
  );
  const templatesDir = resolve(
    options.templatesDir ?? fileURLToPath(new URL("../../templates", import.meta.url))
  );
  const bundleDir = await prepareWorkflowViewerBundle(options.bundleDir);
  const token = randomBytes(24).toString("hex");
  const idsByConfig = new Map<string, string>();
  const viewerSnapshots = new Map<string, LauncherViewerSnapshot>();
  const jobs = new Map<string, LauncherJob>();
  let projects = new Map<string, LauncherProjectRecord>();
  const refreshing = new Set<string>();
  const generating = new Set<string>();
  let activeMutations = 0;
  let activeBlockingMutations = 0;
  let workPauseCount = 0;
  let closing = false;
  const writer = options.writeViewer ?? writeWorkflowViewer;
  const executePipeline = options.executePipeline ?? executePipelineProcess;
  const allowProjectActions = options.allowProjectActions ?? true;
  let launcherOrigin = "";
  let artifactOrigin = "";

  const reloadProjects = async (): Promise<LauncherProject[]> => {
    const snapshotsAtStart = new Map(viewerSnapshots);
    const discovered = await discoverProjects(
      projectDirectories,
      idsByConfig,
      artifactOrigin,
      launcherOrigin,
      viewerSnapshots,
      options.validationOptions
    );
    await options.beforeProjectReloadCommit?.();
    const nextProjects = new Map(discovered.map((project) => [project.id, project]));
    for (const [projectId, currentRecord] of projects) {
      if (viewerSnapshots.get(projectId) !== snapshotsAtStart.get(projectId)) {
        nextProjects.set(projectId, currentRecord);
      }
    }
    for (const [projectId, record] of nextProjects) {
      preserveViewerEvidenceRequirement(projects.get(projectId), record);
      record.public = withLauncherJob(record.public, jobs.get(projectId));
    }
    projects = nextProjects;
    return [...nextProjects.values()].map((project) => project.public);
  };
  const rootHtml = injectLauncherMeta(
    await readFile(join(bundleDir, "index.html"), "utf8"),
    token
  );
  const privateRoot = options.writeViewer
    ? undefined
    : await createLauncherPrivateRoot();

  const launcherServer = createServer((request, response) => {
    void handleLauncherRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(response, 500, {
        ok: false,
        issue: {
          code: "viewer_launcher.internal",
          message: "制作案件を処理できませんでした。ランチャーを再起動してください。"
        }
      });
    });
  });
  const artifactServer = createServer((request, response) => {
    void handleArtifactRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(response, 500, {
        ok: false,
        issue: {
          code: "viewer_launcher.internal",
          message: "制作案件を処理できませんでした。ランチャーを再起動してください。"
        }
      });
    });
  });
  const launcherClosed = waitForServerClose(launcherServer);
  const artifactClosed = waitForServerClose(artifactServer);

  async function handleLauncherRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    setCommonHeaders(response);
    if (launcherOrigin && request.headers.host !== new URL(launcherOrigin).host) {
      sendJson(response, 403, {
        ok: false,
        issue: { code: "viewer_launcher.forbidden", message: "Launcher request was not authorized" }
      });
      return;
    }
    const requestUrl = new URL(request.url ?? "/", launcherOrigin || `http://${LOOPBACK_HOST}`);
    const method = request.method ?? "GET";
    const mutationRequest = method === "POST" && (
      /^\/api\/projects\/[^/]+\/generation-connection$/.test(requestUrl.pathname)
      || /^\/api\/projects\/[^/]+\/generate$/.test(requestUrl.pathname)
      || (allowProjectActions && /^\/api\/projects\/[^/]+\/action$/.test(requestUrl.pathname))
      || /^\/api\/feedback\/[^/]+\/promotion-decision$/.test(requestUrl.pathname)
      || /^\/api\/projects\/[^/]+\/refresh$/.test(requestUrl.pathname)
    );
    const interruptibleMutation = method === "POST"
      && /^\/api\/projects\/[^/]+\/generate$/.test(requestUrl.pathname);
    let mutationReserved = false;
    if (mutationRequest) {
      if (
        request.headers.origin !== launcherOrigin
        || request.headers["x-tsugite-token"] !== token
      ) {
        sendJson(response, 403, {
          ok: false,
          issue: { code: "viewer_launcher.forbidden", message: "Launcher request was not authorized" }
        });
        return;
      }
      if (closing || workPauseCount > 0 || (options.canStartWork && !options.canStartWork())) {
        sendJson(response, 409, {
          ok: false,
          issue: {
            code: "viewer_launcher.work_blocked",
            message: "New work cannot start while Desktop is changing workspace or shutting down"
          }
        });
        return;
      }
      activeMutations += 1;
      if (!interruptibleMutation) activeBlockingMutations += 1;
      mutationReserved = true;
    }

    try {
      await handleLauncherRoute(request, response, requestUrl, method);
    } finally {
      if (mutationReserved) {
        activeMutations -= 1;
        if (!interruptibleMutation) activeBlockingMutations -= 1;
      }
    }
  }

  async function handleLauncherRoute(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
    method: string
  ): Promise<void> {
    if (method === "GET" && requestUrl.pathname === "/") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader(
        "content-security-policy",
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      );
      response.end(rootHtml);
      return;
    }

    if ((method === "GET" || method === "HEAD") && requestUrl.pathname.startsWith("/assets/")) {
      const assetFile = await openContainedStaticFile(
        join(bundleDir, "assets"),
        requestUrl.pathname.slice("/assets/".length)
      );
      if (!assetFile) return sendNotFound(response);
      return serveFile(request, response, assetFile);
    }

    const thumbnailMatch = /^\/thumbnail\/([^/]+)$/.exec(requestUrl.pathname);
    if ((method === "GET" || method === "HEAD") && thumbnailMatch) {
      const record = projects.get(thumbnailMatch[1]!);
      if (!record?.thumbnailPath || !record.identity) return sendNotFound(response);
      const thumbnailFile = await safeProjectThumbnail(
        record.configPath,
        record.thumbnailPath,
        record.identity
      );
      if (!thumbnailFile) return sendNotFound(response);
      let handedToFileServer = false;
      try {
        await beforeServeArtifact(thumbnailFile);
        handedToFileServer = true;
        return serveFile(request, response, thumbnailFile);
      } finally {
        if (!handedToFileServer) await thumbnailFile.handle.close();
      }
    }

    if (method === "GET" && requestUrl.pathname === "/api/projects") {
      sendJson(response, 200, { ok: true, projects: await reloadProjects() });
      return;
    }

    const generationCanvasMatch = /^\/api\/projects\/([^/]+)\/generation-canvas$/.exec(requestUrl.pathname);
    if (method === "GET" && generationCanvasMatch) {
      const record = projects.get(generationCanvasMatch[1]!);
      if (!record?.identity || !record.project) return sendNotFound(response);
      if (!await matchesProjectIdentity(record.configPath, record.identity)) {
        sendProjectChanged(response);
        return;
      }
      const generation = record.project.generation;
      const audio = record.project.audio;
      const connectionOptions = await listConnectionOptions();
      const connectionIds = [generation?.connection, audio?.connection].filter(
        (id): id is string => Boolean(id)
      );
      const connectionSummaries = connectionOptions
        .filter((connection) => connection.implementation_status === "integrated"
          && (connectionExecutionMode(connection) === "pipeline-adapter" || connectionIds.includes(connection.id))
          && (connection.model_policy === "runtime" || connectionIds.includes(connection.id))
          && connection.automated_capabilities.some((capability) => /^(?:image|video|audio)\./.test(capability)))
        .map((connection) => ({
          id: connection.id,
          displayName: connection.display_name,
          transport: connection.transport,
          authKind: connection.auth_kind,
          capabilities: connection.capabilities,
          automatedCapabilities: connection.automated_capabilities,
          routeNote: connection.route_note,
          modelPolicy: connection.model_policy,
          setupStatus: connection.setup.status,
          executionMode: connectionExecutionMode(connection)
        }));
      sendJson(response, 200, {
        ok: true,
        canvas: {
          project: {
            id: record.id,
            name: record.name,
            slug: record.public.slug,
            runId: record.public.runId,
            status: record.public.status,
            valid: record.public.valid,
            refreshable: record.public.refreshable
          },
          generation: {
            ...(generation?.connection ? { connection: generation.connection } : {}),
            ...(generation?.adapter ? { adapter: generation.adapter } : {}),
            requests: (generation?.requests ?? []).map((request) => ({
              id: request.id,
              prompt: request.prompt,
              model: request.model,
              operation: request.operation ?? "video",
              outputKind: generationRequestOutputKind(request),
              duration: request.duration,
              aspect: request.aspect,
              inputMode: generationRequestMode(request)
                ?? (request.first_frame || request.reference_images?.length
                  ? "image-to-video"
                  : "text-to-video"),
              hasFirstFrame: Boolean(request.first_frame),
              referenceImageCount: request.reference_images?.length ?? 0
            }))
          },
          audio: audio
            ? {
                ...(audio.connection ? { connection: audio.connection } : {}),
                ...(audio.adapter ? { adapter: audio.adapter } : {}),
                tracks: [
                  ...(audio.bgm
                    ? [{
                        id: audio.bgm.id,
                        kind: "music",
                        prompt: audio.bgm.prompt,
                        start: audio.bgm.start,
                        ...(audio.bgm.end !== undefined ? { end: audio.bgm.end } : {})
                      }]
                    : []),
                  ...audio.sfx.map((request) => ({
                    id: request.id,
                    kind: "sound-effect",
                    prompt: request.prompt,
                    start: request.start,
                    ...(request.end !== undefined ? { end: request.end } : {})
                  }))
                ]
              }
            : undefined,
          connections: connectionSummaries,
          issues: record.public.issues
        }
      });
      return;
    }

    const generationConnectionMatch = /^\/api\/projects\/([^/]+)\/generation-connection$/.exec(requestUrl.pathname);
    if (method === "POST" && generationConnectionMatch) {
      if (request.headers.origin !== launcherOrigin || request.headers["x-tsugite-token"] !== token) {
        sendJson(response, 403, {
          ok: false,
          issue: { code: "viewer_launcher.forbidden", message: "Launcher request was not authorized" }
        });
        return;
      }
      const record = projects.get(generationConnectionMatch[1]!);
      if (!record?.identity || !record.project?.generation || !record.public.valid) return sendNotFound(response);
      if (record.readOnly) {
        sendJson(response, 403, {
          ok: false,
          issue: {
            code: "viewer_launcher.worktree_read_only",
            message: "別worktreeの案件はこのランチャーから変更できません"
          }
        });
        return;
      }
      if (!["planned", "dry_run", "awaiting_gate_1"].includes(record.public.status)) {
        sendJson(response, 409, {
          ok: false,
          issue: { code: "generation.connection_locked", message: "Generation connection can only change before Gate 1 approval" }
        });
        return;
      }
      let input: z.infer<typeof generationConnectionSchema>;
      try {
        input = generationConnectionSchema.parse(await readJsonRequest(request, LAUNCHER_GENERATION_BODY_MAX_BYTES));
      } catch {
        sendJson(response, 400, {
          ok: false,
          issue: { code: "generation.connection_invalid", message: "Generation connection selection was invalid" }
        });
        return;
      }
      if (!await matchesProjectIdentity(record.configPath, record.identity)) {
        sendProjectChanged(response);
        return;
      }
      const connections = await listConnectionOptions();
      const selected = connections.find((connection) => connection.id === input.connection);
      const capabilities = record.project.generation.requests.map(generationRequestCapability);
      if (
        !selected?.adapter
        || selected.implementation_status !== "integrated"
        || connectionExecutionMode(selected) !== "pipeline-adapter"
        || capabilities.some((capability) => !selected.automated_capabilities.includes(capability))
      ) {
        sendJson(response, 422, {
          ok: false,
          issue: { code: "generation.connection_incompatible", message: "Selected connection does not automate every project generation request" }
        });
        return;
      }
      const updated = await writeProjectGenerationConnection(record.configPath, record.identity, selected.id, selected.adapter);
      if (!updated) {
        sendProjectChanged(response);
        return;
      }
      await reloadProjects();
      sendJson(response, 200, {
        ok: true,
        connection: selected.id,
        adapter: selected.adapter,
        requiresReview: true
      });
      return;
    }

    const generationRunMatch = /^\/api\/projects\/([^/]+)\/generate$/.exec(requestUrl.pathname);
    if (method === "POST" && generationRunMatch) {
      if (request.headers.origin !== launcherOrigin || request.headers["x-tsugite-token"] !== token) {
        sendJson(response, 403, {
          ok: false,
          issue: { code: "viewer_launcher.forbidden", message: "Launcher request was not authorized" }
        });
        return;
      }
      const projectId = generationRunMatch[1]!;
      const record = projects.get(projectId);
      if (!record?.identity || !record.project?.generation || !record.public.valid) return sendNotFound(response);
      if (record.readOnly) {
        sendJson(response, 403, {
          ok: false,
          issue: {
            code: "viewer_launcher.worktree_read_only",
            message: "別worktreeの案件はこのランチャーから変更できません"
          }
        });
        return;
      }
      if (record.public.status !== "running") {
        sendJson(response, 409, {
          ok: false,
          issue: { code: "run.requires_gate_1_approval", message: "Gate 1 must be approved before generation" }
        });
        return;
      }
      if (generating.has(projectId)) {
        sendJson(response, 409, {
          ok: false,
          issue: { code: "generation.in_progress", message: "This project is already generating media" }
        });
        return;
      }
      if (!await matchesProjectIdentity(record.configPath, record.identity)) {
        sendProjectChanged(response);
        return;
      }
      generating.add(projectId);
      try {
        const payload = options.runGeneration
          ? await options.runGeneration(record.configPath)
          : await runProjectGeneration(record.configPath);
        await reloadProjects();
        sendJson(response, 200, { ok: true, result: payload });
      } catch (error) {
        const output = error && typeof error === "object"
          ? String((error as { stderr?: string; stdout?: string }).stderr
            ?? (error as { stdout?: string }).stdout
            ?? "")
          : "";
        let issue = { code: "generation.failed", message: "Generation could not be completed" };
        try {
          const parsed = JSON.parse(output) as { issues?: Array<{ code?: string; message?: string }> };
          issue = {
            code: parsed.issues?.[0]?.code ?? issue.code,
            message: parsed.issues?.[0]?.message ?? issue.message
          };
        } catch { /* keep the sanitized issue */ }
        sendJson(response, 422, { ok: false, issue });
      } finally {
        generating.delete(projectId);
      }
      return;
    }

    const projectStatusMatch = /^\/api\/projects\/([^/]+)\/status$/.exec(requestUrl.pathname);
    if (method === "GET" && projectStatusMatch) {
      if (request.headers["x-tsugite-token"] !== token) {
        sendJson(response, 403, {
          ok: false,
          issue: { code: "viewer_launcher.forbidden", message: "Launcher request was not authorized" }
        });
        return;
      }
      const record = projects.get(projectStatusMatch[1]!);
      if (!record) return sendNotFound(response);
      const inspected = await inspectProject(
        record.name,
        record.configPath,
        record.id,
        artifactOrigin,
        launcherOrigin,
        viewerSnapshots.get(record.id),
        options.validationOptions,
        record.readOnly
      );
      preserveViewerEvidenceRequirement(record, inspected);
      inspected.public = withLauncherJob(inspected.public, jobs.get(record.id));
      projects.set(record.id, inspected);
      sendJson(response, 200, {
        ok: true,
        project: inspected.public,
        job: jobs.get(record.id) ?? null
      });
      return;
    }

    const projectActionMatch = /^\/api\/projects\/([^/]+)\/action$/.exec(requestUrl.pathname);
    if (projectActionMatch && !allowProjectActions) return sendNotFound(response);
    if (method === "GET" && projectActionMatch) {
      if (request.headers["x-tsugite-token"] !== token) {
        sendJson(response, 403, {
          ok: false,
          issue: { code: "viewer_launcher.forbidden", message: "Launcher request was not authorized" }
        });
        return;
      }
      const record = projects.get(projectActionMatch[1]!);
      if (!record) return sendNotFound(response);
      sendJson(response, 200, { ok: true, job: jobs.get(record.id) ?? null });
      return;
    }

    if (method === "POST" && projectActionMatch) {
      if (
        request.headers.origin !== launcherOrigin
        || request.headers["x-tsugite-token"] !== token
      ) {
        sendJson(response, 403, {
          ok: false,
          issue: { code: "viewer_launcher.forbidden", message: "Launcher request was not authorized" }
        });
        return;
      }
      await reloadProjects();
      const record = projects.get(projectActionMatch[1]!);
      if (!record) return sendNotFound(response);
      let input: z.infer<typeof launcherActionSchema>;
      try {
        const parsed = launcherActionSchema.safeParse(
          await readJsonRequest(request, LAUNCHER_DECISION_BODY_MAX_BYTES)
        );
        if (!parsed.success) throw new Error("invalid action request");
        input = parsed.data;
      } catch {
        sendJson(response, 400, {
          ok: false,
          issue: {
            code: "viewer_launcher.action_invalid",
            message: "Project action request was invalid"
          }
        });
        return;
      }
      if (!record.identity || !record.public.valid) {
        sendJson(response, 422, {
          ok: false,
          issue: {
            code: "viewer_launcher.project_invalid",
            message: record.public.issue ?? "Project cannot be executed safely"
          }
        });
        return;
      }
      if (record.readOnly) {
        sendJson(response, 403, {
          ok: false,
          issue: {
            code: "viewer_launcher.worktree_read_only",
            message: "別worktreeの案件はこのランチャーから変更できません"
          }
        });
        return;
      }
      if (
        input.expectedRunId !== record.public.runId
        || input.revision !== record.public.revision
      ) {
        sendJson(response, 409, {
          ok: false,
          issue: {
            code: "viewer_launcher.project_stale",
            message: "Project state changed after it was displayed. Refresh before continuing."
          }
        });
        return;
      }
      const action = input.action;
      if (!await matchesProjectIdentity(record.configPath, record.identity)) {
        sendProjectChanged(response);
        return;
      }
      // Do not add an await between this final per-project check and reserving the job slot.
      // Concurrent POST handlers then serialize on the jobs map in the JavaScript turn queue.
      if (jobs.get(record.id)?.status === "running") {
        sendJson(response, 409, {
          ok: false,
          issue: {
            code: "viewer_launcher.job_in_progress",
            message: "This project already has a running job"
          }
        });
        return;
      }
      if (!record.public.availableActions.includes(action)) {
        sendJson(response, 422, {
          ok: false,
          issue: {
            code: "viewer_launcher.action_unavailable",
            message: "This action is not available for the current project state"
          }
        });
        return;
      }
      const job: LauncherJob = {
        id: randomBytes(16).toString("hex"),
        action,
        status: "running",
        startedAt: new Date().toISOString()
      };
      jobs.set(record.id, job);
      projects.set(record.id, {
        ...record,
        public: withLauncherJob(record.public, job)
      });
      sendJson(response, 202, { ok: true, job });
      void executeLauncherJob({
        record,
        job,
        executePipeline,
        inspectCurrent: () => inspectProject(
          record.name,
          record.configPath,
          record.id,
          artifactOrigin,
          launcherOrigin,
          viewerSnapshots.get(record.id),
          options.validationOptions
        ),
        onComplete: (completedJob) => jobs.set(record.id, completedJob)
      });
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/api/templates") {
      sendJson(response, 200, { ok: true, templates: await discoverTemplates(templatesDir) });
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/api/feedback") {
      await reloadProjects();
      const projectRecords = [...projects.values()];
      const visibleProjectRecords = projectRecords.slice(0, LAUNCHER_FEEDBACK_MAX_PROJECTS);
      const projectFeedback = [];
      const perProjectItemLimit = Math.max(
        1,
        Math.floor(
          (LAUNCHER_FEEDBACK_MAX_ITEMS - LAUNCHER_FEEDBACK_NOTICE_RESERVE)
          / Math.max(visibleProjectRecords.length, 1)
        )
      );
      let recordsWereLimited = false;
      let issuesWereLimited = false;
      for (const record of visibleProjectRecords) {
        const result = await readProjectFeedback(record.configPath);
        const reservedIssueSlots = result.issues.length > 0 && perProjectItemLimit > 1
          ? Math.max(1, Math.floor(perProjectItemLimit / 4))
          : 0;
        const entryLimit = perProjectItemLimit - reservedIssueSlots;
        const entries = selectRecentFeedbackEntries(result.entries, entryLimit);
        const issueLimit = Math.max(0, perProjectItemLimit - entries.length);
        const issues = issueLimit > 0 ? result.issues.slice(-issueLimit) : [];
        recordsWereLimited ||= result.entries.length > entries.length;
        issuesWereLimited ||= result.issues.length > issues.length;
        projectFeedback.push({
          projectId: record.id,
          projectName: record.name,
          runId: record.public.runId,
          entries,
          issues: issues.map((issue) => ({
            ...issue,
            ...(issue.path && isAbsolute(issue.path) ? { path: "feedback.jsonl" } : {})
          }))
        });
      }
      if (recordsWereLimited) projectFeedback.push({
        projectId: "launcher-record-limit",
        projectName: "ランチャー",
        entries: [],
        issues: [{
          code: "feedback.aggregate_record_limit",
          message: `各案件の最新記録を優先し、表示対象を合計${LAUNCHER_FEEDBACK_MAX_ITEMS}項目以内に制限しました`
        }]
      });
      if (issuesWereLimited) projectFeedback.push({
        projectId: "launcher-issue-limit",
        projectName: "ランチャー",
        entries: [],
        issues: [{
          code: "feedback.aggregate_issue_limit",
          message: `各案件の最新診断を優先し、表示対象を合計${LAUNCHER_FEEDBACK_MAX_ITEMS}項目以内に制限しました`
        }]
      });
      if (projectRecords.length > LAUNCHER_FEEDBACK_MAX_PROJECTS) {
        projectFeedback.push({
          projectId: "launcher-project-limit",
          projectName: "ランチャー",
          entries: [],
          issues: [{
            code: "feedback.aggregate_project_limit",
            message: `表示対象の案件を${LAUNCHER_FEEDBACK_MAX_PROJECTS}件に制限しました`
          }]
        });
      }
      sendJson(response, 200, {
        ok: true,
        feedback: boundLauncherFeedbackOutput(aggregateFeedback(projectFeedback))
      });
      return;
    }

    const promotionDecisionMatch = /^\/api\/feedback\/([^/]+)\/promotion-decision$/.exec(requestUrl.pathname);
    if (method === "POST" && promotionDecisionMatch) {
      if (
        request.headers.origin !== launcherOrigin ||
        request.headers["x-tsugite-token"] !== token
      ) {
        sendJson(response, 403, {
          ok: false,
          issue: { code: "viewer_launcher.forbidden", message: "Launcher request was not authorized" }
        });
        return;
      }
      const record = projects.get(promotionDecisionMatch[1]!);
      if (!record?.public.valid) return sendNotFound(response);
      if (record.readOnly) {
        sendJson(response, 403, {
          ok: false,
          issue: {
            code: "viewer_launcher.worktree_read_only",
            message: "別worktreeの案件はこのランチャーから変更できません"
          }
        });
        return;
      }
      let input: z.infer<typeof promotionDecisionSchema>;
      try {
        const parsed = promotionDecisionSchema.safeParse(await readJsonRequest(request, LAUNCHER_DECISION_BODY_MAX_BYTES));
        if (!parsed.success) {
          sendJson(response, 400, {
            ok: false,
            issue: { code: "feedback.decision_invalid", message: "Promotion decision request was invalid" }
          });
          return;
        }
        input = parsed.data;
      } catch {
        sendJson(response, 400, {
          ok: false,
          issue: { code: "feedback.decision_invalid", message: "Promotion decision request was invalid" }
        });
        return;
      }
      if (
        !record.identity
        || !record.feedbackIdentity
        || !await matchesProjectIdentity(record.configPath, record.identity)
      ) {
        sendProjectChanged(response);
        return;
      }
      try {
        await decideProjectFeedbackPromotion(record.configPath, input, {
          expectedFileIdentity: record.feedbackIdentity
        });
        sendJson(response, 200, { ok: true, decision: input.decision });
      } catch (error) {
        const issue = error instanceof Error && "issues" in error
          ? (error as { issues?: Array<{ code?: string; message?: string }> }).issues?.[0]
          : undefined;
        sendJson(response, issue?.code === "feedback.proposal_already_decided" ? 409 : 422, {
          ok: false,
          issue: {
            code: issue?.code ?? "feedback.decision_failed",
            message: issue?.message ?? "Promotion decision could not be recorded"
          }
        });
      }
      return;
    }

    const refreshMatch = /^\/api\/projects\/([^/]+)\/refresh$/.exec(requestUrl.pathname);
    if (method === "POST" && refreshMatch) {
      if (
        request.headers.origin !== launcherOrigin ||
        request.headers["x-tsugite-token"] !== token
      ) {
        sendJson(response, 403, {
          ok: false,
          issue: { code: "viewer_launcher.forbidden", message: "Launcher request was not authorized" }
        });
        return;
      }
      const projectId = refreshMatch[1]!;
      const record = projects.get(projectId);
      if (!record) return sendNotFound(response);
      if (
        !record.identity
        || !record.project
        || !record.public.valid
        || !record.public.refreshable
      ) {
        sendJson(response, 422, {
          ok: false,
          issue: {
            code: "viewer_launcher.project_invalid",
            message: record.public.issue ?? "Project cannot be refreshed safely"
          }
        });
        return;
      }
      if (!await matchesProjectIdentity(record.configPath, record.identity)) {
        sendProjectChanged(response);
        return;
      }
      if (refreshing.has(projectId)) {
        sendJson(response, 409, {
          ok: false,
          issue: {
            code: "viewer_launcher.refresh_in_progress",
            message: "This project is already being refreshed"
          }
        });
        return;
      }
      refreshing.add(projectId);
      try {
        await options.beforeRefresh?.(record.public);
        if (!await matchesProjectIdentity(record.configPath, record.identity)) {
          sendProjectChanged(response);
          return;
        }
        const validation = await validateProject(record.configPath, options.validationOptions);
        if (
          !validation.project
          || !validation.manifest
          || !validation.issues.every(isExecutionCapabilityIssue)
        ) {
          sendJson(response, 422, {
            ok: false,
            issue: {
              code: "viewer_launcher.project_invalid",
              message: validation.issues[0]?.message ?? "Project validation failed"
            }
          });
          return;
        }
        if (!await matchesProjectIdentity(record.configPath, record.identity)) {
          sendProjectChanged(response);
          return;
        }
        const plan = createPlan(
          validation.project!,
          validation.manifest!,
          validation.adapter,
          validation.analysisAdapters ?? validation.analysisAdapter,
          validation.promptGuides,
          validation.audioAdapter,
          validation.generationConnection,
          validation.audioConnection,
          validation.backend
        );
        if (!await matchesProjectIdentity(record.configPath, record.identity)) {
          sendProjectChanged(response);
          return;
        }
        if (privateRoot && !await matchesDirectoryIdentity(privateRoot)) {
          sendPrivateRootChanged(response);
          return;
        }
        // Node does not expose a portable openat-style API that can bind an arbitrary writer to
        // the verified project directory handle. Bracket the writer with identity checks so a
        // raced replacement never becomes the launcher's accepted refreshed snapshot.
        const privateOutputDir = privateRoot
          ? join(privateRoot.path, `${projectId}-${randomBytes(12).toString("hex")}`)
          : undefined;
        const viewer = await writer({
          configPath: record.configPath,
          project: validation.project!,
          plan,
          bundleDir,
          ...(privateOutputDir ? { outputDir: privateOutputDir } : {})
        });
        if (!await matchesProjectIdentity(record.configPath, record.identity)) {
          sendProjectChanged(response);
          return;
        }
        if (
          privateRoot
          && (
            !await matchesDirectoryIdentity(privateRoot)
            || resolve(viewer.outputDir) !== resolve(privateOutputDir!)
          )
        ) {
          sendPrivateRootChanged(response);
          return;
        }
        const snapshot: LauncherViewerSnapshot = {
          outputDir: viewer.outputDir,
          root: privateRoot ?? projectDirectoryIdentity(record.configPath, record.identity)
        };
        const refreshedRecord = await inspectProject(
          record.name,
          record.configPath,
          record.id,
          artifactOrigin,
          launcherOrigin,
          snapshot,
          options.validationOptions,
          record.readOnly
        );
        if (!refreshedRecord.outputDir || !refreshedRecord.viewerRoot) {
          sendJson(response, 422, {
            ok: false,
            issue: {
              code: "viewer_launcher.snapshot_invalid",
              message: refreshedRecord.public.issue ?? "Viewer snapshot could not be accepted safely"
            }
          });
          return;
        }
        viewerSnapshots.set(projectId, snapshot);
        projects.set(projectId, refreshedRecord);
        const viewerUrl = createViewerUrl(artifactOrigin, launcherOrigin, projectId);
        sendJson(response, 200, {
          ok: true,
          viewerUrl,
          project: { ...refreshedRecord.public, hasViewer: true, viewerUrl }
        });
      } finally {
        refreshing.delete(projectId);
      }
      return;
    }

    sendNotFound(response);
  }

  async function handleArtifactRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    setArtifactHeaders(response);
    if (artifactOrigin && request.headers.host !== new URL(artifactOrigin).host) {
      sendJson(response, 403, {
        ok: false,
        issue: { code: "viewer_launcher.forbidden", message: "Artifact request was not authorized" }
      });
      return;
    }
    const requestUrl = new URL(request.url ?? "/", artifactOrigin || `http://${LOOPBACK_HOST}`);
    const method = request.method ?? "GET";

    const viewerMatch = /^\/viewer\/([^/]+)(?:\/(.*))?$/.exec(requestUrl.pathname);
    if ((method === "GET" || method === "HEAD") && viewerMatch) {
      const record = projects.get(viewerMatch[1]!);
      if (
        !record?.outputDir
        || !record.viewerRoot
        || !record.identity
        || !await matchesProjectIdentity(record.configPath, record.identity)
        || !await matchesDirectoryIdentity(record.viewerRoot)
      ) return sendNotFound(response);
      const relativePath = viewerMatch[2] || "index.html";
      const file = await openContainedStaticFile(
        record.outputDir,
        relativePath,
        record.viewerRoot.realPath
      );
      if (!file) return sendNotFound(response);
      let handedToFileServer = false;
      try {
        await beforeServeArtifact(file);
        if (!await validateViewerArtifactRequest(
          requestUrl,
          record,
          file,
          options.onSnapshotFingerprint,
          options.onReviewFingerprint
        )) return sendNotFound(response);
        const servedReference = relative(await realpath(record.outputDir), file.path).replaceAll("\\", "/");
        if (servedReference.startsWith("review/")) {
          response.setHeader("content-security-policy", REVIEW_PREVIEW_CSP);
        }
        handedToFileServer = true;
        return serveFile(request, response, file);
      } finally {
        if (!handedToFileServer) await file.handle.close();
      }
    }

    sendNotFound(response);
  }

  async function beforeServeArtifact(file: OpenedStaticFile): Promise<void> {
    await options.beforeServeArtifact?.(file.path);
  }

  try {
    const artifactPort = await listenServer(artifactServer, 0);
    artifactOrigin = `http://${LOOPBACK_HOST}:${artifactPort}`;
    const launcherPort = await listenServer(launcherServer, requestedPort);
    launcherOrigin = `http://${LOOPBACK_HOST}:${launcherPort}`;
    const initialProjects = await reloadProjects();
    let cleanupPromise: Promise<void> | undefined;
    const cleanupPrivateRoot = (): Promise<void> => {
      cleanupPromise ??= cleanupLauncherPrivateRoot(privateRoot);
      return cleanupPromise;
    };
    const closed = Promise.all([launcherClosed, artifactClosed])
      .then(cleanupPrivateRoot);
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing = true;
      closePromise ??= Promise.all([
        closeServer(launcherServer),
        closeServer(artifactServer)
      ]).then(cleanupPrivateRoot);
      return closePromise;
    };

    return {
      url: launcherOrigin,
      artifactUrl: artifactOrigin,
      port: launcherPort,
      token,
      projectCount: initialProjects.length,
      hasActive: () => activeMutations > 0
        || generating.size > 0
        || refreshing.size > 0
        || [...jobs.values()].some((job) => job.status === "running"),
      hasBlockingWork: () => activeBlockingMutations > 0,
      suspendWork: () => {
        workPauseCount += 1;
        let resumed = false;
        return () => {
          if (resumed) return;
          resumed = true;
          if (!closing) workPauseCount = Math.max(0, workPauseCount - 1);
        };
      },
      ...(privateRoot ? { privateRoot: privateRoot.path } : {}),
      closed,
      close
    };
  } catch (error) {
    await Promise.allSettled([
      closeServer(launcherServer),
      closeServer(artifactServer)
    ]);
    await cleanupLauncherPrivateRoot(privateRoot);
    throw error;
  }
}

async function executeLauncherJob(input: {
  record: LauncherProjectRecord;
  job: LauncherJob;
  executePipeline: LauncherProcessRunner;
  inspectCurrent: () => Promise<LauncherProjectRecord>;
  onComplete: (job: LauncherJob) => void;
}): Promise<void> {
  let completedJob: LauncherJob;
  let runLock: RunLock | undefined;
  try {
    const expectedIdentity = input.record.identity;
    if (!expectedIdentity) throw new Error("Project files changed before the action started");
    if (requiresLauncherMutationLock(input.job.action)) {
      if (!input.record.project) throw new Error("Project metadata is unavailable");
      runLock = await acquireRunLock(
        resolve(dirname(input.record.configPath), input.record.project.dist_dir),
        input.record.public.runId
      );
    }
    const current = await input.inspectCurrent();
    if (
      !current.identity
      || current.public.revision !== input.record.public.revision
      || current.public.runId !== input.record.public.runId
      || !current.public.availableActions.includes(input.job.action)
      || !await matchesProjectIdentity(input.record.configPath, expectedIdentity)
    ) throw new Error("Project files changed before the action started");
    const actionInputDigest = await digestLauncherActionInputs(input.record);
    if (!actionInputDigest) throw new Error("Project inputs could not be fingerprinted");
    const result = await input.executePipeline(
      process.execPath,
      [PIPELINE_ENTRY, ...launcherPipelineArgs(input.record.configPath, input.job.action)],
      {
        cwd: TSUGITE_ROOT,
        ...launcherJobEnvironment(input.record, input.job.action, runLock)
      }
    );
    if (
      !await matchesProjectIdentity(input.record.configPath, expectedIdentity)
      || await digestLauncherActionInputs(input.record) !== actionInputDigest
    ) {
      throw new Error("Project files changed while the action was running");
    }
    completedJob = {
      ...input.job,
      status: result.exitCode === 0 ? "succeeded" : "failed",
      completedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      stdout: sanitizeLauncherJobOutput(result.stdout, input.record),
      stderr: sanitizeLauncherJobOutput(result.stderr, input.record)
    };
  } catch (error) {
    completedJob = {
      ...input.job,
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: 1,
      stdout: "",
      stderr: sanitizeLauncherJobOutput(
        error instanceof Error ? error.message : "Pipeline action failed",
        input.record
      )
    };
  } finally {
    await runLock?.release();
  }
  input.onComplete(completedJob);
}

function requiresLauncherMutationLock(action: LauncherAction): boolean {
  return action === "review"
    || action === "run"
    || action === "render"
    || action.startsWith("gate-");
}

async function digestLauncherActionInputs(record: LauncherProjectRecord): Promise<string | undefined> {
  if (!record.project) return undefined;
  return digestRegularFiles([
    record.configPath,
    resolve(dirname(record.configPath), record.project.manifest)
  ]);
}

function launcherJobEnvironment(
  record: LauncherProjectRecord,
  action: LauncherAction,
  runLock: RunLock | undefined
): { env?: NodeJS.ProcessEnv } {
  const expectedApprovalDigest = action === "gate-1-approve"
    || action === "gate-2-approve-all"
    || action === "gate-3-approve"
    ? record.approvalDigests?.[action]
    : undefined;
  if (!runLock && !expectedApprovalDigest) return {};
  return {
    env: {
      ...process.env,
      ...(runLock ? { [RUN_LOCK_INHERIT_ENV]: runLock.token } : {}),
      ...(expectedApprovalDigest
        ? { [LAUNCHER_EXPECTED_APPROVAL_DIGEST_ENV]: expectedApprovalDigest }
        : {})
    }
  };
}

export function launcherPipelineArgs(configPath: string, action: LauncherAction): string[] {
  const common = ["--config", configPath];
  if (action === "validate") return ["validate", ...common, "--json"];
  if (action === "plan") return ["plan", ...common, "--json"];
  if (action === "review") return ["review", ...common, "--json"];
  if (action === "dry-run") return ["run", ...common, "--dry-run", "--json"];
  if (action === "run" || action === "render") {
    return [action, ...common, "--actor", "coordinator", "--json"];
  }
  const gateActions: Record<Exclude<LauncherAction,
    "validate" | "plan" | "review" | "dry-run" | "run" | "render"
  >, { gate: "gate-1" | "gate-2" | "gate-3"; decision: string }> = {
    "gate-1-approve": { gate: "gate-1", decision: "approve" },
    "gate-1-revise": { gate: "gate-1", decision: "revise" },
    "gate-1-abort": { gate: "gate-1", decision: "abort" },
    "gate-2-approve-all": { gate: "gate-2", decision: "approve_all" },
    "gate-2-revise": { gate: "gate-2", decision: "revise" },
    "gate-2-abort": { gate: "gate-2", decision: "abort" },
    "gate-3-approve": { gate: "gate-3", decision: "approve" },
    "gate-3-re-render": { gate: "gate-3", decision: "re-render" },
    "gate-3-abort": { gate: "gate-3", decision: "abort" }
  };
  const gateAction = gateActions[action];
  return [
    "gate",
    ...common,
    "--actor", "coordinator",
    "--gate", gateAction.gate,
    "--decision", gateAction.decision,
    "--json"
  ];
}

function sanitizeLauncherJobOutput(output: string, record: LauncherProjectRecord): string {
  let sanitized = output;
  const replacements = [
    [record.configPath, "<project>/project.yaml"],
    [dirname(record.configPath), "<project>"],
    [TSUGITE_ROOT, "<tsugite>"],
    [homedir(), "<home>"]
  ] as const;
  for (const [sensitive, replacement] of replacements) {
    sanitized = sanitized.replaceAll(sensitive, replacement);
    sanitized = sanitized.replaceAll(sensitive.replaceAll("\\", "/"), replacement);
  }
  sanitized = sanitized
    .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, "<redacted-private-key>")
    .replace(/(authorization\s*[=:]\s*["']?(?:basic|bearer)\s+)[^\s,"'}]+/gi, "$1<redacted>")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1<redacted>")
    .replace(/(["']?(?:api[_-]?key|token|secret|password|authorization)["']?\s*[=:]\s*["']?)[^\s,"'}]+/gi, "$1<redacted>")
    .replace(/((?:[A-Z0-9_]*(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL)[A-Z0-9_]*)\s*[=:]\s*["']?)[^\s,"'}]+/gi, "$1<redacted>")
    .replace(/(["']?(?:cookie|set-cookie|session(?:id|_id)?|csrf(?:_token)?)["']?\s*[=:]\s*["']?)[^\r\n,"'}]+/gi, "$1<redacted>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1<redacted>@")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted>");
  return boundUtf8(sanitized, LAUNCHER_JOB_OUTPUT_MAX_BYTES);
}

function boundUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  const suffix = Buffer.from("\n[output truncated]\n");
  return Buffer.concat([
    bytes.subarray(0, Math.max(0, maximumBytes - suffix.length)),
    suffix
  ]).toString("utf8");
}

async function executePipelineProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<LauncherProcessResult> {
  return await new Promise<LauncherProcessResult>((resolveProcess, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const collect = (chunks: Buffer[], chunk: Buffer, currentBytes: number) => {
      const remaining = Math.max(0, LAUNCHER_JOB_OUTPUT_MAX_BYTES - currentBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return {
        bytes: currentBytes + Math.min(chunk.length, remaining),
        truncated: chunk.length > remaining
      };
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const result = collect(stdout, chunk, stdoutBytes);
      stdoutBytes = result.bytes;
      stdoutTruncated ||= result.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const result = collect(stderr, chunk, stderrBytes);
      stderrBytes = result.bytes;
      stderrTruncated ||= result.truncated;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const withTruncation = (chunks: Buffer[], truncated: boolean) => {
        const output = Buffer.concat(chunks).toString("utf8");
        return truncated ? `${output}\n[output truncated]\n` : output;
      };
      resolveProcess({
        exitCode: code ?? 1,
        stdout: withTruncation(stdout, stdoutTruncated),
        stderr: withTruncation(stderr, stderrTruncated)
      });
    });
  });
}

function selectRecentFeedbackEntries(entries: FeedbackRecord[], limit: number): FeedbackRecord[] {
  if (limit <= 0) return [];
  if (entries.length <= limit) return entries;

  const indicesByKey = new Map<string, number[]>();
  for (const [index, entry] of entries.entries()) {
    const indices = indicesByKey.get(entry.key) ?? [];
    indices.push(index);
    indicesByKey.set(entry.key, indices);
  }
  const newestFirst = (left: number, right: number) =>
    entries[right]!.created_at.localeCompare(entries[left]!.created_at) || right - left;
  const groups = [...indicesByKey.values()].sort((left, right) =>
    entries[[...right].sort(newestFirst)[0]!]!.created_at.localeCompare(
      entries[[...left].sort(newestFirst)[0]!]!.created_at
    )
  );
  const selected = new Set<number>();
  const add = (index: number | undefined): boolean => {
    if (index === undefined || selected.has(index)) return true;
    if (selected.size >= limit) return false;
    selected.add(index);
    return true;
  };

  const latestPendingProposals = groups.flatMap((indices) => {
    const latestProposal = [...indices]
      .sort(newestFirst)
      .find((index) => entries[index]!.promotion_proposal);
    return latestProposal !== undefined
      && entries[latestProposal]!.promotion_proposal?.decision === "pending"
      ? [latestProposal]
      : [];
  }).sort(newestFirst);
  for (const index of latestPendingProposals) {
    if (!add(index)) break;
  }

  for (const indices of groups) {
    if (selected.size >= limit) break;
    const orderedIndices = [...indices].sort(newestFirst);
    const latestPromotion = orderedIndices.find((index) => entries[index]!.stage === "promoted");
    const latestVerification = orderedIndices.find((index) => entries[index]!.stage === "verified");
    if (latestPromotion !== undefined) {
      add(latestPromotion);
      if (
        latestVerification !== undefined
        && entries[latestPromotion]!.created_at < entries[latestVerification]!.created_at
      ) add(latestVerification);
    }
    add(orderedIndices[0]);
  }
  for (const index of entries.map((_, itemIndex) => itemIndex).sort(newestFirst)) {
    if (selected.size >= limit) break;
    add(index);
  }
  return [...selected].sort((left, right) => left - right).map((index) => entries[index]!);
}

function boundLauncherFeedbackOutput(feedback: FeedbackAggregate): FeedbackAggregate {
  if (feedback.preferences.length + feedback.issues.length <= LAUNCHER_FEEDBACK_MAX_ITEMS) return feedback;

  const payloadLimit = LAUNCHER_FEEDBACK_MAX_ITEMS - 1;
  const prioritizedIssues = [...feedback.issues].sort((left, right) => {
    const leftLimit = left.code.startsWith("feedback.aggregate_") ? 0 : 1;
    const rightLimit = right.code.startsWith("feedback.aggregate_") ? 0 : 1;
    return leftLimit - rightLimit;
  });
  const reservedIssueSlots = Math.min(prioritizedIssues.length, Math.max(1, Math.floor(payloadLimit / 4)));
  const preferences = feedback.preferences.slice(0, payloadLimit - reservedIssueSlots);
  const issues = prioritizedIssues.slice(0, payloadLimit - preferences.length);
  issues.push({
    code: "feedback.aggregate_output_limit",
    message: `好み・学びと診断の表示を合計${LAUNCHER_FEEDBACK_MAX_ITEMS}項目に制限しました`,
    projectId: "launcher-output-limit",
    projectName: "ランチャー"
  });
  const metrics = preferences.reduce<FeedbackAggregate["metrics"]>((result, preference) => {
    const rank = { observed: 0, recurring: 1, promoted: 2, verified: 3 }[preference.stage];
    result.observed += 1;
    if (rank >= 1) result.recurring += 1;
    if (rank >= 2) result.promoted += 1;
    if (rank >= 3) result.verified += 1;
    return result;
  }, { observed: 0, recurring: 0, promoted: 0, verified: 0, issues: issues.length });
  return { metrics, preferences, issues };
}

export async function openWorkflowViewerLauncher(url: string): Promise<void> {
  const target = getWorkflowViewerOpenCommand(url);
  await promisify(execFile)(target.command, target.args);
}

async function discoverLauncherProjectDirectories(
  projectsDir?: string,
  additionalProjectsDirs: string[] = []
): Promise<LauncherProjectDirectory[]> {
  if (projectsDir) {
    return appendReadOnlyProjectDirectories(
      [{ path: resolve(projectsDir), readOnly: false }],
      additionalProjectsDirs
    );
  }

  const primaryWorkspace = resolve(TSUGITE_ROOT);
  const directories: LauncherProjectDirectory[] = [{
    path: join(primaryWorkspace, "projects"),
    readOnly: false
  }];
  const knownWorktrees = new Set([primaryWorkspace]);
  try {
    const { stdout } = await promisify(execFile)("git", ["worktree", "list", "--porcelain"], {
      cwd: primaryWorkspace
    });
    for (const line of String(stdout).split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      const worktreePath = line.slice("worktree ".length);
      if (!isAbsolute(worktreePath)) continue;
      const workspace = resolve(worktreePath);
      if (knownWorktrees.has(workspace)) continue;
      knownWorktrees.add(workspace);
      directories.push({ path: join(workspace, "projects"), readOnly: true });
    }
  } catch {
    // Git metadata is optional for the launcher. The current workspace remains available.
  }
  return appendReadOnlyProjectDirectories(directories, additionalProjectsDirs);
}

function appendReadOnlyProjectDirectories(
  directories: LauncherProjectDirectory[],
  additionalProjectsDirs: string[]
): LauncherProjectDirectory[] {
  const knownDirectories = new Set(directories.map((directory) => directory.path));
  for (const additionalProjectsDir of additionalProjectsDirs) {
    const path = resolve(additionalProjectsDir);
    if (knownDirectories.has(path)) continue;
    knownDirectories.add(path);
    directories.push({ path, readOnly: true });
  }
  return directories;
}

async function discoverProjects(
  projectDirectories: LauncherProjectDirectory[],
  idsByConfig: Map<string, string>,
  artifactOrigin: string,
  launcherOrigin: string,
  viewerSnapshots: Map<string, LauncherViewerSnapshot>,
  validationOptions?: ValidateProjectOptions
): Promise<LauncherProjectRecord[]> {
  const projects: LauncherProjectRecord[] = [];
  for (const projectDirectory of projectDirectories) {
    let entries;
    try {
      entries = await readdir(projectDirectory.path, { withFileTypes: true });
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const projectDir = join(projectDirectory.path, entry.name);
      const configEntries = await readdir(projectDir, { withFileTypes: true });
      if (!configEntries.some((candidate) => candidate.isFile() && candidate.name === "project.yaml")) {
        continue;
      }
      const candidates = await Promise.all(
        configEntries
          .filter((candidate) => candidate.isFile() && isProjectConfigName(candidate.name))
          .map(async (candidate) => {
            const configPath = join(projectDir, candidate.name);
            const id = idsByConfig.get(configPath) ?? randomBytes(16).toString("hex");
            idsByConfig.set(configPath, id);
            return await inspectProject(
              entry.name,
              configPath,
              id,
              artifactOrigin,
              launcherOrigin,
              viewerSnapshots.get(id),
              validationOptions,
              projectDirectory.readOnly
            );
          })
      );
      const latest = selectLatestProjectRecord(candidates);
      if (latest) projects.push(latest);
    }
  }
  return projects;
}

function isProjectConfigName(name: string): boolean {
  return /^project(?:[.-][A-Za-z0-9][A-Za-z0-9._-]*)?\.ya?ml$/.test(name);
}

function selectLatestProjectRecord(
  candidates: LauncherProjectRecord[]
): LauncherProjectRecord | undefined {
  return candidates.sort((left, right) => {
    const activityDifference = projectActivityMs(right) - projectActivityMs(left);
    if (activityDifference !== 0) return activityDifference;
    const canonicalDifference = Number(isCanonicalProject(right)) - Number(isCanonicalProject(left));
    if (canonicalDifference !== 0) return canonicalDifference;
    return left.configPath.localeCompare(right.configPath);
  })[0];
}

function projectActivityMs(record: LauncherProjectRecord): number {
  const stateUpdatedAtMs = record.public.updatedAt ? Date.parse(record.public.updatedAt) : Number.NaN;
  return Number.isFinite(stateUpdatedAtMs)
    ? Math.max(record.sourceModifiedAtMs, stateUpdatedAtMs)
    : record.sourceModifiedAtMs;
}

function isCanonicalProject(record: LauncherProjectRecord): boolean {
  return basename(record.configPath) === "project.yaml";
}

async function discoverTemplates(templatesDir: string): Promise<LauncherTemplate[]> {
  let entries;
  try {
    entries = await readdir(templatesDir, { withFileTypes: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw error;
  }

  const templates: LauncherTemplate[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const templateDir = join(templatesDir, entry.name);
    try {
      await lstat(join(templateDir, "template.yaml"));
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) continue;
      throw error;
    }
    templates.push(await inspectTemplate(entry.name, templateDir));
  }
  return templates;
}

async function inspectTemplate(id: string, templateDir: string): Promise<LauncherTemplate> {
  const metadataPath = join(templateDir, "template.yaml");
  try {
    if (!templateIdSchema.safeParse(id).success) {
      throw new TemplateMetadataError(
        "template_metadata.invalid_id",
        "テンプレートのフォルダ名は小文字英数字とハイフンで指定してください。"
      );
    }
    const metadataStats = await lstat(metadataPath);
    if (metadataStats.isSymbolicLink()) {
      throw new TemplateMetadataError(
        "template_metadata.symlink",
        "template.yamlにシンボリックリンクは使用できません。"
      );
    }
    if (!metadataStats.isFile()) {
      throw new TemplateMetadataError(
        "template_metadata.not_file",
        "template.yamlが通常ファイルではありません。"
      );
    }
    if (metadataStats.size > TEMPLATE_METADATA_MAX_BYTES) {
      throw new TemplateMetadataError(
        "template_metadata.too_large",
        "template.yamlが大きすぎます。64 KiB以下にしてください。"
      );
    }
    const metadataText = await readFile(metadataPath, "utf8");
    const metadata = templateMetadataSchema.parse(parse(metadataText, { maxAliasCount: 0 }));
    if (metadata.id !== id) {
      throw new TemplateMetadataError(
        "template_metadata.id_mismatch",
        "template.yamlのidをフォルダ名と一致させてください。"
      );
    }
    return {
      id,
      name: metadata.name,
      summary: metadata.summary,
      category: metadata.category,
      useCases: metadata.use_cases,
      duration: metadata.output.duration.label,
      aspectRatio: metadata.output.aspect_ratios.join(" / "),
      ...(metadata.output.speaker_count === undefined
        ? {}
        : { speakers: metadata.output.speaker_count }),
      requiredInputs: metadata.required_inputs
        .filter((input) => input.required)
        .map((input) => input.label),
      requiredInputDetails: metadata.required_inputs
        .filter((input) => input.required)
        .map((input) => ({ type: input.type, label: input.label })),
      preview: metadata.preview
        ? {
            frames: metadata.preview.frames.map((frame) => ({
              kind: frame.kind,
              label: frame.label
            })),
            flow: metadata.preview.flow
          }
        : null,
      notFor: metadata.not_for,
      variants: metadata.variants.map((variant) => ({
        id: variant.id,
        label: variant.label,
        ...(variant.default_option ? { defaultOptionId: variant.default_option } : {}),
        options: variant.options.map((option) => ({
          id: option.id,
          label: option.label,
          description: option.description
        }))
      })),
      tags: metadata.tags,
      audio: metadata.audio.notes,
      status: metadata.status,
      distribution: metadata.distribution,
      valid: true
    };
  } catch (error) {
    const issue = error instanceof TemplateMetadataError
      ? { code: error.code, message: error.message }
      : {
          code: "template_metadata.invalid",
          message: "template.yamlの形式が正しくありません。必須項目と値を確認してください。"
        };
    return invalidTemplate(id, issue);
  }
}

function invalidTemplate(
  id: string,
  issue: { code: string; message: string }
): LauncherTemplate {
  return {
    id,
    name: id,
    summary: "",
    category: "",
    useCases: [],
    duration: "",
    aspectRatio: "",
    requiredInputs: [],
    requiredInputDetails: [],
    preview: null,
    notFor: [],
    variants: [],
    tags: [],
    audio: "",
    status: "unknown",
    distribution: "unknown",
    valid: false,
    issue
  };
}

async function inspectProject(
  name: string,
  configPath: string,
  id: string,
  artifactOrigin: string,
  launcherOrigin: string,
  knownSnapshot?: LauncherViewerSnapshot,
  validationOptions?: ValidateProjectOptions,
  readOnly = false
): Promise<LauncherProjectRecord> {
  let sourceModifiedAtMs = 0;
  try {
    const captured = await captureProjectIdentity(configPath);
    const feedbackIdentity = await captureFeedbackFileIdentity(configPath);
    sourceModifiedAtMs = captured.sourceModifiedAtMs;
    const configDigest = createHash("sha256").update(await readFile(configPath)).digest("hex");
    const project = await loadProject(configPath);
    const runId = project.run_id ?? project.slug;
    const projectDir = dirname(configPath);
    const runDir = join(projectDir, project.dist_dir, runId);
    let outputDir: string | undefined = knownSnapshot?.outputDir ?? join(runDir, "viewer");
    let viewerRoot: LauncherDirectoryIdentity | undefined = knownSnapshot?.root
      ?? projectDirectoryIdentity(configPath, captured.identity);
    if (knownSnapshot) {
      await assertSafeViewerSnapshot(knownSnapshot);
    } else {
      try {
        await assertSafeProjectOutput(configPath, outputDir);
      } catch (error) {
        if (!await isSymbolicLink(outputDir)) throw error;
        await assertSafeProjectOutput(configPath, dirname(outputDir));
        outputDir = undefined;
        viewerRoot = undefined;
      }
    }
    const thumbnailPath = await findProjectThumbnail(projectDir, runDir);
    const statePath = join(runDir, "state.json");
    let status = "planned";
    let updatedAt: string | null = null;
    let state: RunState | undefined;
    let stateIssue: Issue | undefined;
    try {
      state = await readState(statePath);
      if (state.run_id !== runId) {
        throw new Error(`state run_id '${state.run_id}' does not match project run_id '${runId}'`);
      }
      status = state.status;
      updatedAt = state.updated_at;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        status = "error";
        stateIssue = {
          code: "viewer_launcher.state_invalid",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }
    const hasViewer = outputDir
      ? await isRegularFile(join(outputDir, "index.html"))
      : false;
    const viewerUrl = hasViewer ? createViewerUrl(artifactOrigin, launcherOrigin, id) : undefined;
    const thumbnailUrl = thumbnailPath ? `${launcherOrigin}/thumbnail/${id}` : undefined;
    const validation = await validateProject(configPath, validationOptions);
    const reviewInspection = validation.project && validation.manifest
      ? await inspectGate1Review({
          configPath,
          project: validation.project,
          manifest: validation.manifest
        })
      : undefined;
    let hasReview = reviewInspection?.ok === true;
    const gate1ApprovalCurrent = state?.gates.gate_1.status !== "approved"
      || Boolean(
        reviewInspection?.ok
        && reviewInspection.approvalDigest
        && state.gates.gate_1.approved_input_digest === reviewInspection.approvalDigest
      );
    const reviewAssetPaths = hasReview
      ? await listRegularFiles(join(runDir, "review", "assets"))
      : undefined;
    const [
      manifestDigest,
      reviewDigest,
      viewerReviewDigest,
      gate2Digest,
      gate3Digest
    ] = await Promise.all([
      digestRegularFiles([resolve(projectDir, project.manifest)]),
      hasReview && reviewAssetPaths
        ? digestRegularFiles([
            join(runDir, "review", "index.html"),
            join(runDir, "review", "review-data.json"),
            ...reviewAssetPaths
          ])
        : undefined,
      hasReview ? digestReviewAggregateCached(runDir) : undefined,
      digestRegularFiles([join(runDir, "gate2-qc.json")]),
      digestRegularFiles([
        join(runDir, "render-report.json"),
        join(runDir, "gate3-qc.json"),
        join(runDir, "final.mp4")
      ])
    ]);
    hasReview &&= reviewDigest !== undefined;
    let hasGate2Evidence = gate2Digest !== undefined;
    const hasGate3Evidence = gate3Digest !== undefined;
    let gate2ApprovalDigest: string | undefined;
    if (
      hasGate2Evidence
      && state?.gates.gate_2.status === "awaiting_approval"
      && validation.project
      && validation.manifest
    ) {
      const inspected = await inspectGate2RunForApproval(
        validation.project,
        validation.manifest,
        resolve(projectDir, project.dist_dir),
        validation.adapter,
        validation.project.edit.editorial && reviewInspection?.ok
          ? reviewInspection.compilation
          : undefined,
        validation.audioAdapter
      );
      if (inspected.ok) gate2ApprovalDigest = inspected.approvalDigest;
      else hasGate2Evidence = false;
    }
    const gate3ApprovalDigest = hasGate3Evidence
      ? await digestRegularFile(join(runDir, "final.mp4"))
      : undefined;
    const currentGate2Qc = gate2Digest !== undefined
      ? await inspectGate2QcSource(
        configPath,
        join(runDir, "gate2-qc.json"),
        captured.identity
      )
      : undefined;
    const gate2QcDigest = currentGate2Qc?.digest;
    const gate2SourceAssetsCurrent = currentGate2Qc?.assetsCurrent === true;
    const viewerReviewInspection = hasViewer && outputDir && viewerRoot
      ? await inspectViewerReviewLinks({
          outputDir,
          viewerRoot,
          currentReviewDigest: viewerReviewDigest,
          currentGate2QcDigest: gate2QcDigest,
          gate2SourceAssetsCurrent
        })
      : { evidenceStatus: "absent" as const };
    if (
      !await matchesProjectIdentity(configPath, captured.identity)
      || createHash("sha256").update(await readFile(configPath)).digest("hex") !== configDigest
    ) {
      throw new Error("Project config changed while it was being inspected");
    }
    const safetyIssues = validation.issues.filter(isProjectSafetyIssue);
    const issues = [
      ...safetyIssues,
      ...validation.issues.filter((issue) => !isProjectSafetyIssue(issue)),
      ...(stateIssue ? [stateIssue] : [])
    ].map(toPublicLauncherIssue);
    return {
      id,
      name,
      configPath,
      sourceModifiedAtMs,
      readOnly,
      identity: captured.identity,
      ...(feedbackIdentity ? { feedbackIdentity } : {}),
      project,
      ...(outputDir ? { outputDir } : {}),
      ...(viewerRoot ? { viewerRoot } : {}),
      ...(viewerReviewInspection.evidenceStatus === "valid" ? { evidenceExpected: true } : {}),
      ...(viewerReviewInspection.evidenceStatus === "invalid" ? { evidenceInvalid: true } : {}),
      thumbnailPath,
      approvalDigests: {
        ...(reviewInspection?.ok && reviewInspection.approvalDigest
          ? { "gate-1-approve": reviewInspection.approvalDigest }
          : {}),
        ...(gate2ApprovalDigest ? { "gate-2-approve-all": gate2ApprovalDigest } : {}),
        ...(gate3ApprovalDigest ? { "gate-3-approve": gate3ApprovalDigest } : {})
      },
      public: {
        id,
        name,
        slug: project.slug,
        runId,
        revision: createLauncherProjectRevision({
          configDigest,
          sourceModifiedAtMs,
          runId,
          state,
          manifestDigest,
          reviewDigest,
          reviewInputDigest: reviewInspection?.ok ? reviewInspection.approvalDigest : undefined,
          gate2Digest,
          gate3Digest
        }),
        status,
        updatedAt,
        hasViewer,
        ...(viewerUrl ? { viewerUrl } : {}),
        ...(viewerReviewInspection.gate1
          ? { gate1ReviewUrl: createGate1ReviewUrl(artifactOrigin, id) }
          : {}),
        ...(viewerReviewInspection.gate2
          ? { gate2ReviewUrl: createGate2ReviewUrl(artifactOrigin, launcherOrigin, id) }
          : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        valid: safetyIssues.length === 0,
        refreshable: validation.project !== undefined
          && validation.manifest !== undefined
          && validation.issues.every(isExecutionCapabilityIssue)
          && stateIssue === undefined,
        readOnly,
        workflowNodes: createLauncherWorkflowNodes({
          valid: safetyIssues.length === 0,
          validationOk: validation.issues.length === 0 && stateIssue === undefined,
          state,
          hasReview,
          gate1ApprovalCurrent,
          hasGate2Evidence,
          hasGate3Evidence,
          stateIssue
        }),
        availableActions: readOnly ? [] : createAvailableLauncherActions({
          valid: safetyIssues.length === 0,
          validationOk: validation.issues.length === 0 && stateIssue === undefined,
          state,
          hasReview,
          gate1ApprovalCurrent,
          hasGate2Evidence,
          hasGate3Evidence
        }),
        issues,
        ...(issues[0] ? { issue: issues[0].message } : {})
      }
    };
  } catch (error) {
    const issue = {
      code: "viewer_launcher.project_invalid",
      message: error instanceof Error ? error.message : String(error)
    };
    return {
      id,
      name,
      configPath,
      sourceModifiedAtMs,
      readOnly,
      public: {
        id,
        name,
        slug: name,
        runId: name,
        revision: createHash("sha256").update(`${id}:${sourceModifiedAtMs}:invalid`).digest("hex"),
        status: "error",
        updatedAt: null,
        hasViewer: false,
        valid: false,
        refreshable: false,
        readOnly,
        workflowNodes: createLauncherWorkflowNodes({ valid: false }),
        availableActions: [],
        issues: [issue],
        issue: issue.message
      }
    };
  }
}

type LauncherWorkflowContext = {
  valid: boolean;
  validationOk?: boolean;
  state?: RunState;
  hasReview?: boolean;
  gate1ApprovalCurrent?: boolean;
  hasGate2Evidence?: boolean;
  hasGate3Evidence?: boolean;
  stateIssue?: Issue;
};

function createLauncherProjectRevision(input: {
  configDigest: string;
  sourceModifiedAtMs: number;
  runId: string;
  state?: RunState;
  manifestDigest?: string;
  reviewDigest?: string;
  reviewInputDigest?: string;
  gate2Digest?: string;
  gate3Digest?: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    configDigest: input.configDigest,
    sourceModifiedAtMs: input.sourceModifiedAtMs,
    runId: input.runId,
    state: input.state ?? null,
    manifestDigest: input.manifestDigest ?? null,
    reviewDigest: input.reviewDigest ?? null,
    reviewInputDigest: input.reviewInputDigest ?? null,
    gate2Digest: input.gate2Digest ?? null,
    gate3Digest: input.gate3Digest ?? null
  })).digest("hex");
}

function createLauncherWorkflowNodes(context: LauncherWorkflowContext): LauncherWorkflowNode[] {
  const nodes: LauncherWorkflowNode[] = [
    { id: "validate", label: "検証", status: context.valid && context.validationOk ? "completed" : "error", action: "validate" },
    { id: "plan", label: "構成", status: "pending", action: "plan" },
    { id: "review", label: "レビュー", status: "pending", action: "review" },
    { id: "gate-1", label: "Gate 1", status: "pending", action: "gate-1-approve" },
    { id: "run", label: "素材生成", status: "pending", action: "run" },
    { id: "gate-2", label: "Gate 2", status: "pending", action: "gate-2-approve-all" },
    { id: "render", label: "編集・書き出し", status: "pending", action: "render" },
    { id: "gate-3", label: "Gate 3", status: "pending", action: "gate-3-approve" }
  ];
  if (!context.valid) return nodes;

  const setStatus = (id: LauncherWorkflowNode["id"], status: LauncherWorkflowNode["status"]) => {
    const node = nodes.find((candidate) => candidate.id === id);
    if (node) node.status = status;
  };
  if (context.state || context.hasReview) setStatus("plan", "completed");
  if (context.hasReview || (context.state && context.state.gates.gate_1.status !== "pending")) {
    setStatus("review", "completed");
  }
  if (context.stateIssue) setStatus("validate", "error");

  const state = context.state;
  if (!state) return nodes;
  for (const [gateId, nodeId] of [
    ["gate_1", "gate-1"],
    ["gate_2", "gate-2"],
    ["gate_3", "gate-3"]
  ] as const) {
    const gateStatus = state.gates[gateId].status;
    if (gateStatus === "approved") setStatus(nodeId, "completed");
    else if (gateStatus === "awaiting_approval") setStatus(nodeId, "waiting_approval");
    else if (gateStatus === "abort" || gateStatus === "revise") setStatus(nodeId, "error");
  }
  if (state.gates.gate_1.status === "approved" && !context.gate1ApprovalCurrent) {
    setStatus("gate-1", "error");
  }
  if (
    state.gates.gate_2.status === "awaiting_approval"
    || state.gates.gate_2.status === "approved"
    || state.gates.gate_2.status === "abort"
  ) {
    setStatus("run", "completed");
  }
  if (
    state.gates.gate_3.status === "awaiting_approval"
    || state.gates.gate_3.status === "approved"
    || state.gates.gate_3.status === "abort"
  ) {
    setStatus("render", "completed");
  }
  return nodes;
}

function createAvailableLauncherActions(context: LauncherWorkflowContext): LauncherAction[] {
  if (!context.valid || context.stateIssue) return [];
  if (!context.validationOk) return ["validate"];
  const actions: LauncherAction[] = ["validate", "plan", "review", "dry-run"];
  const state = context.state;
  const gate1Status = state?.gates.gate_1.status ?? "pending";
  if (context.hasReview && (gate1Status === "pending" || gate1Status === "revise")) {
    actions.push("gate-1-approve", "gate-1-revise", "gate-1-abort");
  } else if (gate1Status === "awaiting_approval") {
    if (context.hasReview) actions.push("gate-1-approve");
    actions.push("gate-1-revise", "gate-1-abort");
  } else if (gate1Status === "approved" && !context.gate1ApprovalCurrent) {
    actions.push("gate-1-revise");
  }
  if (
    state?.status === "running"
    && gate1Status === "approved"
    && context.gate1ApprovalCurrent
  ) actions.push("run");
  if (state?.gates.gate_2.status === "awaiting_approval") {
    if (context.hasGate2Evidence) actions.push("gate-2-approve-all");
    actions.push("gate-2-revise", "gate-2-abort");
  }
  if (state?.status === "rendering" && state.gates.gate_2.status === "approved") {
    actions.push("render");
  }
  if (state?.gates.gate_3.status === "awaiting_approval") {
    if (context.hasGate3Evidence) actions.push("gate-3-approve");
    actions.push("gate-3-re-render", "gate-3-abort");
  }
  return actions;
}

function withLauncherJob(project: LauncherProject, job: LauncherJob | undefined): LauncherProject {
  if (!job) return project;
  const nodeId = launcherActionNodeId(job.action);
  return {
    ...project,
    availableActions: job.status === "running" ? [] : project.availableActions,
    workflowNodes: project.workflowNodes.map((node) => node.id === nodeId
      && job.status !== "succeeded" ? {
          ...node,
          status: job.status === "running"
            ? "running"
            : "error"
        }
      : node)
  };
}

function launcherActionNodeId(action: LauncherAction): LauncherWorkflowNode["id"] {
  if (action.startsWith("gate-1-")) return "gate-1";
  if (action.startsWith("gate-2-")) return "gate-2";
  if (action.startsWith("gate-3-")) return "gate-3";
  if (action === "dry-run") return "run";
  if (action === "validate" || action === "plan" || action === "review" || action === "run" || action === "render") {
    return action;
  }
  return "validate";
}

function isProjectSafetyIssue(issue: Issue): boolean {
  return issue.code === "project.schema"
    || issue.code === "manifest.clip.src.local"
    || issue.code === "manifest.image.src.local"
    || issue.code.endsWith(".safe")
    || issue.code.endsWith(".symlink");
}

function isExecutionCapabilityIssue(issue: Issue): boolean {
  return VIEWER_REFRESH_CAPABILITY_ISSUES.has(issue.code);
}

function createViewerUrl(
  artifactOrigin: string,
  launcherOrigin: string,
  projectId: string
): string {
  const viewerUrl = new URL(`/viewer/${projectId}/`, artifactOrigin);
  viewerUrl.searchParams.set("launcher", launcherOrigin);
  return viewerUrl.toString();
}

function createGate1ReviewUrl(
  artifactOrigin: string,
  projectId: string
): string {
  return new URL(`/viewer/${projectId}/review/index.html`, artifactOrigin).toString();
}

function createGate2ReviewUrl(
  artifactOrigin: string,
  launcherOrigin: string,
  projectId: string
): string {
  const viewerUrl = new URL(createViewerUrl(artifactOrigin, launcherOrigin, projectId));
  viewerUrl.searchParams.set("node", "gate-2");
  return viewerUrl.toString();
}

type ViewerReviewLinks = {
  gate1?: true;
  gate2?: true;
};

type ViewerEvidence = z.infer<typeof viewerEvidenceSchema>;

type ViewerEvidenceRead =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; evidence: ViewerEvidence };

type ViewerReviewInspection = ViewerReviewLinks & {
  evidenceStatus: ViewerEvidenceRead["status"];
};

async function inspectGate2QcSource(
  configPath: string,
  gate2QcPath: string,
  identity: LauncherProjectIdentity
): Promise<{ digest: string; assetsCurrent: boolean } | undefined> {
  const projectDir = dirname(configPath);
  const qcReference = relative(projectDir, gate2QcPath);
  const qcFile = await openContainedStaticFile(
    projectDir,
    process.platform === "win32" ? qcReference.replaceAll("\\", "/") : qcReference,
    identity.realProjectDir
  );
  if (!qcFile || qcFile.stats.size > LAUNCHER_GATE2_QC_MAX_BYTES) {
    await qcFile?.handle.close();
    return undefined;
  }
  let qc: unknown;
  let rawQc: Buffer;
  try {
    rawQc = await readOpenedFileBounded(
      qcFile.handle,
      qcFile.stats,
      LAUNCHER_GATE2_QC_MAX_BYTES
    );
    qc = JSON.parse(rawQc.toString("utf8")) as unknown;
  } catch {
    return undefined;
  } finally {
    await qcFile.handle.close();
  }
  const digest = createHash("sha256").update(rawQc).digest("hex");
  if (typeof qc !== "object" || qc === null || Array.isArray(qc)) return undefined;
  const input = qc as Record<string, unknown>;
  if (typeof input.ok !== "boolean") return undefined;
  if (input.assets === undefined) return { digest, assetsCurrent: true };
  if (!Array.isArray(input.assets) || input.assets.length > LAUNCHER_GATE2_ASSET_LIMIT) {
    return { digest, assetsCurrent: false };
  }

  for (const asset of input.assets) {
    if (typeof asset !== "object" || asset === null || Array.isArray(asset)) {
      return { digest, assetsCurrent: false };
    }
    const record = asset as Record<string, unknown>;
    if (record.sha256 === undefined) {
      if (input.ok === false) continue;
      return { digest, assetsCurrent: false };
    }
    if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      return { digest, assetsCurrent: false };
    }
    const declaredPath = typeof record.path === "string"
      ? record.path
      : typeof record.src === "string"
        ? record.src
        : undefined;
    if (!declaredPath) return { digest, assetsCurrent: false };
    const candidate = isAbsolute(declaredPath)
      ? resolve(declaredPath)
      : resolve(projectDir, declaredPath);
    if (!isContained(projectDir, candidate)) return { digest, assetsCurrent: false };
    const assetReference = relative(projectDir, candidate);
    const file = await openContainedStaticFile(
      projectDir,
      process.platform === "win32" ? assetReference.replaceAll("\\", "/") : assetReference,
      identity.realProjectDir
    );
    if (!file) return { digest, assetsCurrent: false };
    try {
      const assetDigest = await digestGate2AssetCached(file.path, file.handle);
      if (assetDigest !== record.sha256) return { digest, assetsCurrent: false };
    } finally {
      await file.handle.close();
    }
  }
  return { digest, assetsCurrent: true };
}

async function digestGate2AssetCached(path: string, handle: FileHandle): Promise<string> {
  return digestOpenedFileCached(
    path,
    handle,
    gate2AssetDigestCache,
    LAUNCHER_GATE2_ASSET_DIGEST_CACHE_MAX_ENTRIES
  );
}

async function digestSnapshotArtifactCached(
  path: string,
  handle: FileHandle,
  onCacheMiss?: (path: string) => void | Promise<void>
): Promise<string> {
  return digestOpenedFileCached(
    path,
    handle,
    snapshotArtifactDigestCache,
    LAUNCHER_SNAPSHOT_DIGEST_CACHE_MAX_ENTRIES,
    onCacheMiss
  );
}

async function digestReviewAggregateCached(
  root: string,
  onCacheMiss?: (root: string) => void | Promise<void>
): Promise<string | undefined> {
  const cacheKey = resolve(root);
  const before = await captureReviewAggregateIdentity(cacheKey);
  if (!before) return undefined;
  const cached = reviewAggregateDigestCache.get(cacheKey);
  if (cached?.signature === before) return cached.digest;
  await onCacheMiss?.(cacheKey);
  const digest = await digestWorkflowViewerReview(cacheKey);
  if (!digest) return undefined;
  const after = await captureReviewAggregateIdentity(cacheKey);
  if (!after || after !== before) return undefined;
  reviewAggregateDigestCache.set(cacheKey, { signature: after, digest });
  if (reviewAggregateDigestCache.size > LAUNCHER_REVIEW_DIGEST_CACHE_MAX_ENTRIES) {
    const oldest = reviewAggregateDigestCache.keys().next().value as string | undefined;
    if (oldest) reviewAggregateDigestCache.delete(oldest);
  }
  return digest;
}

async function captureReviewAggregateIdentity(root: string): Promise<string | undefined> {
  try {
    const reviewDir = join(root, "review");
    const [rootStats, reviewStats, realRoot, realReviewDir] = await Promise.all([
      lstat(root, { bigint: true }),
      lstat(reviewDir, { bigint: true }),
      realpath(root),
      realpath(reviewDir)
    ]);
    if (
      !rootStats.isDirectory()
      || rootStats.isSymbolicLink()
      || !reviewStats.isDirectory()
      || reviewStats.isSymbolicLink()
      || !isContained(realRoot, realReviewDir)
    ) return undefined;

    const identities = [reviewIdentityPart("directory", "review", reviewStats)];
    let fileCount = 0;
    let totalBytes = 0n;
    let visitedEntries = 0;
    const addFile = async (source: string, reference: string): Promise<boolean> => {
      let handle: FileHandle | undefined;
      try {
        handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        const [openedStats, pathStats, realSource] = await Promise.all([
          handle.stat({ bigint: true }),
          lstat(source, { bigint: true }),
          realpath(source)
        ]);
        if (
          !openedStats.isFile()
          || pathStats.isSymbolicLink()
          || openedStats.dev !== pathStats.dev
          || openedStats.ino !== pathStats.ino
          || !isContained(realReviewDir, realSource)
        ) return false;
        const realStats = await lstat(realSource, { bigint: true });
        if (openedStats.dev !== realStats.dev || openedStats.ino !== realStats.ino) return false;
        fileCount += 1;
        totalBytes += openedStats.size;
        if (
          fileCount > LAUNCHER_REVIEW_FILE_LIMIT
          || totalBytes > BigInt(LAUNCHER_REVIEW_BYTE_LIMIT)
        ) return false;
        identities.push(reviewIdentityPart(
          "file",
          reference.replaceAll("\\", "/"),
          openedStats
        ));
        return true;
      } finally {
        await handle?.close();
      }
    };

    if (!await addFile(join(reviewDir, "index.html"), "index.html")) return undefined;
    const walkAssets = async (
      directory: string,
      reference: string,
      depth: number
    ): Promise<boolean> => {
      if (depth > LAUNCHER_REVIEW_DIRECTORY_DEPTH_LIMIT) return false;
      let directoryStats;
      try {
        directoryStats = await lstat(directory, { bigint: true });
      } catch (error) {
        if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) {
          return reference === "assets";
        }
        throw error;
      }
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return false;
      const realDirectory = await realpath(directory);
      if (!isContained(realReviewDir, realDirectory)) return false;
      identities.push(reviewIdentityPart("directory", reference, directoryStats));
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        visitedEntries += 1;
        if (visitedEntries > LAUNCHER_REVIEW_ENTRY_LIMIT) return false;
        if (entry.isSymbolicLink()) return false;
        const source = join(directory, entry.name);
        const childReference = `${reference}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!await walkAssets(source, childReference, depth + 1)) return false;
        } else if (entry.isFile()) {
          if (!await addFile(source, childReference)) return false;
        } else {
          return false;
        }
      }
      return true;
    };
    if (!await walkAssets(join(reviewDir, "assets"), "assets", 1)) return undefined;
    return identities.sort((left, right) => left.localeCompare(right)).join("\n");
  } catch {
    return undefined;
  }
}

function reviewIdentityPart(
  kind: "directory" | "file",
  reference: string,
  stats: BigIntStats
): string {
  return JSON.stringify([
    kind,
    reference,
    stats.dev.toString(),
    stats.ino.toString(),
    stats.size.toString(),
    stats.mtimeNs.toString(),
    stats.ctimeNs.toString()
  ]);
}

async function digestOpenedFileCached(
  path: string,
  handle: FileHandle,
  cache: Map<string, {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    digest: string;
  }>,
  maximumEntries: number,
  onCacheMiss?: (path: string) => void | Promise<void>
): Promise<string> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) throw new Error("Fingerprint target must be a regular file");
  const cached = cache.get(path);
  if (
    cached
    && cached.dev === before.dev
    && cached.ino === before.ino
    && cached.size === before.size
    && cached.mtimeNs === before.mtimeNs
    && cached.ctimeNs === before.ctimeNs
  ) return cached.digest;
  await onCacheMiss?.(path);
  const digest = createHash("sha256");
  const stream = handle.createReadStream({ start: 0, autoClose: false });
  for await (const chunk of stream) digest.update(chunk as Buffer);
  const after = await handle.stat({ bigint: true });
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
  ) throw new Error("File changed while it was being fingerprinted");
  const sha256 = digest.digest("hex");
  cache.set(path, {
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mtimeNs: after.mtimeNs,
    ctimeNs: after.ctimeNs,
    digest: sha256
  });
  if (cache.size > maximumEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) cache.delete(oldest);
  }
  return sha256;
}

async function inspectViewerReviewLinks(input: {
  outputDir: string;
  viewerRoot: LauncherDirectoryIdentity;
  currentReviewDigest?: string;
  currentGate2QcDigest?: string;
  gate2SourceAssetsCurrent: boolean;
}): Promise<ViewerReviewInspection> {
  const evidenceRead = await readViewerEvidence(input.outputDir, input.viewerRoot);
  if (evidenceRead.status !== "valid") return { evidenceStatus: evidenceRead.status };
  const evidence = evidenceRead.evidence;
  const gate2SnapshotCurrent = evidence.gate2_qc_digest
    ? await validateGate2ViewerSnapshot(input.outputDir, input.viewerRoot, evidence)
    : false;
  const snapshotReviewDigest = evidence.review_digest
    ? await digestReviewAggregateCached(input.outputDir)
    : undefined;
  const gate1Current = Boolean(
    evidence.review_digest === snapshotReviewDigest
    && evidence.review_digest === input.currentReviewDigest
  );
  const viewerIndexEntry = evidence.files.find((file) => file.path === "index.html");
  const workflowEntry = evidence.files.find((file) => file.path === "workflow.json");
  return {
    evidenceStatus: "valid",
    ...(gate1Current ? { gate1: true as const } : {}),
    ...(gate2SnapshotCurrent
      && evidence.viewer_index_digest === viewerIndexEntry?.sha256
      && evidence.workflow_digest === workflowEntry?.sha256
      && evidence.gate2_qc_digest === input.currentGate2QcDigest
      && input.gate2SourceAssetsCurrent
      ? { gate2: true as const }
      : {})
  };
}

async function validateGate2ViewerSnapshot(
  outputDir: string,
  viewerRoot: LauncherDirectoryIdentity,
  evidence: ViewerEvidence
): Promise<boolean> {
  const gate2Entries = evidence.files.filter((entry) =>
    entry.path === "index.html"
    || entry.path === "workflow.json"
    || entry.path.startsWith("assets/")
    || entry.path.startsWith("previews/")
  );
  for (const entry of gate2Entries) {
    const file = await openContainedStaticFile(outputDir, entry.path, viewerRoot.realPath);
    if (!file) return false;
    try {
      if (
        entry.size !== file.stats.size
        || (
          (entry.path === "index.html" || entry.path === "workflow.json")
          && file.stats.size > WORKFLOW_VIEWER_DOCUMENT_BYTE_LIMIT
        )
      ) return false;
      if (await digestSnapshotArtifactCached(file.path, file.handle) !== entry.sha256) return false;
    } catch {
      return false;
    } finally {
      await file.handle.close();
    }
  }
  return true;
}

async function readViewerEvidence(
  outputDir: string,
  viewerRoot: LauncherDirectoryIdentity
): Promise<ViewerEvidenceRead> {
  const evidencePath = resolve(outputDir, WORKFLOW_VIEWER_EVIDENCE_FILE);
  try {
    const evidenceStats = await lstat(evidencePath);
    if (!evidenceStats.isFile() || evidenceStats.isSymbolicLink()) return { status: "invalid" };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) {
      return { status: "absent" };
    }
    return { status: "invalid" };
  }
  const evidenceFile = await openContainedStaticFile(
    outputDir,
    WORKFLOW_VIEWER_EVIDENCE_FILE,
    viewerRoot.realPath
  );
  if (!evidenceFile || evidenceFile.stats.size > LAUNCHER_VIEWER_EVIDENCE_MAX_BYTES) {
    await evidenceFile?.handle.close();
    return { status: "invalid" };
  }
  try {
    const contents = await readOpenedFileBounded(
      evidenceFile.handle,
      evidenceFile.stats,
      LAUNCHER_VIEWER_EVIDENCE_MAX_BYTES
    );
    return {
      status: "valid",
      evidence: viewerEvidenceSchema.parse(JSON.parse(contents.toString("utf8")))
    };
  } catch {
    return { status: "invalid" };
  } finally {
    await evidenceFile.handle.close();
  }
}

async function validateViewerArtifactRequest(
  requestUrl: URL,
  record: LauncherProjectRecord,
  file: OpenedStaticFile,
  onSnapshotFingerprint?: (path: string) => void | Promise<void>,
  onReviewFingerprint?: (root: string) => void | Promise<void>
): Promise<boolean> {
  if (!record.outputDir || !record.viewerRoot || !record.identity || !record.project) return false;
  const reference = relative(await realpath(record.outputDir), file.path).replaceAll("\\", "/");
  if (!isSafeViewerManifestPath(reference) || reference === WORKFLOW_VIEWER_EVIDENCE_FILE) return false;
  const evidenceRead = await readViewerEvidence(record.outputDir, record.viewerRoot);
  if (evidenceRead.status === "invalid") {
    record.evidenceInvalid = true;
    return false;
  }
  if (evidenceRead.status === "absent") {
    if (record.evidenceExpected || record.evidenceInvalid) return false;
    const requestedNodes = requestUrl.searchParams.getAll("node");
    return !reference.startsWith("review/")
      && !(reference === "index.html" && requestedNodes.length === 1 && requestedNodes[0] === "gate-2");
  }
  record.evidenceExpected = true;
  record.evidenceInvalid = false;
  const evidence = evidenceRead.evidence;
  const manifestEntry = evidence.files.find((entry) => entry.path === reference);
  if (!manifestEntry || manifestEntry.size !== file.stats.size) return false;
  if (
    (reference === "index.html" || reference === "workflow.json")
    && file.stats.size > WORKFLOW_VIEWER_DOCUMENT_BYTE_LIMIT
  ) return false;
  const snapshotDigest = await digestSnapshotArtifactCached(
    file.path,
    file.handle,
    onSnapshotFingerprint
  );
  if (snapshotDigest !== manifestEntry.sha256) return false;

  if (reference.startsWith("review/")) {
    if (!evidence.review_digest) return false;
    const runDir = join(
      dirname(record.configPath),
      record.project.dist_dir,
      record.project.run_id ?? record.project.slug
    );
    const [sourceReviewDigest, snapshotReviewDigest] = await Promise.all([
      digestReviewAggregateCached(runDir, onReviewFingerprint),
      digestReviewAggregateCached(record.outputDir, onReviewFingerprint)
    ]);
    if (
      !sourceReviewDigest
      || evidence.review_digest !== sourceReviewDigest
      || evidence.review_digest !== snapshotReviewDigest
    ) return false;
  }

  const requestedNodes = requestUrl.searchParams.getAll("node");
  const gate2DeepLink = reference === "index.html"
    && requestedNodes.length === 1
    && requestedNodes[0] === "gate-2";
  if (
    gate2DeepLink
    && !evidence.gate2_qc_digest
  ) return false;
  if (
    gate2DeepLink
    && !await validateGate2ViewerSnapshot(record.outputDir, record.viewerRoot, evidence)
  ) return false;
  if (
    evidence.gate2_qc_digest
    && (
      reference === "index.html"
      || reference === "workflow.json"
      || reference.startsWith("assets/")
      || reference.startsWith("previews/")
    )
  ) {
    const gate2QcPath = join(
      dirname(record.configPath),
      record.project.dist_dir,
      record.project.run_id ?? record.project.slug,
      "gate2-qc.json"
    );
    const currentGate2Qc = await inspectGate2QcSource(
      record.configPath,
      gate2QcPath,
      record.identity
    );
    if (
      currentGate2Qc?.digest !== evidence.gate2_qc_digest
      || currentGate2Qc.assetsCurrent !== true
    ) return false;
  }
  return true;
}

function toPublicLauncherIssue(issue: Issue): Issue {
  return { code: issue.code, message: issue.message };
}

async function findProjectThumbnail(projectDir: string, runDir: string): Promise<string | undefined> {
  const directories = [
    join(runDir, "qa"),
    runDir,
    join(runDir, "review", "assets"),
    join(projectDir, "qa"),
    projectDir,
    join(projectDir, "media", "reference"),
    join(projectDir, "assets", "references"),
    join(projectDir, "assets", "images"),
    join(projectDir, "assets", "stills"),
    join(projectDir, "media")
  ];
  for (const directory of directories) {
    const thumbnail = await firstImageInDirectory(directory);
    if (thumbnail) return thumbnail;
  }
  return undefined;
}

async function firstImageInDirectory(directory: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) return undefined;
    throw error;
  }
  const imageNames = entries
    .filter((entry) => entry.isFile() && isThumbnailImage(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => {
      const contactSheetDifference = Number(isContactSheet(right)) - Number(isContactSheet(left));
      return contactSheetDifference || left.localeCompare(right);
    });
  return imageNames[0] ? join(directory, imageNames[0]) : undefined;
}

async function safeProjectThumbnail(
  configPath: string,
  thumbnailPath: string,
  identity: LauncherProjectIdentity
): Promise<OpenedStaticFile | undefined> {
  const projectDir = dirname(configPath);
  if (!isContained(projectDir, thumbnailPath)) return undefined;
  if (!await matchesProjectIdentity(configPath, identity)) return undefined;
  const thumbnailReference = relative(projectDir, thumbnailPath);
  return openContainedStaticFile(
    projectDir,
    process.platform === "win32"
      ? thumbnailReference.replaceAll("\\", "/")
      : thumbnailReference,
    identity.realProjectDir
  );
}

async function captureProjectIdentity(
  configPath: string
): Promise<{ identity: LauncherProjectIdentity; sourceModifiedAtMs: number }> {
  const projectDir = dirname(configPath);
  const [projectStats, configStats] = await Promise.all([
    lstat(projectDir),
    lstat(configPath)
  ]);
  if (!projectStats.isDirectory() || projectStats.isSymbolicLink()) {
    throw new Error("Project directory must be a real directory");
  }
  if (!configStats.isFile() || configStats.isSymbolicLink()) {
    throw new Error("Project config must be a regular file");
  }
  const [realProjectDir, realConfigPath] = await Promise.all([
    realpath(projectDir),
    realpath(configPath)
  ]);
  if (!isContained(realProjectDir, realConfigPath)) {
    throw new Error("Project config resolves outside the project directory");
  }
  return {
    identity: {
      realProjectDir,
      realConfigPath,
      projectDevice: projectStats.dev,
      projectInode: projectStats.ino,
      configDevice: configStats.dev,
      configInode: configStats.ino
    },
    sourceModifiedAtMs: configStats.mtimeMs
  };
}

async function captureFeedbackFileIdentity(
  configPath: string
): Promise<FeedbackFileIdentity | undefined> {
  try {
    const stats = await lstat(feedbackPathForProject(configPath));
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    return { device: stats.dev, inode: stats.ino };
  } catch {
    return undefined;
  }
}

async function matchesProjectIdentity(
  configPath: string,
  expected: LauncherProjectIdentity
): Promise<boolean> {
  try {
    const { identity: current } = await captureProjectIdentity(configPath);
    return current.realProjectDir === expected.realProjectDir
      && current.realConfigPath === expected.realConfigPath
      && current.projectDevice === expected.projectDevice
      && current.projectInode === expected.projectInode
      && current.configDevice === expected.configDevice
      && current.configInode === expected.configInode;
  } catch {
    return false;
  }
}

function projectDirectoryIdentity(
  configPath: string,
  identity: LauncherProjectIdentity
): LauncherDirectoryIdentity {
  return {
    path: resolve(dirname(configPath)),
    realPath: identity.realProjectDir,
    device: identity.projectDevice,
    inode: identity.projectInode
  };
}

async function captureDirectoryIdentity(path: string): Promise<LauncherDirectoryIdentity> {
  const absolutePath = resolve(path);
  const stats = await lstat(absolutePath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Viewer root must be a real directory");
  }
  return {
    path: absolutePath,
    realPath: await realpath(absolutePath),
    device: stats.dev,
    inode: stats.ino
  };
}

async function matchesDirectoryIdentity(expected: LauncherDirectoryIdentity): Promise<boolean> {
  try {
    const current = await captureDirectoryIdentity(expected.path);
    return current.realPath === expected.realPath
      && current.device === expected.device
      && current.inode === expected.inode;
  } catch {
    return false;
  }
}

async function createLauncherPrivateRoot(): Promise<LauncherDirectoryIdentity> {
  let createdPath: string | undefined;
  try {
    createdPath = await mkdtemp(join(tmpdir(), "tsugite-viewer-launcher-"));
    await chmod(createdPath, 0o700);
    const stats = await lstat(createdPath);
    // Windows does not expose POSIX permission bits with Unix semantics. Its temporary
    // directory ACL remains the access boundary; identity checks below still pin the root.
    if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o700) {
      throw new Error("Viewer private root permissions must be 0700");
    }
    return await captureDirectoryIdentity(createdPath);
  } catch (error) {
    if (createdPath) await rm(createdPath, { recursive: true, force: true });
    throw error;
  }
}

async function cleanupLauncherPrivateRoot(
  root: LauncherDirectoryIdentity | undefined
): Promise<void> {
  if (!root || !await matchesDirectoryIdentity(root)) return;
  await rm(root.path, { recursive: true, force: true });
}

async function assertSafeViewerSnapshot(snapshot: LauncherViewerSnapshot): Promise<void> {
  if (!await matchesDirectoryIdentity(snapshot.root)) {
    throw new Error("Viewer snapshot root changed after generation");
  }
  await assertSafeOutputBelowRoot(
    snapshot.root.path,
    snapshot.root.realPath,
    snapshot.outputDir
  );
}

function isThumbnailImage(name: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extname(name).toLowerCase());
}

function isContactSheet(name: string): boolean {
  return /contact[-_]?sheet/i.test(name);
}

async function assertSafeProjectOutput(configPath: string, outputDir: string): Promise<void> {
  const projectDir = dirname(resolve(configPath));
  const realProjectDir = await realpath(projectDir);
  await assertSafeOutputBelowRoot(projectDir, realProjectDir, outputDir);
}

async function assertSafeOutputBelowRoot(
  root: string,
  realRoot: string,
  outputDir: string
): Promise<void> {
  if (!isContained(root, outputDir)) {
    throw new Error("Viewer output is outside the allowed directory");
  }
  let current = resolve(outputDir);
  while (isContained(root, current)) {
    try {
      const currentStats = await lstat(current);
      if (currentStats.isSymbolicLink()) {
        throw new Error("Viewer output path contains a symbolic link");
      }
      const realCurrent = await realpath(current);
      if (!isContained(realRoot, realCurrent)) {
        throw new Error("Viewer output resolves outside the allowed directory");
      }
      return;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      if (current === resolve(root)) break;
      current = dirname(current);
    }
  }
  throw new Error("Viewer output could not be resolved inside the allowed directory");
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) return false;
    throw error;
  }
}

function injectLauncherMeta(html: string, token: string): string {
  const head = /<head(?:\s[^>]*)?>/i;
  if (!head.test(html)) throw new Error("Viewer bundle index.html does not contain a head element");
  return html.replace(
    head,
    (opening) => `${opening}\n    <meta name="tsugite-launcher" content="true">\n    <meta name="tsugite-launcher-token" content="${token}">`
  );
}

async function writeProjectGenerationConnection(
  configPath: string,
  identity: LauncherProjectIdentity,
  connection: string,
  adapter: string
): Promise<boolean> {
  if (!await matchesProjectIdentity(configPath, identity)) return false;
  const source = await readFile(configPath, "utf8");
  const document = parseDocument(source);
  if (document.errors.length > 0) return false;
  document.setIn(["generation", "connection"], connection);
  document.setIn(["generation", "adapter"], adapter);
  const output = document.toString({ lineWidth: 0 });
  const temporaryPath = join(dirname(configPath), `.project-connection-${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600
  );
  try {
    await handle.writeFile(output, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (!await matchesProjectIdentity(configPath, identity)) return false;
    await rename(temporaryPath, configPath);
    return true;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function runProjectGeneration(configPath: string): Promise<unknown> {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const result = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "src/cli.ts",
    "run", "--config", configPath,
    "--actor", "coordinator", "--json"
  ], {
    cwd: repoRoot,
    timeout: 60 * 60 * 1000,
    maxBuffer: 1024 * 1024 * 20
  });
  return JSON.parse(result.stdout);
}

async function readJsonRequest(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function openContainedStaticFile(
  root: string,
  reference: string,
  requiredRealAncestor?: string
): Promise<OpenedStaticFile | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    return undefined;
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => part === ".." || part === ".")
  ) {
    return undefined;
  }
  const candidate = resolve(root, decoded);
  if (!isContained(root, candidate)) return undefined;
  let handle: FileHandle | undefined;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [fileStats, currentCandidate, realRoot, realCandidate] = await Promise.all([
      handle.stat(),
      lstat(candidate),
      realpath(root),
      realpath(candidate)
    ]);
    if (
      !fileStats.isFile()
      || currentCandidate.isSymbolicLink()
      || !sameFileIdentity(fileStats, currentCandidate)
    ) return undefined;
    const realCandidateStats = await lstat(realCandidate);
    if (!sameFileIdentity(fileStats, realCandidateStats)) return undefined;
    if (!isContained(realRoot, realCandidate)) return undefined;
    if (
      requiredRealAncestor
      && (
        !isContained(requiredRealAncestor, realRoot)
        || !isContained(requiredRealAncestor, realCandidate)
      )
    ) return undefined;
    const opened = { handle, path: realCandidate, stats: fileStats };
    handle = undefined;
    return opened;
  } catch (error) {
    if (
      isFileSystemError(error, "ENOENT")
      || isFileSystemError(error, "ENOTDIR")
      || isFileSystemError(error, "ELOOP")
    ) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function isSafeViewerManifestPath(reference: string): boolean {
  if (
    reference.startsWith("/")
    || reference.includes("\\")
    || reference.includes("\0")
    || reference.split("/").some((part) => !part || part === "." || part === "..")
  ) return false;
  return reference === "index.html"
    || reference === "workflow.json"
    || reference.startsWith("assets/")
    || reference.startsWith("previews/")
    || reference.startsWith("review/");
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const fileStats = await lstat(path);
    return fileStats.isFile() && !fileStats.isSymbolicLink();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

async function digestRegularFiles(paths: string[]): Promise<string | undefined> {
  const digest = createHash("sha256");
  for (const path of paths) {
    const fileDigest = await digestRegularFile(path);
    if (!fileDigest) return undefined;
    digest.update(resolve(path));
    digest.update("\0");
    digest.update(fileDigest);
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function digestRegularFile(path: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) return undefined;
    const cached = regularFileDigestCache.get(path);
    if (cached && sameDigestIdentity(cached, before)) return cached.digest;
    const digest = await digestOpenedFileHandle(handle, before);
    const after = await handle.stat();
    regularFileDigestCache.set(path, {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      digest
    });
    if (regularFileDigestCache.size > REGULAR_FILE_DIGEST_CACHE_MAX_ENTRIES) {
      const oldest = regularFileDigestCache.keys().next().value as string | undefined;
      if (oldest) regularFileDigestCache.delete(oldest);
    }
    return digest;
  } catch (error) {
    if (
      isFileSystemError(error, "ENOENT")
      || isFileSystemError(error, "ENOTDIR")
      || isFileSystemError(error, "ELOOP")
    ) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function digestOpenedFileHandle(handle: FileHandle, before: Stats): Promise<string> {
  const digest = createHash("sha256");
  const stream = handle.createReadStream({ start: 0, autoClose: false });
  for await (const chunk of stream) digest.update(chunk as Buffer);
  const after = await handle.stat();
  if (!sameFileIdentity(before, after) || !sameDigestIdentity(before, after)) {
    throw new Error("File changed while it was being fingerprinted");
  }
  return digest.digest("hex");
}

async function readOpenedFileBounded(
  handle: FileHandle,
  before: Stats,
  maximumBytes: number
): Promise<Buffer> {
  if (before.size > maximumBytes) throw new Error("File exceeds the read limit");
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const stream = handle.createReadStream({ start: 0, autoClose: false });
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maximumBytes) {
      stream.destroy();
      throw new Error("File exceeds the read limit");
    }
    chunks.push(buffer);
  }
  const after = await handle.stat();
  if (!sameFileIdentity(before, after) || !sameDigestIdentity(before, after)) {
    throw new Error("File changed while it was being read");
  }
  return Buffer.concat(chunks, totalBytes);
}

function sameDigestIdentity(
  left: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">,
  right: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function listRegularFiles(directory: string): Promise<string[] | undefined> {
  try {
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return undefined;
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) return undefined;
    return entries
      .map((entry) => join(directory, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) return undefined;
    throw error;
  }
}

async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: OpenedStaticFile
): Promise<void> {
  try {
    const contentType = contentTypeFor(file.path);
    response.setHeader("content-type", contentType);
    response.setHeader("accept-ranges", "bytes");
    const range = parseRange(request.headers.range, file.stats.size);
    if (request.headers.range && !range) {
      response.statusCode = 416;
      response.setHeader("content-range", `bytes */${file.stats.size}`);
      response.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, file.stats.size - 1);
    const length = file.stats.size === 0 ? 0 : end - start + 1;
    response.statusCode = range ? 206 : 200;
    response.setHeader("content-length", String(length));
    if (range) response.setHeader("content-range", `bytes ${start}-${end}/${file.stats.size}`);
    if (request.method === "HEAD" || file.stats.size === 0) {
      response.end();
      return;
    }
    await new Promise<void>((resolveStream, reject) => {
      const stream = file.handle.createReadStream({ start, end, autoClose: false });
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        response.off("finish", onFinish);
        response.off("close", onClose);
        stream.off("error", onError);
        if (error) reject(error);
        else resolveStream();
      };
      const onFinish = () => settle();
      const onClose = () => {
        stream.destroy();
        settle();
      };
      const onError = (error: Error) => settle(error);
      stream.once("error", onError);
      response.once("finish", onFinish);
      response.once("close", onClose);
      stream.pipe(response);
    });
  } finally {
    await file.handle.close();
  }
}

function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || size <= 0) return undefined;
  const [, startText, endText] = match;
  if (!startText && !endText) return undefined;
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0) return undefined;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    return undefined;
  }
  return { start, end: Math.min(end, size - 1) };
}

function contentTypeFor(path: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".woff2": "font/woff2"
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cross-origin-resource-policy", "same-origin");
}

function setArtifactHeaders(response: ServerResponse): void {
  setCommonHeaders(response);
  response.setHeader("cross-origin-resource-policy", "same-site");
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendNotFound(response: ServerResponse): void {
  sendJson(response, 404, {
    ok: false,
    issue: { code: "viewer_launcher.not_found", message: "Not found" }
  });
}

function sendProjectChanged(response: ServerResponse): void {
  sendJson(response, 422, {
    ok: false,
    issue: {
      code: "viewer_launcher.project_changed",
      message: "Project files changed after loading. Reload the launcher before continuing."
    }
  });
}

function sendPrivateRootChanged(response: ServerResponse): void {
  sendJson(response, 422, {
    ok: false,
    issue: {
      code: "viewer_launcher.private_root_changed",
      message: "Viewer private storage changed. Restart the launcher before refreshing."
    }
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function listenServer(
  server: ReturnType<typeof createServer>,
  port: number
): Promise<number> {
  await new Promise<void>((resolveListening, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListening();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LOOPBACK_HOST);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Viewer server did not obtain a TCP port");
  }
  return address.port;
}

function waitForServerClose(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolveClosed) => {
    server.once("close", resolveClosed);
  });
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
