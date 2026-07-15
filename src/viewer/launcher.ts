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
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
  valid: boolean;
  issue?: string;
};

type LauncherProjectRecord = {
  id: string;
  name: string;
  configPath: string;
  project?: Project;
  outputDir?: string;
  public: LauncherProject;
};

export type StartWorkflowViewerLauncherOptions = {
  projectsDir?: string;
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
    const configPath = join(projectsDir, entry.name, "project.yaml");
    try {
      if (!(await lstat(configPath)).isFile()) continue;
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) continue;
      throw error;
    }
    const id = idsByConfig.get(configPath) ?? randomBytes(16).toString("hex");
    idsByConfig.set(configPath, id);
    projects.push(await inspectProject(entry.name, configPath, id));
  }
  return projects;
}

async function inspectProject(
  name: string,
  configPath: string,
  id: string,
  knownOutputDir?: string
): Promise<LauncherProjectRecord> {
  try {
    const project = await loadProject(configPath);
    const runId = project.run_id ?? project.slug;
    const runDir = join(dirname(configPath), project.dist_dir, runId);
    const outputDir = knownOutputDir ?? join(runDir, "viewer");
    await assertSafeProjectOutput(configPath, outputDir);
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
    return {
      id,
      name,
      configPath,
      project,
      outputDir,
      public: {
        id,
        name,
        slug: project.slug,
        runId,
        status,
        updatedAt,
        hasViewer,
        ...(viewerUrl ? { viewerUrl } : {}),
        valid: true
      }
    };
  } catch (error) {
    return {
      id,
      name,
      configPath,
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
