/**
 * Truthful production review pair for a Hypit plan.
 * Writes dist/<run-id>/review/index.html + review-data.json.
 * Does not mint approvals or Remotion storyboards.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { sha256Bytes } from "./digest.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function hasWindowsPathRoot(value) {
  return /^[A-Za-z]:/.test(value) || value.startsWith("\\\\");
}

function isSafeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !hasWindowsPathRoot(value)
    && !value.includes("..")
    && !value.includes("\\");
}

/** Same id / dist_dir rules as src/project/schema.ts (safeId + safeRelativePath). */
const identitySchema = z.object({
  slug: z.string().min(1).regex(SAFE_ID, "must be a safe id"),
  name: z.string().trim().min(1).max(120),
  run_id: z.string().min(1).regex(SAFE_ID, "must be a safe id").optional(),
  dist_dir: z.string().min(1).refine(isSafeRelativePath, "must be a safe relative path").default("dist")
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function withinReal(rootReal, candidateReal) {
  const relation = relative(rootReal, candidateReal);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`));
}

function assertRegularNoSymlink(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw Object.assign(new Error(`symlink refused: ${path}`), { code: "HYPIT_PATH_UNSAFE" });
  }
  return st;
}

function localEndpoints(planJson) {
  const found = [];
  const providers = Array.isArray(planJson?.providers) ? planJson.providers : [];
  for (const item of providers) {
    if (item?.endpoint) found.push(String(item.endpoint));
  }
  const needs = Array.isArray(planJson?.needs) ? planJson.needs : [];
  for (const item of needs) {
    if (item?.endpoint) found.push(String(item.endpoint));
  }
  return [...new Set(found)];
}

function boundSourceMap(state) {
  const files = state?.run?.plan_binding?.source_files ?? state?.run?.source_files ?? [];
  return new Map(files.map((item) => [item.relative_path, item]));
}

function readBoundProposalText(workspace, relativePath, bound) {
  const path = join(workspace, relativePath);
  const expected = bound.get(relativePath);
  const present = existsSync(path);
  if (!present && !expected) return "";
  if (!present || !expected) {
    throw Object.assign(
      new Error(`proposal ${relativePath} drifted from the approved source closure`),
      { code: "HYPIT_REVIEW_STALE" }
    );
  }
  assertRegularNoSymlink(path);
  const bytes = readFileSync(path);
  if (sha256Bytes(bytes) !== expected.sha256 || bytes.length !== expected.bytes) {
    throw Object.assign(
      new Error(`proposal ${relativePath} drifted from the approved source closure`),
      { code: "HYPIT_REVIEW_STALE" }
    );
  }
  return bytes.toString("utf8");
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/**
 * Infer silent only from explicit plan metadata or assertive proposal text.
 * Ambiguous "でもよい" / missing evidence stays unknown (null).
 */
export function inferSilentFlag({ planJson, treatment, timeline, brief }) {
  const meta = firstBoolean(
    planJson?.silent,
    planJson?.silent_typography,
    planJson?.audio?.silent,
    planJson?.creative?.silent,
    planJson?.summary?.silent
  );
  if (typeof meta === "boolean") return meta;
  const chosen = [treatment, timeline].filter(Boolean).join("\n");
  const assertiveSilent = /無音の(文字|映像|タイポグラフィ|提案)|無音で(制作|構成)|silent typography/i;
  const assertiveAudio = /ナレーションあり|音声あり|声を入れる|spoken|has audio/i;
  if (assertiveSilent.test(chosen) && !assertiveAudio.test(chosen)) return true;
  if (assertiveAudio.test(chosen) && !assertiveSilent.test(chosen)) return false;
  const briefText = String(brief ?? "");
  if (assertiveSilent.test(briefText) && !/でもよい|してもよい|でも構わない/.test(briefText) && !assertiveAudio.test(briefText)) {
    return true;
  }
  return null;
}

export function productionReviewDir(productionRoot, identity) {
  return join(productionRoot, identity.dist_dir, identity.run_id, "review");
}

function parseProjectIdentityYaml(yamlPath) {
  const text = readFileSync(yamlPath, "utf8");
  let parsed;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw Object.assign(new Error(`project.yaml is not valid YAML: ${error.message}`), { code: "HYPIT_PATH_UNSAFE" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("project.yaml must be a mapping"), { code: "HYPIT_PATH_UNSAFE" });
  }
  const identity = identitySchema.safeParse({
    slug: parsed.slug,
    name: parsed.name,
    run_id: parsed.run_id,
    dist_dir: parsed.dist_dir
  });
  if (!identity.success) {
    const issue = identity.error.issues[0];
    throw Object.assign(
      new Error(`project.yaml identity is invalid: ${issue?.path?.join(".") ?? "identity"} ${issue?.message ?? ""}`.trim()),
      { code: "HYPIT_PATH_UNSAFE" }
    );
  }
  return identity.data;
}

export function loadProductionIdentity(productionRoot, state) {
  const yamlPath = join(productionRoot, "project.yaml");
  if (existsSync(yamlPath)) {
    assertRegularNoSymlink(yamlPath);
    const parsed = parseProjectIdentityYaml(yamlPath);
    const run_id = parsed.run_id ?? parsed.slug;
    return {
      production_id: state?.run?.production_id ?? parsed.slug,
      slug: parsed.slug,
      run_id,
      dist_dir: parsed.dist_dir,
      name: parsed.name
    };
  }
  const slug = String(state?.run?.production_id ?? "production");
  if (!SAFE_ID.test(slug)) {
    throw Object.assign(new Error("production identity is not a safe id"), { code: "HYPIT_PATH_UNSAFE" });
  }
  const nameSource = state?.brief ? String(state.brief).split(/[。.\n]/)[0].trim().slice(0, 80) : slug;
  return {
    production_id: slug,
    slug,
    run_id: slug,
    dist_dir: "dist",
    name: nameSource || slug
  };
}

/**
 * Reject ../ and symlink destinations before mkdir/write.
 * Does not create or mutate the review directory.
 */
export function assertContainedReviewDir(productionRoot, identity) {
  if (!existsSync(productionRoot)) {
    throw Object.assign(new Error("production root is missing"), { code: "HYPIT_PATH_UNSAFE" });
  }
  assertRegularNoSymlink(productionRoot);
  const rootResolved = resolve(productionRoot);
  const rootReal = realpathSync(productionRoot);
  if (!isSafeRelativePath(identity.dist_dir) || !SAFE_ID.test(identity.run_id)) {
    throw Object.assign(new Error("review destination is not a safe contained path"), { code: "HYPIT_PATH_UNSAFE" });
  }
  const relativeDir = join(identity.dist_dir, identity.run_id, "review");
  const dest = resolve(rootResolved, relativeDir);
  const relation = relative(rootResolved, dest);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw Object.assign(new Error("review path escapes production root"), { code: "HYPIT_PATH_UNSAFE" });
  }
  let current = rootResolved;
  const parts = relativeDir.split(/[/\\]/).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) break;
    const st = lstatSync(current);
    if (st.isSymbolicLink()) {
      throw Object.assign(new Error(`symlink refused: ${current}`), { code: "HYPIT_PATH_UNSAFE" });
    }
    const real = realpathSync(current);
    if (!withinReal(rootReal, real)) {
      throw Object.assign(new Error(`review path escapes production root: ${current}`), { code: "HYPIT_PATH_UNSAFE" });
    }
  }
  return join(productionRoot, relativeDir);
}

function writeFileAtomic(path, content) {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const tmp = join(dirname(path), `${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  let created = false;
  try {
    fd = openSync(tmp, "wx");
    created = true;
    if (lstatSync(tmp).isSymbolicLink()) {
      throw Object.assign(new Error(`symlink refused: ${tmp}`), { code: "HYPIT_PATH_UNSAFE" });
    }
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
      fd = undefined;
    }
    if (created) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
    throw error;
  }
  try {
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

function creativeFromPlan(planJson) {
  const creative = {
    duration_s: null,
    width: null,
    height: null
  };
  const visual = Array.isArray(planJson?.needs)
    ? planJson.needs.find((item) => item?.summary?.fields?.width)
    : undefined;
  if (visual?.summary?.fields) {
    creative.width = visual.summary.fields.width ?? null;
    creative.height = visual.summary.fields.height ?? null;
    const end = Number(visual.summary.fields.endFrameExclusive);
    const rate = String(visual.summary.fields.frameRate ?? "30/1");
    const fps = rate.includes("/") ? Number(rate.split("/")[0]) : Number(rate);
    if (Number.isFinite(end) && Number.isFinite(fps) && fps > 0) creative.duration_s = end / fps;
  }
  return creative;
}

function silentLabel(silent) {
  if (silent === true) return "無音の提案";
  if (silent === false) return "音声ありの提案";
  return "音声は未確定";
}

export function writeProductionReview(productionRoot, state) {
  if (!state?.run?.plan_digest) throw new Error("plan first");
  const identity = loadProductionIdentity(productionRoot, state);
  const dir = assertContainedReviewDir(productionRoot, identity);
  const workspace = state.workspace;
  if (!workspace) throw new Error("review requires authored workspace");
  const bound = boundSourceMap(state);
  const treatment = readBoundProposalText(workspace, "TREATMENT.md", bound);
  const timeline = readBoundProposalText(workspace, "TIMELINE.md", bound);
  const briefFile = readBoundProposalText(workspace, "BRIEF.md", bound);
  const brief = briefFile || String(state.brief ?? "");
  const planJson = state.plan?.json ?? null;
  const creative = creativeFromPlan(planJson);
  const silent = inferSilentFlag({ planJson, treatment, timeline, brief });
  const binding = state.run.plan_binding ?? {};
  const data = {
    format: "tsugite.production-review@1",
    identity,
    plan_digest: state.run.plan_digest,
    source_files: state.run.plan_binding?.source_files ?? state.run.source_files ?? [],
    runtime_pointer_digest: binding.runtime_pointer_digest ?? null,
    runtime_profile_digest: binding.runtime_profile_digest ?? null,
    package_manifest_digest: binding.package_manifest_digest ?? null,
    cost: state.run.cost,
    duration_s: creative.duration_s,
    aspect: creative.width && creative.height ? `${creative.width}x${creative.height}` : null,
    silent,
    local_endpoints: localEndpoints(planJson),
    request_count: state.run.cost?.request_count ?? 0,
    brief,
    treatment,
    timeline,
    approval: null
  };
  mkdirSync(dir, { recursive: true });
  const dataPath = join(dir, "review-data.json");
  const htmlPath = join(dir, "index.html");
  writeFileAtomic(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  writeFileAtomic(htmlPath, renderProductionReviewHtml(data));
  return {
    dir,
    htmlPath,
    dataPath,
    plan_digest: data.plan_digest,
    identity
  };
}

export function renderProductionReviewHtml(data) {
  const endpoints = (data.local_endpoints ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>なし</li>";
  const sources = (data.source_files ?? []).map((item) =>
    `<li><code>${escapeHtml(item.relative_path)}</code> ${escapeHtml(item.sha256)}</li>`
  ).join("") || "<li>なし</li>";
  const silent = silentLabel(data.silent);
  return `<!doctype html>
<html lang="ja"><meta charset="utf-8"><title>制作レビュー</title>
<body>
<h1>制作レビュー</h1>
<p data-testid="production-identity">${escapeHtml(data.identity?.name ?? "")} / ${escapeHtml(data.identity?.slug ?? "")}</p>
<p data-testid="proposal">${escapeHtml(String(data.duration_s ?? "未確定"))}秒 / ${escapeHtml(data.aspect ?? "未確定")} / ${escapeHtml(silent)} / 費用 ${escapeHtml(data.cost?.status ?? "unknown")}</p>
<p>承認はまだありません。このページは計画の確認用です。</p>
<h2>企画</h2>
<pre data-testid="brief">${escapeHtml(data.brief ?? "")}</pre>
<h2>演出</h2>
<pre data-testid="treatment">${escapeHtml(data.treatment ?? "")}</pre>
<h2>時間</h2>
<pre data-testid="timeline">${escapeHtml(data.timeline ?? "")}</pre>
<h2>計画が使う接続</h2>
<ul data-testid="local-endpoints">${endpoints}</ul>
<details data-testid="technical-hashes">
<summary>技術ハッシュ</summary>
<p data-testid="plan-digest">計画 ${escapeHtml(data.plan_digest ?? "")}</p>
<ul data-testid="source-closure">${sources}</ul>
<p>runtime pointer ${escapeHtml(data.runtime_pointer_digest ?? "なし")}</p>
<p>runtime profile ${escapeHtml(data.runtime_profile_digest ?? "なし")}</p>
<p>package.json ${escapeHtml(data.package_manifest_digest ?? "なし")}</p>
</details>
</body></html>
`;
}
