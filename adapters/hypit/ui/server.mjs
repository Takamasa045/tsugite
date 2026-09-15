import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  acceptProduction,
  authorSources,
  approveProduction,
  exportProduction,
  feedbackProduction,
  inspectProduction,
  intakeReference,
  loadProductionState,
  saveProductionState,
  planProduction,
  previewProduction,
  productView,
  reconcileAuthorJob,
  requestBuild,
  reviseProduction,
  setInstruction,
  writeProductionReview
} from "../orchestrator.mjs";

const HTML = fileURLToPath(new URL("./index.html", import.meta.url));

export function csrfPath(productionRoot) {
  return join(productionRoot, ".tsugite", "authoring", "csrf");
}

export function loadOrCreateCsrf(productionRoot) {
  const path = csrfPath(productionRoot);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(token)) return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseCookies(req) {
  const raw = header(req, "cookie") ?? "";
  const out = {};
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function assertMutationSafe(req, options) {
  const port = options.port;
  const host = header(req, "host") ?? "";
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(host)) {
    throw Object.assign(new Error("invalid host"), { code: "CSRF", status: 403 });
  }
  const origin = header(req, "origin");
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (!origin || !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("invalid origin"), { code: "CSRF", status: 403 });
  }
  const type = (header(req, "content-type") ?? "").split(";")[0].trim().toLowerCase();
  const allowedTypes = options.multipart
    ? new Set(["application/json", "multipart/form-data"])
    : new Set(["application/json"]);
  if (!allowedTypes.has(type)) {
    throw Object.assign(new Error("invalid content-type"), { code: "CSRF", status: 403 });
  }
  const csrf = header(req, "x-tsugite-csrf") ?? "";
  if (csrf !== options.token) {
    throw Object.assign(new Error("invalid csrf"), { code: "CSRF", status: 403 });
  }
  const cookie = parseCookies(req).tsugite_csrf;
  if (cookie !== options.token) {
    throw Object.assign(new Error("invalid csrf cookie"), { code: "CSRF", status: 403 });
  }
}

function setCsrfHeaders(res, token) {
  res.setHeader("set-cookie", `tsugite_csrf=${token}; Path=/; SameSite=Strict; HttpOnly`);
}

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function reply(res, state) {
  json(res, { ok: true, view: productView(state), state });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipartFile(req, body) {
  const type = header(req, "content-type") ?? "";
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  if (!match) throw new Error("multipart boundary missing");
  const boundary = `--${match[1] ?? match[2]}`;
  const text = body.toString("latin1");
  const parts = text.split(boundary);
  for (const part of parts) {
    if (part.includes('name="file"') || part.includes('name="from"')) {
      const split = part.indexOf("\r\n\r\n");
      if (split === -1) continue;
      const content = part.slice(split + 4).replace(/\r\n--\s*$/, "").replace(/\r\n$/, "");
      return Buffer.from(content, "latin1");
    }
  }
  throw new Error("upload file missing");
}

export function startAuthoringUi(options) {
  const productionRoot = realpathSync(options.productionRoot);
  const port = options.port ?? 8787;
  const hooks = options.hooks ?? {};
  const token = options.csrfToken ?? loadOrCreateCsrf(productionRoot);
  const listenPath = join(productionRoot, ".tsugite", "authoring", "ui-listen.json");
  const identity = {
    productionRoot,
    adapter: "hypit"
  };
  let boundPort = port;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort || port}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        setCsrfHeaders(res, token);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(HTML, "utf8").replaceAll("%%CSRF%%", token));
        return;
      }
      if (req.method === "GET" && url.pathname === "/production-review") {
        const state = loadProductionState(productionRoot);
        const htmlPath = state?.review?.htmlPath;
        if (!htmlPath || !existsSync(htmlPath)) {
          res.writeHead(404); res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(htmlPath));
        return;
      }
      if (req.method === "GET" && url.pathname === "/state") {
        setCsrfHeaders(res, token);
        try { reconcileAuthorJob(productionRoot); } catch { /* lock busy or no state */ }
        const state = loadProductionState(productionRoot) ?? null;
        json(res, { ok: true, csrf: token, identity, view: productView(state), state });
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(404); res.end("not found");
        return;
      }
      assertMutationSafe(req, {
        port: boundPort,
        token,
        multipart: url.pathname === "/intake"
      });
      const type = (header(req, "content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (url.pathname === "/intake") {
        let from;
        if (type === "multipart/form-data") {
          const bytes = parseMultipartFile(req, await readBody(req));
          const dest = join(productionRoot, ".tsugite", "authoring", "upload.mp4");
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, bytes);
          from = dest;
        } else {
          const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
          from = body.from;
        }
        reply(res, await (hooks.intakeReference ?? intakeReference)(productionRoot, from));
        return;
      }
      const body = type === "application/json"
        ? JSON.parse((await readBody(req)).toString("utf8") || "{}")
        : {};
      if (url.pathname === "/instruction") {
        reply(res, (hooks.setInstruction ?? setInstruction)(productionRoot, body.text ?? ""));
        return;
      }
      if (url.pathname === "/author") {
        reply(res, (hooks.authorSources ?? authorSources)(productionRoot));
        return;
      }
      if (url.pathname === "/plan") {
        reply(res, await (hooks.planProduction ?? planProduction)(productionRoot));
        return;
      }
      if (url.pathname === "/approve") {
        reply(res, (hooks.approveProduction ?? approveProduction)(productionRoot, {
          decision_id: body.decision_id ?? `ui-${Date.now()}`,
          decision: body.decision,
          actor: "human",
          decided_at: body.decided_at ?? new Date().toISOString(),
          reason: body.reason
        }));
        return;
      }
      if (url.pathname === "/build") {
        reply(res, (hooks.requestBuild ?? requestBuild)(productionRoot, {
          confirmPaid: body.confirm_paid === true,
          confirmLocalRender: body.confirm_local_render === true
        }));
        return;
      }
      if (url.pathname === "/status" || url.pathname === "/inspect") {
        reply(res, (hooks.inspectProduction ?? inspectProduction)(productionRoot, { buildId: body.build_id }));
        return;
      }
      if (url.pathname === "/preview") {
        reply(res, (hooks.previewProduction ?? previewProduction)(productionRoot));
        return;
      }
      if (url.pathname === "/export") {
        reply(res, (hooks.exportProduction ?? exportProduction)(productionRoot, {
          buildId: body.build_id,
          output: body.output,
          to: body.to
        }));
        return;
      }
      if (url.pathname === "/accept") {
        reply(res, (hooks.acceptProduction ?? acceptProduction)(productionRoot, { buildId: body.build_id }));
        return;
      }
      if (url.pathname === "/feedback") {
        reply(res, (hooks.feedbackProduction ?? feedbackProduction)(productionRoot, {
          actor: "human",
          text: body.text
        }));
        return;
      }
      if (url.pathname === "/review") {
        const state = loadProductionState(productionRoot);
        const review = writeProductionReview(productionRoot, state);
        state.review = review;
        saveProductionState(productionRoot, state);
        reply(res, state);
        return;
      }
      if (url.pathname === "/revise") {
        reply(res, (hooks.reviseProduction ?? reviseProduction)(productionRoot, {
          instruction: body.text
        }));
        return;
      }
      res.writeHead(404); res.end("not found");
    } catch (error) {
      const status = error.status ?? (error.code === "CSRF" ? 403 : 400);
      json(res, { ok: false, error: error.message }, status);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") boundPort = address.port;
    mkdirSync(dirname(listenPath), { recursive: true });
    writeFileSync(listenPath, `${JSON.stringify({ host: "127.0.0.1", port: boundPort }, null, 2)}\n`);
    process.stdout.write(`authoring UI http://127.0.0.1:${boundPort}\n`);
  });
  server.on("close", () => {
    try { writeFileSync(listenPath, `${JSON.stringify({ host: "127.0.0.1", port: boundPort, stopped: true }, null, 2)}\n`); } catch { /* ignore */ }
  });
  return server;
}
