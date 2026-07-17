import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  type FileHandle
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";
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
import { createPlan } from "../orchestrator/plan.js";
import { readState } from "../orchestrator/state.js";
import { loadProject } from "../project/loadProject.js";
import { validateProject } from "../project/validateProject.js";
import type { Project } from "../project/schema.js";
import type { Issue } from "../types.js";
import {
  getWorkflowViewerOpenCommand,
  prepareWorkflowViewerBundle,
  writeWorkflowViewer,
  type WorkflowViewerResult,
  type WriteWorkflowViewerOptions
} from "./artifact.js";

const LOOPBACK_HOST = "127.0.0.1";

export type LauncherProject = {
  id: string;
  name: string;
  slug: string;
  runId: string;
  status: string;
  updatedAt: string | null;
  hasViewer: boolean;
  viewerUrl?: string;
  thumbnailUrl?: string;
  valid: boolean;
  refreshable: boolean;
  issues: Issue[];
  issue?: string;
};

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
  tags: string[];
  audio: string;
  status: "stable" | "experimental" | "deprecated" | "unknown";
  distribution: "bundled" | "local-only" | "unknown";
  valid: boolean;
  issue?: { code: string; message: string };
};

export type LauncherFeedback = FeedbackAggregate;

const TEMPLATE_METADATA_MAX_BYTES = 64 * 1024;
const LAUNCHER_FEEDBACK_MAX_PROJECTS = 128;
const LAUNCHER_FEEDBACK_MAX_ITEMS = 1_000;
const LAUNCHER_FEEDBACK_NOTICE_RESERVE = 3;
const REVIEW_PREVIEW_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const LAUNCHER_DECISION_BODY_MAX_BYTES = 8 * 1024;
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
const templateIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const nonEmptyText = z.string().trim().min(1).max(240);
const descriptionText = z.string().trim().min(1).max(600);
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
  identity?: LauncherProjectIdentity;
  feedbackIdentity?: FeedbackFileIdentity;
  project?: Project;
  outputDir?: string;
  viewerRoot?: LauncherDirectoryIdentity;
  thumbnailPath?: string;
  public: LauncherProject;
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

export type StartWorkflowViewerLauncherOptions = {
  projectsDir?: string;
  templatesDir?: string;
  port?: number;
  bundleDir?: string;
  beforeRefresh?: (project: LauncherProject) => void | Promise<void>;
  beforeProjectReloadCommit?: () => void | Promise<void>;
  beforeServeArtifact?: (path: string) => void | Promise<void>;
  writeViewer?: (options: WriteWorkflowViewerOptions) => Promise<WorkflowViewerResult>;
};

export type WorkflowViewerLauncher = {
  url: string;
  artifactUrl: string;
  privateRoot?: string;
  port: number;
  token: string;
  projectCount: number;
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

  const projectsDir = resolve(
    options.projectsDir ?? fileURLToPath(new URL("../../projects", import.meta.url))
  );
  const templatesDir = resolve(
    options.templatesDir ?? fileURLToPath(new URL("../../templates", import.meta.url))
  );
  const bundleDir = await prepareWorkflowViewerBundle(options.bundleDir);
  const token = randomBytes(24).toString("hex");
  const idsByConfig = new Map<string, string>();
  const viewerSnapshots = new Map<string, LauncherViewerSnapshot>();
  let projects = new Map<string, LauncherProjectRecord>();
  const refreshing = new Set<string>();
  const writer = options.writeViewer ?? writeWorkflowViewer;
  let launcherOrigin = "";
  let artifactOrigin = "";

  const reloadProjects = async (): Promise<LauncherProject[]> => {
    const snapshotsAtStart = new Map(viewerSnapshots);
    const discovered = await discoverProjects(
      projectsDir,
      idsByConfig,
      artifactOrigin,
      launcherOrigin,
      viewerSnapshots
    );
    await options.beforeProjectReloadCommit?.();
    const nextProjects = new Map(discovered.map((project) => [project.id, project]));
    for (const [projectId, currentRecord] of projects) {
      if (viewerSnapshots.get(projectId) !== snapshotsAtStart.get(projectId)) {
        nextProjects.set(projectId, currentRecord);
      }
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
      await beforeServeArtifact(thumbnailFile);
      return serveFile(request, response, thumbnailFile);
    }

    if (method === "GET" && requestUrl.pathname === "/api/projects") {
      sendJson(response, 200, { ok: true, projects: await reloadProjects() });
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
        const validation = await validateProject(record.configPath);
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
          validation.promptGuides
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
          snapshot
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
      if (relativePath.startsWith("review/")) {
        response.setHeader("content-security-policy", REVIEW_PREVIEW_CSP);
      }
      await beforeServeArtifact(file);
      return serveFile(request, response, file);
    }

    sendNotFound(response);
  }

  async function beforeServeArtifact(file: OpenedStaticFile): Promise<void> {
    try {
      await options.beforeServeArtifact?.(file.path);
    } catch (error) {
      await file.handle.close();
      throw error;
    }
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

async function discoverProjects(
  projectsDir: string,
  idsByConfig: Map<string, string>,
  artifactOrigin: string,
  launcherOrigin: string,
  viewerSnapshots: Map<string, LauncherViewerSnapshot>
): Promise<LauncherProjectRecord[]> {
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw error;
  }

  const projects: LauncherProjectRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(projectsDir, entry.name);
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
            viewerSnapshots.get(id)
          );
        })
    );
    const latest = selectLatestProjectRecord(candidates);
    if (latest) projects.push(latest);
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
  knownSnapshot?: LauncherViewerSnapshot
): Promise<LauncherProjectRecord> {
  let sourceModifiedAtMs = 0;
  try {
    const captured = await captureProjectIdentity(configPath);
    const feedbackIdentity = await captureFeedbackFileIdentity(configPath);
    sourceModifiedAtMs = captured.sourceModifiedAtMs;
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
    let stateIssue: Issue | undefined;
    try {
      const state = await readState(statePath);
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
    const validation = await validateProject(configPath);
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
      identity: captured.identity,
      ...(feedbackIdentity ? { feedbackIdentity } : {}),
      project,
      ...(outputDir ? { outputDir } : {}),
      ...(viewerRoot ? { viewerRoot } : {}),
      thumbnailPath,
      public: {
        id,
        name,
        slug: project.slug,
        runId,
        status,
        updatedAt,
        hasViewer,
        ...(viewerUrl ? { viewerUrl } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        valid: safetyIssues.length === 0,
        refreshable: validation.project !== undefined
          && validation.manifest !== undefined
          && validation.issues.every(isExecutionCapabilityIssue)
          && stateIssue === undefined,
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
      public: {
        id,
        name,
        slug: name,
        runId: name,
        status: "error",
        updatedAt: null,
        hasViewer: false,
        valid: false,
        refreshable: false,
        issues: [issue],
        issue: issue.message
      }
    };
  }
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
  return openContainedStaticFile(
    projectDir,
    relative(projectDir, thumbnailPath),
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
    if ((stats.mode & 0o777) !== 0o700) {
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

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const fileStats = await lstat(path);
    return fileStats.isFile() && !fileStats.isSymbolicLink();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
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
