/**
 * M1: production-status loads YAML mode plus actual control-root presence/digests,
 * durable mode authority, and sanitized effect evidence.
 * Never leaks secrets, raw prompts, or absolute paths.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { sha256Bytes, sha256Canonical } from "../canonical.js";
import { resolveCanonicalProductionControlRoot } from "../activeRunGeneration.js";
import { diagnoseMode, type ModeDiagnosticsReport } from "./modeDiagnostics.js";
import { resolveProjectRuntimeMode } from "./modeIntent.js";
import { rcRevisionBindingsDigest } from "./revisionBindings.js";
import type { Project } from "../../project/schema.js";
import type { ObservedCount } from "./effectLedger.js";

export type ControlPlanePresence = {
  path: string;
  present: boolean;
  kind: string;
  digest?: string;
  status: "present" | "absent" | "unsafe" | "mismatch";
  detail?: string;
};

export type ProductionStatusReport = {
  schema_version: 1;
  runtime_mode: string;
  mode_source: "durable_pointer" | "project_yaml" | "default_legacy";
  mode_authority: {
    source: "durable_pointer" | "project_yaml" | "default_legacy";
    runtime_mode: string;
    production_id?: string;
    revision_bindings_digest?: string;
    pointer_intent_digest?: string;
  };
  diagnostics: ModeDiagnosticsReport;
  revision_bindings_digest: string;
  control_root_relative: string;
  presence: ControlPlanePresence[];
  presence_digest: string;
  effect_evidence: {
    provider_submit_count: ObservedCount;
    gate_mutation_count: ObservedCount;
    billing_spend_count: ObservedCount;
    network_fetch_count: ObservedCount;
    render_count: ObservedCount;
    finalize_apply_count: ObservedCount;
    /** Status command itself performs no effects; channels remain unknown until instrumented run. */
    note: "status_is_read_only";
  };
  mismatches: string[];
  unsafe: string[];
  ok: boolean;
  digest: string;
};

const FORBIDDEN = /(?:api_key|access_token|password|private_key|raw_prompt|\/Users\/|[A-Za-z]:\\)/i;

async function fileDigestIfRegular(fullPath: string): Promise<{
  status: ControlPlanePresence["status"];
  digest?: string;
  detail?: string;
}> {
  try {
    const stat = await lstat(fullPath);
    if (stat.isSymbolicLink()) return { status: "unsafe", detail: "symlink" };
    if (!stat.isFile()) return { status: "unsafe", detail: "not a regular file" };
    const bytes = await readFile(fullPath);
    return { status: "present", digest: sha256Bytes(bytes) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return { status: "absent" };
    }
    return { status: "unsafe", detail: error instanceof Error ? error.message.slice(0, 80) : "read error" };
  }
}

async function dirPresent(fullPath: string): Promise<ControlPlanePresence["status"]> {
  try {
    const stat = await lstat(fullPath);
    if (stat.isSymbolicLink()) return "unsafe";
    return stat.isDirectory() ? "present" : "unsafe";
  } catch {
    return "absent";
  }
}

export async function buildProductionStatusReport(input: {
  project: Project | Record<string, unknown>;
  projectRoot: string;
}): Promise<ProductionStatusReport> {
  const projectRoot = resolve(input.projectRoot);
  const controlRoot = resolveCanonicalProductionControlRoot(projectRoot);
  const rel = (path: string) => relative(projectRoot, path).split(sep).join("/");

  const diagnostics = diagnoseMode(input.project as { orchestration?: { mode?: string } });
  const resolved = await resolveProjectRuntimeMode({
    projectRoot,
    project: input.project as { orchestration?: { mode?: string } }
  });

  const candidates: Array<{ kind: string; relative: string; isDir?: boolean }> = [
    { kind: "mode-intent-dir", relative: "production-control/mode", isDir: true },
    { kind: "current-mode", relative: "production-control/mode/current-mode.json" },
    { kind: "migration-dir", relative: "production-control/migration", isDir: true },
    { kind: "events", relative: "production-control/events.jsonl" },
    { kind: "events-commit", relative: "production-control/events.commit.json" },
    { kind: "snapshot", relative: "production-control/coordination-state.json" },
    { kind: "artifacts-dir", relative: "production-control/artifacts", isDir: true },
    { kind: "shadow-dir", relative: "production-control/shadow", isDir: true },
    { kind: "learning-dir", relative: "production-control/learning", isDir: true },
    { kind: "job-store-hint", relative: "production-control/jobs", isDir: true },
    { kind: "recovery-dir", relative: "production-control/recovery", isDir: true }
  ];

  const presence: ControlPlanePresence[] = [];
  const mismatches: string[] = [...resolved.mismatches];
  const unsafe: string[] = [];

  for (const candidate of candidates) {
    const full = join(projectRoot, candidate.relative);
    if (candidate.isDir) {
      const status = await dirPresent(full);
      presence.push({
        path: candidate.relative,
        present: status === "present",
        kind: candidate.kind,
        status
      });
      if (status === "unsafe") unsafe.push(candidate.relative);
      continue;
    }
    const result = await fileDigestIfRegular(full);
    presence.push({
      path: candidate.relative,
      present: result.status === "present",
      kind: candidate.kind,
      status: result.status,
      ...(result.digest ? { digest: result.digest } : {}),
      ...(result.detail ? { detail: result.detail } : {})
    });
    if (result.status === "unsafe") unsafe.push(candidate.relative);
  }

  try {
    const migrationDir = join(controlRoot, "migration");
    const names = await readdir(migrationDir);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const full = join(migrationDir, name);
      const result = await fileDigestIfRegular(full);
      presence.push({
        path: rel(full),
        present: result.status === "present",
        kind: "migration-artifact",
        status: result.status,
        ...(result.digest ? { digest: result.digest } : {})
      });
    }
  } catch {
    // absent ok
  }

  const presence_digest = sha256Canonical(
    presence.map((item) => ({
      path: item.path,
      kind: item.kind,
      status: item.status,
      digest: item.digest ?? null
    }))
  );

  const effect_evidence = {
    provider_submit_count: "unknown" as ObservedCount,
    gate_mutation_count: "unknown" as ObservedCount,
    billing_spend_count: "unknown" as ObservedCount,
    network_fetch_count: "unknown" as ObservedCount,
    render_count: "unknown" as ObservedCount,
    finalize_apply_count: "unknown" as ObservedCount,
    note: "status_is_read_only" as const
  };

  const body = {
    schema_version: 1 as const,
    runtime_mode: resolved.runtime_mode,
    mode_source: resolved.source,
    mode_authority: {
      source: resolved.source,
      runtime_mode: resolved.runtime_mode,
      ...(resolved.production_id ? { production_id: resolved.production_id } : {}),
      ...(resolved.revision_bindings_digest
        ? { revision_bindings_digest: resolved.revision_bindings_digest }
        : {}),
      ...(resolved.pointer
        ? { pointer_intent_digest: resolved.pointer.intent_digest }
        : {})
    },
    diagnostics,
    revision_bindings_digest: rcRevisionBindingsDigest(),
    control_root_relative: rel(controlRoot),
    presence,
    presence_digest,
    effect_evidence,
    mismatches,
    unsafe,
    ok: unsafe.length === 0 && mismatches.length === 0
  };

  const serialized = JSON.stringify(body);
  if (FORBIDDEN.test(serialized)) {
    throw new Error("production-status payload would leak secrets/paths");
  }

  return {
    ...body,
    digest: sha256Canonical(body)
  };
}
