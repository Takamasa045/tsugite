/**
 * Durable PO-8 RC evidence store.
 * Command logs, browser manifests, and readiness input are written here.
 * Public projections never contain absolute local paths, secrets, or raw prompts.
 */
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertSafeJsonValue, sha256Bytes, sha256Canonical } from "../canonical.js";
import { pcError } from "../errors.js";
import {
  buildReleaseReadinessReport,
  hashCommandOutput,
  readinessReportSha256,
  type CommandEvidence,
  type EvidenceArtifactRef,
  type ReleaseReadinessEvidenceStore,
  type ReleaseReadinessReport
} from "./releaseReadiness.js";

export const PO8_RC_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_EVIDENCE_RELATIVE_ROOT = "docs/reports/po8-rc-evidence";
export const DEFAULT_READINESS_RELATIVE_PATH = "docs/reports/po8-rc-release-readiness.json";
export const EVIDENCE_STORE_FILE = "store.json";

const ABSOLUTE_PATH = /(?:^|[\s"'`=(])(?:\/(?:Users|home|private|tmp|var|etc)\/|[A-Za-z]:[\\/]|\\\\|file:\/\/|~\/)/;
const HOST_PATH_RESIDUAL = /\/(?:Users|home|private|tmp|var|etc)\/|[A-Za-z]:[\\/]|file:\/\/|~\//;
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[@-Z\\-_]/g;
const PATH_TOKEN_RESIDUE = /\[redacted-path\][A-Za-z0-9._~-]+|\.codex\/worktrees/;
const SECRETISH = /(?:api[_-]?key|secret|password|token|authorization|raw_prompt|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/i;
const MEASURED_COMMAND_IDS = new Set([
  "browser_po0a",
  "windows_smoke",
  "desktop",
  "full_regression",
  "h3_durable_cli",
  "mode_orchestrator",
  "reader_commands"
]);

function evidenceLogSlug(id: string, command: string): string {
  const raw = id === "command" ? command : id;
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return slug || "command";
}

export type DurableEvidenceStore = {
  schema_version: 1;
  fixture_only: true;
  package_version: string;
  generated_at?: string;
  measured: NonNullable<ReleaseReadinessEvidenceStore["measured"]>;
  commands?: CommandEvidence[];
  coverage?: ReleaseReadinessEvidenceStore["coverage"];
  migration_journal?: ReleaseReadinessEvidenceStore["migration_journal"];
  rehearsal?: ReleaseReadinessEvidenceStore["rehearsal"];
  fixture_module_evidence?: ReleaseReadinessEvidenceStore["fixture_module_evidence"];
  ledger?: ReleaseReadinessEvidenceStore["ledger"];
  observer?: ReleaseReadinessEvidenceStore["observer"];
  build_provenance?: ReleaseReadinessEvidenceStore["build_provenance"];
  browser_manifest_digest?: string;
};

export function sanitizePublicText(text: string): string {
  return text
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n/)
    .map((line) => {
      if (SECRETISH.test(line)) return "[redacted-sensitive]";
      let next = line;
      for (let i = 0; i < 8; i++) {
        const before = next;
        next = next
          .replace(/file:\/\/\S*/gi, "[redacted-path]")
          .replace(/\/(?:Users|home|private|tmp|var|etc)\/\S*/g, "[redacted-path]")
          .replace(/[A-Za-z]:[\\/]\S*/g, "[redacted-path]")
          .replace(/\\\\[^\s]+/g, "[redacted-path]")
          .replace(/~\/\S*/g, "[redacted-path]")
          .replace(/\[redacted-path\][A-Za-z0-9._~-]+(?:\/[^\s"'`\]]*)?/g, "[redacted-path]")
          .replace(/\.codex\/worktrees\/\S*/g, "[redacted-path]");
        if (next === before) break;
      }
      return next;
    })
    .join("\n");
}

export function assertPublicTextSafe(text: string): void {
  if (
    HOST_PATH_RESIDUAL.test(text)
    || PATH_TOKEN_RESIDUE.test(text)
    || ABSOLUTE_PATH.test(text)
    || /\u001b/.test(text)
    || /\/Users\/|C:\\|file:\/\//.test(text)
  ) {
    throw pcError("PC_SECRET_OR_PATH", "command evidence still contains an absolute path residue");
  }
}

export function lastWriteArtifactRefs(refs: EvidenceArtifactRef[]): EvidenceArtifactRef[] {
  const byPath = new Map<string, EvidenceArtifactRef>();
  for (const ref of refs) {
    byPath.set(ref.relative_path, ref);
  }
  return [...byPath.values()];
}

export async function assertArtifactRefMatchesFile(
  storeRoot: string,
  ref: EvidenceArtifactRef
): Promise<void> {
  const relativePath = assertRepoRelativePath(ref.relative_path, "artifact");
  const path = join(storeRoot, ...relativePath.split("/"));
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw pcError("PC_PATH_UNSAFE", `${relativePath}: artifact must be a regular file`);
  }
  const bytes = await readFile(path);
  const digest = sha256Bytes(bytes);
  if (digest !== ref.sha256 || bytes.byteLength !== ref.bytes) {
    throw pcError("PC_CANONICAL_INVALID", `artifact_ref mismatch ${relativePath}`);
  }
}

export async function assertEvidenceArtifactsConsistent(storeRoot: string): Promise<void> {
  const root = await assertSafeStoreRoot(storeRoot);
  const store = await readEvidenceStore(root);
  const refs = [
    ...(store.commands ?? []).flatMap((cmd) => cmd.artifact_refs ?? []),
    ...Object.values(store.measured).flatMap((cmd) => cmd?.artifact_refs ?? [])
  ];
  const claimed = new Map<string, string>();
  for (const ref of refs) {
    const signature = `${ref.sha256}:${ref.bytes}`;
    const previous = claimed.get(ref.relative_path);
    if (previous && previous !== signature) {
      throw pcError("PC_CANONICAL_INVALID", `conflicting artifact_ref for ${ref.relative_path}`);
    }
    claimed.set(ref.relative_path, signature);
    await assertArtifactRefMatchesFile(root, ref);
  }
}

export function assertRepoRelativePath(path: string, label: string): string {
  const raw = path.trim().replaceAll("\\", "/");
  if (!raw || isAbsolute(raw) || raw.startsWith("/") || raw.includes("://")) {
    throw pcError("PC_PATH_UNSAFE", `${label}: must be repo-relative`);
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".")) {
    throw pcError("PC_PATH_UNSAFE", `${label}: path escape is not allowed`);
  }
  return parts.join("/");
}

export function commandOutputDigest(text: string): string {
  return hashCommandOutput(sanitizePublicText(text));
}

export async function assertSafeStoreRoot(storeRoot: string): Promise<string> {
  const resolved = resolve(storeRoot);
  const stats = await lstat(resolved).catch(() => null);
  if (stats?.isSymbolicLink()) {
    throw pcError("PC_PATH_UNSAFE", "evidence store root must not be a symlink");
  }
  if (stats && !stats.isDirectory()) {
    throw pcError("PC_PATH_UNSAFE", "evidence store root must be a directory");
  }
  if (!stats) await mkdir(resolved, { recursive: true });
  const real = await realpath(resolved);
  const realStat = await lstat(real);
  if (realStat.isSymbolicLink() || !realStat.isDirectory()) {
    throw pcError("PC_PATH_UNSAFE", "evidence store root is not a real directory");
  }
  return real;
}

/** Existing contract: write a same-dir temp snapshot, then overwrite dest, then delete temp. Not a rename lock. */
async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  assertSafeJsonValue(value, relative(process.cwd(), path) || "evidence");
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, json);
  await writeFile(path, json);
  await rm(temporary, { force: true });
}

export async function readEvidenceStore(storeRoot: string): Promise<DurableEvidenceStore> {
  const root = await assertSafeStoreRoot(storeRoot);
  const path = join(root, EVIDENCE_STORE_FILE);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw pcError("PC_PATH_UNSAFE", "store.json must be a regular file");
  }
  const parsed = JSON.parse(await readFile(path, "utf8")) as DurableEvidenceStore;
  if (parsed.schema_version !== 1 || parsed.fixture_only !== true) {
    throw pcError("PC_SCHEMA_INVALID", "evidence store schema is invalid");
  }
  assertSafeJsonValue(parsed, "evidence-store");
  return parsed;
}

export async function recordCoverage(
  storeRoot: string,
  coverage: NonNullable<DurableEvidenceStore["coverage"]>
): Promise<void> {
  let store: DurableEvidenceStore;
  try {
    store = await readEvidenceStore(storeRoot);
  } catch {
    store = {
      schema_version: 1,
      fixture_only: true,
      package_version: "0.9.0",
      measured: {}
    };
  }
  store.coverage = coverage;
  assertSafeJsonValue(store.coverage, "coverage");
  await writeEvidenceStore(storeRoot, store);
}

export async function writeEvidenceStore(
  storeRoot: string,
  store: DurableEvidenceStore
): Promise<string> {
  if (store.schema_version !== 1 || store.fixture_only !== true) {
    throw pcError("PC_SCHEMA_INVALID", "evidence store must be fixture-only schema 1");
  }
  const root = await assertSafeStoreRoot(storeRoot);
  const path = join(root, EVIDENCE_STORE_FILE);
  await writeAtomicJson(path, store);
  return path;
}

export async function recordCommandEvidence(input: {
  storeRoot: string;
  id: string;
  command: string;
  exit_code: number;
  output: string;
  status?: CommandEvidence["status"];
  detail?: string;
  artifact_refs?: EvidenceArtifactRef[];
}): Promise<{ evidence: CommandEvidence; log_relative_path: string }> {
  const root = await assertSafeStoreRoot(input.storeRoot);
  const sanitized = sanitizePublicText(input.output);
  assertPublicTextSafe(sanitized);
  const digest = hashCommandOutput(sanitized);
  const status = input.status ?? (
    input.exit_code !== 0 ? "failed" : (/^[a-f0-9]{64}$/.test(digest) ? "proven" : "partial")
  );
  const relativeLog = `commands/${evidenceLogSlug(input.id, input.command)}.log`;
  assertRepoRelativePath(relativeLog, "command log");
  const logPath = join(root, ...relativeLog.split("/"));
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, sanitized);
  const onDisk = await readFile(logPath);
  const readback = sha256Bytes(onDisk);
  if (readback !== digest || onDisk.byteLength !== Buffer.byteLength(sanitized, "utf8")) {
    throw pcError("PC_CANONICAL_INVALID", "command log readback digest mismatch");
  }
  const logRef: EvidenceArtifactRef = {
    kind: "command-log",
    relative_path: relativeLog,
    sha256: readback,
    bytes: onDisk.byteLength
  };
  let store: DurableEvidenceStore;
  try {
    store = await readEvidenceStore(root);
  } catch {
    store = {
      schema_version: 1,
      fixture_only: true,
      package_version: "0.9.0",
      measured: {}
    };
  }
  const measuredId = MEASURED_COMMAND_IDS.has(input.id)
    ? input.id as keyof NonNullable<ReleaseReadinessEvidenceStore["measured"]>
    : undefined;
  const previous = measuredId ? store.measured[measuredId] : undefined;
  const mergedRefs = lastWriteArtifactRefs([
    ...(previous?.artifact_refs ?? []),
    ...(input.artifact_refs ?? []),
    logRef
  ]);
  for (const ref of mergedRefs) {
    await assertArtifactRefMatchesFile(root, ref);
  }
  const evidence: CommandEvidence = {
    command: input.command,
    exit_code: input.exit_code,
    output_digest: digest,
    status,
    ...(input.detail ? { detail: input.detail } : {}),
    artifact_refs: mergedRefs
  };
  assertSafeJsonValue(evidence, "command-evidence");
  if (measuredId) {
    store.measured = { ...store.measured, [measuredId]: evidence };
  }
  store.commands = [...(store.commands ?? []).filter((cmd) => cmd.command !== input.command), evidence];
  await writeEvidenceStore(root, store);
  return { evidence, log_relative_path: relativeLog };
}

export type BrowserRuntimeManifest = {
  schema_version: 1;
  fixture_only: true;
  primary_mode: "canvas" | "fallback";
  measured: {
    webgl_unavailable: boolean;
    context_lost: boolean;
    initialization_failed: boolean;
    first_frame_timeout: boolean;
    non_blank_fallback: boolean;
    keyboard_selection: boolean;
    mission_tree_decision: boolean;
    mission_tree_exit: boolean;
  };
  scene?: Record<string, unknown>;
  artifacts?: Array<{ relative_path: string; sha256?: string; bytes?: number }>;
};

export async function ingestBrowserRuntimeEvidence(input: {
  runtimeDir: string;
  storeRoot: string;
}): Promise<{ manifest: BrowserRuntimeManifest; output_digest: string; artifact_refs: EvidenceArtifactRef[] }> {
  const storeRoot = await assertSafeStoreRoot(input.storeRoot);
  const runtime = resolve(input.runtimeDir);
  const runtimeStat = await lstat(runtime);
  if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
    throw pcError("PC_PATH_UNSAFE", "browser runtime evidence must be a real directory");
  }
  const manifestPath = join(runtime, "manifest.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as BrowserRuntimeManifest;
  if (raw.schema_version !== 1 || raw.fixture_only !== true) {
    throw pcError("PC_SCHEMA_INVALID", "browser runtime manifest schema is invalid");
  }
  const required = [
    "webgl_unavailable",
    "context_lost",
    "initialization_failed",
    "first_frame_timeout",
    "non_blank_fallback",
    "keyboard_selection",
    "mission_tree_decision",
    "mission_tree_exit"
  ] as const;
  for (const key of required) {
    if (raw.measured?.[key] !== true) {
      throw pcError("PC_SCHEMA_INVALID", `browser evidence missing measured ${key}`);
    }
  }

  const destDir = join(storeRoot, "browser");
  await mkdir(destDir, { recursive: true });
  const artifact_refs: EvidenceArtifactRef[] = [];
  const entries = (await readdir(runtime)).sort();
  for (const name of entries) {
    if (name === "manifest.json") continue;
    if (!/^[A-Za-z0-9._-]+\.(png|json|txt)$/.test(name)) continue;
    const source = join(runtime, name);
    const stat = await lstat(source);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const bytes = await readFile(source);
    const digest = sha256Bytes(bytes);
    const relative_path = `browser/${name}`;
    assertRepoRelativePath(relative_path, "browser artifact");
    const dest = join(destDir, name);
    await copyFile(source, dest);
    const readback = sha256Bytes(await readFile(dest));
    if (readback !== digest) {
      throw pcError("PC_CANONICAL_INVALID", `browser artifact readback mismatch ${relative_path}`);
    }
    artifact_refs.push({
      kind: name.endsWith(".png") ? "screenshot" : "manifest",
      relative_path,
      sha256: readback,
      bytes: bytes.byteLength
    });
  }

  const missionArtifact = artifact_refs.find((ref) => ref.relative_path === "browser/mission-tree-canvas.png");
  const mission_tree = {
    decision: raw.measured.mission_tree_decision === true,
    exit: raw.measured.mission_tree_exit === true,
    ...(missionArtifact ? { artifact_sha256: missionArtifact.sha256 } : {}),
    digest: sha256Canonical({
      decision: raw.measured.mission_tree_decision === true,
      exit: raw.measured.mission_tree_exit === true,
      artifact_sha256: missionArtifact?.sha256 ?? ""
    })
  };
  const publicManifest = {
    schema_version: 1 as const,
    fixture_only: true as const,
    primary_mode: raw.primary_mode,
    measured: raw.measured,
    mission_tree,
    artifacts: artifact_refs.map((ref) => ({
      relative_path: ref.relative_path,
      sha256: ref.sha256,
      bytes: ref.bytes
    }))
  };
  assertSafeJsonValue(publicManifest, "browser-manifest");
  const output_digest = sha256Canonical(publicManifest);
  const withDigest = { ...publicManifest, output_digest };
  await writeAtomicJson(join(destDir, "manifest.json"), withDigest);
  artifact_refs.push({
    kind: "manifest",
    relative_path: "browser/manifest.json",
    sha256: sha256Bytes(Buffer.from(`${JSON.stringify(withDigest, null, 2)}\n`)),
    bytes: Buffer.byteLength(`${JSON.stringify(withDigest, null, 2)}\n`)
  });

  let store: DurableEvidenceStore;
  try {
    store = await readEvidenceStore(storeRoot);
  } catch {
    store = {
      schema_version: 1,
      fixture_only: true,
      package_version: "0.9.0",
      measured: {}
    };
  }
  store.browser_manifest_digest = output_digest;
  const existing = store.measured.browser_po0a;
  const missionDetail = `mission_tree_digest=${mission_tree.digest}`;
  store.measured.browser_po0a = {
    command: existing?.command ?? "npm --prefix apps/workflow-viewer run test:browser",
    exit_code: existing?.exit_code ?? 0,
    output_digest: existing?.output_digest ?? output_digest,
    status: existing?.status ?? "partial",
    detail: [existing?.detail, missionDetail].filter(Boolean).join("; "),
    artifact_refs: lastWriteArtifactRefs([
      ...(existing?.artifact_refs ?? []).filter((ref) => ref.kind === "command-log"),
      ...artifact_refs
    ])
  };
  for (const ref of store.measured.browser_po0a.artifact_refs ?? []) {
    await assertArtifactRefMatchesFile(storeRoot, ref);
  }
  await writeEvidenceStore(storeRoot, store);
  return { manifest: raw, output_digest, artifact_refs };
}

/** Persist only digest-bound structural fields; drop host paths from fixture results. */
export function publicStructuralProjection(input: {
  rehearsal?: DurableEvidenceStore["rehearsal"];
  fixture_module_evidence?: DurableEvidenceStore["fixture_module_evidence"];
}): Pick<DurableEvidenceStore, "rehearsal" | "fixture_module_evidence"> {
  const rehearsal = input.rehearsal
    ? {
      schema_version: input.rehearsal.schema_version,
      fixture_count: input.rehearsal.fixture_count,
      revision_bindings_digest: input.rehearsal.revision_bindings_digest,
      results: [],
      all_ok: input.rehearsal.all_ok,
      digest: input.rehearsal.digest
    }
    : undefined;
  const fixture_module_evidence = input.fixture_module_evidence
    ? {
      schema_version: input.fixture_module_evidence.schema_version,
      fixture_count: input.fixture_module_evidence.fixture_count,
      results: [],
      ledger: input.fixture_module_evidence.ledger,
      ...(input.fixture_module_evidence.observer_digest
        ? { observer_digest: input.fixture_module_evidence.observer_digest }
        : {}),
      proven_zero_effects: input.fixture_module_evidence.proven_zero_effects,
      all_ok: input.fixture_module_evidence.all_ok,
      digest: input.fixture_module_evidence.digest
    }
    : undefined;
  return { rehearsal, fixture_module_evidence };
}

export function buildReadinessFromStore(
  store: DurableEvidenceStore,
  extras: Pick<ReleaseReadinessEvidenceStore, "rehearsal" | "fixture_module_evidence" | "ledger" | "observer" | "generated_at" | "build_provenance"> = {}
): ReleaseReadinessReport {
  return buildReleaseReadinessReport({
    package_version: store.package_version,
    generated_at: extras.generated_at ?? store.generated_at,
    build_provenance: extras.build_provenance ?? store.build_provenance,
    rehearsal: extras.rehearsal ?? store.rehearsal,
    fixture_module_evidence: extras.fixture_module_evidence ?? store.fixture_module_evidence,
    ledger: extras.ledger ?? store.ledger,
    observer: extras.observer ?? store.observer,
    commands: store.commands,
    coverage: store.coverage,
    measured: store.measured,
    migration_journal: store.migration_journal
  });
}

export async function writeReadinessReportFile(
  outputPath: string,
  report: ReleaseReadinessReport
): Promise<{ digest: string; canonical_digest: string }> {
  const resolved = resolve(outputPath);
  const stat = await lstat(resolved).catch(() => null);
  if (stat?.isSymbolicLink()) {
    throw pcError("PC_PATH_UNSAFE", "readiness report path must not be a symlink");
  }
  assertSafeJsonValue(
    Object.fromEntries(Object.entries(report).filter(([key]) => key !== "build_provenance" && key !== "digest")),
    "readiness-report"
  );
  const canonical_digest = readinessReportSha256(report);
  if (canonical_digest !== report.digest) {
    throw pcError("PC_CANONICAL_INVALID", "readiness report digest does not match canonical subject");
  }
  const persisted = {
    ...report,
    ...(report.build_provenance
      ? {
        build_provenance: Object.fromEntries(
          Object.entries(report.build_provenance).filter(([, value]) => value !== undefined)
        )
      }
      : {})
  };
  await writeAtomicJson(resolved, persisted);
  return { digest: report.digest, canonical_digest };
}

export async function validateReadinessReportFile(outputPath: string): Promise<{
  ok: true;
  digest: string;
  canonical_digest: string;
}> {
  const resolved = resolve(outputPath);
  const stat = await lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw pcError("PC_PATH_UNSAFE", "readiness report must be a regular file");
  }
  const report = JSON.parse(await readFile(resolved, "utf8")) as ReleaseReadinessReport;
  const canonical_digest = readinessReportSha256(report);
  if (canonical_digest !== report.digest) {
    throw pcError("PC_CANONICAL_INVALID", "readiness report digest mismatch");
  }
  assertSafeJsonValue(
    Object.fromEntries(Object.entries(report).filter(([key]) => key !== "build_provenance" && key !== "digest")),
    "readiness-report"
  );
  return { ok: true, digest: report.digest, canonical_digest };
}

export function portableJoin(...parts: string[]): string {
  return join(...parts).split(sep).join("/");
}
