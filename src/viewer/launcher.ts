import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import {
  aggregateFeedback,
  decideProjectFeedbackPromotion,
  readProjectFeedback,
  type FeedbackAggregate,
  type FeedbackRecord
} from "../feedback/index.js";
import { createPlan } from "../orchestrator/plan.js";
import { readState } from "../orchestrator/state.js";
import { loadProject } from "../project/loadProject.js";
import { validateProject } from "../project/validateProject.js";
import type { Project } from "../project/schema.js";
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
const LAUNCHER_DECISION_BODY_MAX_BYTES = 8 * 1024;
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
  project?: Project;
  outputDir?: string;
  thumbnailPath?: string;
  public: LauncherProject;
};

export type StartWorkflowViewerLauncherOptions = {
  projectsDir?: string;
  templatesDir?: string;
  port?: number;
  bundleDir?: string;
  beforeRefresh?: (project: LauncherProject) => void | Promise<void>;
  writeViewer?: (options: WriteWorkflowViewerOptions) => Promise<WorkflowViewerResult>;
};

export type WorkflowViewerLauncher = {
  url: string;
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
  let projects = new Map<string, LauncherProjectRecord>();
  const refreshing = new Set<string>();
  const writer = options.writeViewer ?? writeWorkflowViewer;

  const reloadProjects = async (): Promise<LauncherProject[]> => {
    const discovered = await discoverProjects(projectsDir, idsByConfig);
    projects = new Map(discovered.map((project) => [project.id, project]));
    return discovered.map((project) => project.public);
  };
  const initialProjects = await reloadProjects();
  const rootHtml = injectLauncherMeta(
    await readFile(join(bundleDir, "index.html"), "utf8"),
    token
  );

  let origin = "";
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
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

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setCommonHeaders(response);
    if (origin && request.headers.host !== new URL(origin).host) {
      sendJson(response, 403, {
        ok: false,
        issue: { code: "viewer_launcher.forbidden", message: "Launcher request was not authorized" }
      });
      return;
    }
    const requestUrl = new URL(request.url ?? "/", origin || `http://${LOOPBACK_HOST}`);
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
      const assetPath = await containedStaticFile(
        join(bundleDir, "assets"),
        requestUrl.pathname.slice("/assets/".length)
      );
      if (!assetPath) return sendNotFound(response);
      return serveFile(request, response, assetPath);
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
        request.headers.origin !== origin ||
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
      try {
        await decideProjectFeedbackPromotion(record.configPath, input);
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
        request.headers.origin !== origin ||
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
      if (!record.project || !record.outputDir || !record.public.valid) {
        sendJson(response, 422, {
          ok: false,
          issue: {
            code: "viewer_launcher.project_invalid",
            message: record.public.issue ?? "Project cannot be refreshed safely"
          }
        });
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
        const validation = await validateProject(record.configPath);
        if (!validation.ok) {
          sendJson(response, 422, {
            ok: false,
            issue: {
              code: "viewer_launcher.project_invalid",
              message: validation.issues[0]?.message ?? "Project validation failed"
            }
          });
          return;
        }
        const plan = createPlan(
          validation.project!,
          validation.manifest!,
          validation.adapter,
          validation.analysisAdapters ?? validation.analysisAdapter,
          validation.promptGuides
        );
        const viewer = await writer({
          configPath: record.configPath,
          project: validation.project!,
          plan,
          bundleDir
        });
        const refreshedRecord = await inspectProject(
          record.name,
          record.configPath,
          record.id,
          viewer.outputDir
        );
        projects.set(projectId, refreshedRecord);
        const viewerUrl = `/viewer/${projectId}/`;
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

    const thumbnailMatch = /^\/thumbnail\/([^/]+)$/.exec(requestUrl.pathname);
    if ((method === "GET" || method === "HEAD") && thumbnailMatch) {
      const record = projects.get(thumbnailMatch[1]!);
      if (!record?.thumbnailPath) return sendNotFound(response);
      const thumbnailPath = await safeProjectThumbnail(record.configPath, record.thumbnailPath);
      if (!thumbnailPath) return sendNotFound(response);
      return serveFile(request, response, thumbnailPath);
    }

    const viewerMatch = /^\/viewer\/([^/]+)(?:\/(.*))?$/.exec(requestUrl.pathname);
    if ((method === "GET" || method === "HEAD") && viewerMatch) {
      const record = projects.get(viewerMatch[1]!);
      if (!record?.outputDir) return sendNotFound(response);
      const filePath = await containedStaticFile(record.outputDir, viewerMatch[2] || "index.html");
      if (!filePath) return sendNotFound(response);
      return serveFile(request, response, filePath);
    }

    sendNotFound(response);
  }

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
    server.listen(requestedPort, LOOPBACK_HOST);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Viewer launcher did not obtain a TCP port");
  }
  origin = `http://${LOOPBACK_HOST}:${address.port}`;
  const closed = new Promise<void>((resolveClosed) => {
    server.once("close", resolveClosed);
  });

  return {
    url: origin,
    port: address.port,
    token,
    projectCount: initialProjects.length,
    closed,
    close: () => closeServer(server)
  };
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
  idsByConfig: Map<string, string>
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
          return await inspectProject(entry.name, configPath, id);
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
  knownOutputDir?: string
): Promise<LauncherProjectRecord> {
  let sourceModifiedAtMs = 0;
  try {
    const configStats = await lstat(configPath);
    if (!configStats.isFile()) throw new Error("Project config must be a regular file");
    sourceModifiedAtMs = configStats.mtimeMs;
    const project = await loadProject(configPath);
    const runId = project.run_id ?? project.slug;
    const projectDir = dirname(configPath);
    const runDir = join(projectDir, project.dist_dir, runId);
    const outputDir = knownOutputDir ?? join(runDir, "viewer");
    await assertSafeProjectOutput(configPath, outputDir);
    const thumbnailPath = await findProjectThumbnail(projectDir, runDir);
    const statePath = join(runDir, "state.json");
    let status = "planned";
    let updatedAt: string | null = null;
    try {
      const state = await readState(statePath);
      if (state.run_id !== runId) {
        throw new Error(`state run_id '${state.run_id}' does not match project run_id '${runId}'`);
      }
      status = state.status;
      updatedAt = state.updated_at;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    const hasViewer = await isRegularFile(join(outputDir, "index.html"));
    const viewerUrl = hasViewer ? `/viewer/${id}/` : undefined;
    const thumbnailUrl = thumbnailPath ? `/thumbnail/${id}` : undefined;
    return {
      id,
      name,
      configPath,
      sourceModifiedAtMs,
      project,
      outputDir,
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
        valid: true
      }
    };
  } catch (error) {
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
        issue: error instanceof Error ? error.message : String(error)
      }
    };
  }
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
  thumbnailPath: string
): Promise<string | undefined> {
  const projectDir = dirname(configPath);
  if (!isContained(projectDir, thumbnailPath)) return undefined;
  try {
    const thumbnailStats = await lstat(thumbnailPath);
    if (!thumbnailStats.isFile() || thumbnailStats.isSymbolicLink()) return undefined;
    const [realProjectDir, realThumbnail] = await Promise.all([
      realpath(projectDir),
      realpath(thumbnailPath)
    ]);
    return isContained(realProjectDir, realThumbnail) ? realThumbnail : undefined;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) return undefined;
    throw error;
  }
}

function isThumbnailImage(name: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extname(name).toLowerCase());
}

function isContactSheet(name: string): boolean {
  return /contact[-_]?sheet/i.test(name);
}

async function assertSafeProjectOutput(configPath: string, outputDir: string): Promise<void> {
  const projectDir = dirname(resolve(configPath));
  if (!isContained(projectDir, outputDir)) {
    throw new Error("Viewer output is outside the project directory");
  }
  const realProjectDir = await realpath(projectDir);
  let current = resolve(outputDir);
  while (isContained(projectDir, current)) {
    try {
      const currentStats = await lstat(current);
      if (currentStats.isSymbolicLink()) {
        throw new Error("Viewer output path contains a symbolic link");
      }
      const realCurrent = await realpath(current);
      if (!isContained(realProjectDir, realCurrent)) {
        throw new Error("Viewer output resolves outside the project directory");
      }
      return;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      if (current === projectDir) break;
      current = dirname(current);
    }
  }
  throw new Error("Viewer output could not be resolved inside the project directory");
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

async function containedStaticFile(root: string, reference: string): Promise<string | undefined> {
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
  try {
    const fileStats = await lstat(candidate);
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) return undefined;
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!isContained(realRoot, realCandidate)) return undefined;
    return realCandidate;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ENOTDIR")) return undefined;
    throw error;
  }
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
  path: string
): Promise<void> {
  const fileStats = await stat(path);
  const contentType = contentTypeFor(path);
  response.setHeader("content-type", contentType);
  response.setHeader("accept-ranges", "bytes");
  const range = parseRange(request.headers.range, fileStats.size);
  if (request.headers.range && !range) {
    response.statusCode = 416;
    response.setHeader("content-range", `bytes */${fileStats.size}`);
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, fileStats.size - 1);
  const length = fileStats.size === 0 ? 0 : end - start + 1;
  response.statusCode = range ? 206 : 200;
  response.setHeader("content-length", String(length));
  if (range) response.setHeader("content-range", `bytes ${start}-${end}/${fileStats.size}`);
  if (request.method === "HEAD" || fileStats.size === 0) {
    response.end();
    return;
  }
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path, { start, end });
    stream.once("error", reject);
    response.once("finish", resolveStream);
    stream.pipe(response);
  });
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

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
