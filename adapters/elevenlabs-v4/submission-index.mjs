import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { billingDigest } from "../billing-contract.mjs";
import { withProcessLock } from "../process-lock.mjs";
import { syncDurableDirectory, syncSubmissionDirectoryChain } from "./durability.mjs";

async function indexDirectory(context) {
  const root = await realpath(context.project_root);
  if (root !== context.project_root) throw new Error("project_index_invalid");
  let directory = root;
  for (const part of [".tsugite", "elevenlabs-submissions"]) {
    directory = join(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error("project_index_invalid");
  }
  return directory;
}
async function readIndex(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 20_000) throw new Error("project_index_invalid");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (actual.ino !== info.ino || actual.dev !== info.dev) throw new Error("project_index_invalid");
    if (!actual.isFile() || actual.size > 20_000) throw new Error("project_index_invalid");
    const bytes = Buffer.alloc(20_001); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset > 20_000) throw new Error("project_index_invalid");
    const value = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    if (Object.keys(value).some((k) => !["schema_version", "state", "request_digest", "run_identity_digest", "gate_approval_digest", "quote_id", "run_id", "submission_count", "source_generation_ref", "receipt_digest"].includes(k))
      || value.submission_count !== 1 || (value.source_generation_ref !== null && !/^[a-f0-9]{64}$/.test(value.source_generation_ref))
      || (value.receipt_digest !== undefined && !/^[a-f0-9]{64}$/.test(value.receipt_digest))
      || value.schema_version !== 1 || !["submitting", "accepted", "succeeded", "pinned", "failed"].includes(value.state)
      || ![value.request_digest, value.run_identity_digest, value.gate_approval_digest, value.quote_id].every((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.run_id ?? "")) throw new Error("project_index_invalid");
    return value;
  } finally { await handle.close(); }
}
async function atomicIndex(directory, name, value, options) {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(directory, name));
    await syncDurableDirectory(directory, options);
  } finally { await unlink(temporary).catch(() => undefined); }
}
export async function claimProjectSubmission(payload, permit, options = {}) {
  if (!permit.project_context || !permit.project_context_digest) throw new Error("billing_context_required");
  const directory = await indexDirectory(permit.project_context), digest = permit.quote.request_digest;
  await syncSubmissionDirectoryChain(directory, options);
  return withProcessLock(directory, `${digest}.lock`, async () => {
    let existing;
    try { existing = await readIndex(join(directory, `${digest}.json`)); }
    catch (error) { if (error?.code !== "ENOENT") throw new Error("project_index_invalid"); }
    if (existing) {
      if (!["pinned", "failed"].includes(existing.state)) throw new Error("project_submission_unresolved");
      if (existing.gate_approval_digest === permit.gate_approval_digest || existing.quote_id === permit.quote.quote_id) throw new Error("project_authorization_used");
      // Retain the resolved prior generation before replacing the active slot.
      const archive = join(directory, `${digest}.${existing.quote_id}.history.json`);
      try {
        const handle = await open(archive, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(existing)); await handle.sync(); } finally { await handle.close(); }
        await syncDurableDirectory(directory, options);
      } catch (error) { if (error?.code !== "EEXIST") throw error; }
    }
    const record = { schema_version: 1, request_digest: digest, run_id: payload.run_id,
      run_identity_digest: billingDigest({ run_dir: await realpath(payload.run_dir) }), gate_approval_digest: permit.gate_approval_digest,
      quote_id: permit.quote.quote_id, state: "submitting", submission_count: 1, source_generation_ref: null };
    await atomicIndex(directory, `${digest}.json`, record, options);
    return { directory, request_digest: digest, run_identity_digest: record.run_identity_digest, gate_approval_digest: record.gate_approval_digest };
  });
}
export async function updateProjectSubmission(index, receipt, options = {}) {
  if (!index) return;
  await withProcessLock(index.directory, `${index.request_digest}.lock`, async () => {
    const path = join(index.directory, `${index.request_digest}.json`), current = await readIndex(path);
    if (current.request_digest !== index.request_digest || current.run_identity_digest !== index.run_identity_digest
      || current.gate_approval_digest !== receipt.gate_approval_digest) throw new Error("project_index_invalid");
    await atomicIndex(index.directory, `${index.request_digest}.json`, { ...current, state: receipt.state,
      source_generation_ref: receipt.billing.actual.source_generation_ref, receipt_digest: receipt.digest }, options);
  });
}
export async function existingProjectIndex(payload, receipt, context, options = {}) {
  if (!receipt.project_context_digest) return undefined;
  const directory = await indexDirectory(context), digest = receipt.request_digest;
  const current = await readIndex(join(directory, `${digest}.json`));
  const runIdentity = billingDigest({ run_dir: await realpath(payload.run_dir) });
  if (current.run_identity_digest !== runIdentity || current.gate_approval_digest !== receipt.gate_approval_digest) throw new Error("project_index_invalid");
  return { directory, request_digest: digest, run_identity_digest: runIdentity, gate_approval_digest: receipt.gate_approval_digest };
}
