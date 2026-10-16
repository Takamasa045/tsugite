import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { syncSubmissionDirectoryChain } from "./durability.mjs";
import { withProcessLock, ProcessLockError } from "../process-lock.mjs";

export const profilePath = (options = {}) => options.profileDirectory ?? join(homedir(), ".tsugite", "oauth", "elevenlabs-v4-us");
async function directory(options) {
  if (options.profileDirectory) {
    const root = await realpath(options.profileDirectory), info = await lstat(options.profileDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022)) throw new Error("oauth_profile_invalid");
    return root;
  }
  let root = await realpath(homedir());
  for (const part of [".tsugite", "oauth", "elevenlabs-v4-us"]) {
    root = join(root, part);
    try { await mkdir(root, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022)) throw new Error("oauth_profile_invalid");
  }
  return root;
}
async function syncDirectory(root) {
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function withOAuthProfile(options, action) {
  const root = await directory(options);
  await syncSubmissionDirectoryChain(root);
  try { return await withProcessLock(root, "profile.lock", () => action(root), options.lockOptions); }
  catch (error) { if (error instanceof ProcessLockError) throw new Error("oauth_profile_busy"); throw error; }
}
async function boundedJson(path) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 10_000 || (process.getuid && info.uid !== process.getuid())) throw new Error("oauth_profile_invalid");
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await h.stat(); if (current.dev !== info.dev || current.ino !== info.ino || current.size > 10_000) throw new Error("oauth_profile_invalid");
    const buffer = Buffer.alloc(10_001), { bytesRead } = await h.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 10_000) throw new Error("oauth_profile_invalid");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch { throw new Error("oauth_profile_invalid"); } finally { await h.close(); }
}
export async function readRefreshIntent(root) {
  const value = await boundedJson(join(root, "refresh-intent.json"));
  if (value === undefined) return undefined;
  if (value.version !== 1 || typeof value.attempt_id !== "string" || !/^[a-f0-9-]{36}$/.test(value.attempt_id)
    || ![value.grant_epoch, value.credential_revision].every(v => v === null || (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)))
    || Object.keys(value).some(k => !["version", "attempt_id", "grant_epoch", "credential_revision"].includes(k))) throw new Error("oauth_profile_invalid");
  return value;
}
export async function createRefreshIntent(root, record) {
  const h = await open(join(root, "refresh-intent.json"), "wx", 0o600);
  try { await h.writeFile(JSON.stringify({ version: 1, attempt_id: randomUUID(), grant_epoch: record.grant_epoch ?? null, credential_revision: record.credential_revision ?? null })); await h.sync(); }
  finally { await h.close(); }
  await syncDirectory(root);
}
export async function clearRefreshIntent(root) {
  await unlink(join(root, "refresh-intent.json")).catch(error => { if (error?.code !== "ENOENT") throw error; });
  await syncDirectory(root);
}
export async function cacheProfileStatus(root, status) {
  const temp = join(root, `.${randomUUID()}.tmp`);
  try {
    const h = await open(temp, "wx", 0o600);
    try { await h.writeFile(JSON.stringify({ schema_version: 1, ...status, checked_at: new Date().toISOString(), cache_only: true })); await h.sync(); }
    finally { await h.close(); }
    await rename(temp, join(root, "connection-status.json")); await syncDirectory(root);
  } finally { await unlink(temp).catch(() => undefined); }
}
export async function cachedProfileStatus(options = {}) {
  // Read-only: no mkdir, Keychain, refresh, discovery or token operation.
  const root = profilePath(options);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error("oauth_profile_invalid");
    const value = await boundedJson(join(root, "connection-status.json"));
    if (!value) return { configured: null, cache_only: true, checked_at: null };
    if (value.schema_version !== 1 || value.cache_only !== true || typeof value.configured !== "boolean"
      || !Number.isFinite(value.expires_at) || !Number.isFinite(Date.parse(value.checked_at))
      || Object.keys(value).some(k => !["schema_version", "cache_only", "configured", "expires_at", "grant_epoch", "checked_at"].includes(k))) throw new Error("oauth_profile_invalid");
    return { ...value, expired: value.expires_at <= Date.now() };
  } catch (error) { if (error?.code === "ENOENT") return { configured: null, cache_only: true, checked_at: null }; throw error; }
}
