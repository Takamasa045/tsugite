/**
 * Durable create-only store for RegenerationGrant / AttemptAuthorization /
 * policy snapshots and grant→ledger-root bindings.
 *
 * Resume rehydrates only by revalidating these durable files + live ledger;
 * WeakSet shape alone is never sufficient.
 */
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { sha256Canonical, withoutField } from "./canonical.js";
import { acquireProductionControlRootLock, pcError } from "./errors.js";
import type { DirectoryIdentity } from "./grantLedger.js";
import {
  parseRegenerationAttemptAuthorization,
  parseRegenerationGrant,
  parseRegenerationPolicySpec,
  regenerationAttemptAuthorizationSchema,
  regenerationGrantSchema,
  regenerationPolicySpecSchema,
  type RegenerationAttemptAuthorization,
  type RegenerationGrant,
  type RegenerationPolicySpec
} from "./recoveryContracts.js";
import { digestSchema } from "./schema.js";

/** Path-free durable identity (absolute paths are forbidden in canonical digests). */
const directoryIdentitySchema = z
  .object({
    device: z.number().int().nonnegative(),
    inode: z.number().int().nonnegative(),
    /** sha256 of real_path — never the absolute path string itself. */
    real_path_digest: digestSchema
  })
  .strict();

const grantLedgerBindingSchema = z
  .object({
    schema_version: z.literal(1),
    grant_digest: digestSchema,
    production_id: z.string().min(1).max(128),
    ledger_root_identity: directoryIdentitySchema,
    policy_digest: digestSchema,
    created_at: z.string().datetime({ offset: true }),
    digest: digestSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (sha256Canonical(withoutField(value, "digest")) !== value.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["digest"],
        message: "grant ledger binding digest mismatch"
      });
    }
  });
export type GrantLedgerBinding = z.infer<typeof grantLedgerBindingSchema>;

function toStoredIdentity(identity: DirectoryIdentity): GrantLedgerBinding["ledger_root_identity"] {
  // Hash absolute path outside canonical JSON (absolute paths are forbidden there).
  const real_path_digest = createHash("sha256")
    .update(`ledger-root-path\0${identity.real_path}`, "utf8")
    .digest("hex");
  return {
    device: identity.device,
    inode: identity.inode,
    real_path_digest
  };
}

function sameStoredIdentity(
  stored: GrantLedgerBinding["ledger_root_identity"],
  live: DirectoryIdentity
): boolean {
  const liveStored = toStoredIdentity(live);
  return (
    stored.device === liveStored.device
    && stored.inode === liveStored.inode
    && stored.real_path_digest === liveStored.real_path_digest
  );
}

/**
 * Layout under production-control root:
 *   regeneration/policies/<policy_digest>.json
 *   regeneration/grants/<grant_digest>.json
 *   regeneration/authorizations/<auth_digest>.json
 *   regeneration/grant-bindings/<grant_digest>.json
 */
export class DurableRegenerationStore {
  private readonly root: string;

  constructor(productionControlRoot: string) {
    this.root = resolve(productionControlRoot);
  }

  get storeRoot(): string {
    return join(this.root, "regeneration");
  }

  async writePolicyCreateOnly(policy: RegenerationPolicySpec): Promise<RegenerationPolicySpec> {
    const parsed = parseRegenerationPolicySpec(policy);
    return this.withLock(async () => {
      const layout = await this.prepareLayout();
      const path = join(layout.policiesDir, `${parsed.digest}.json`);
      const existing = await this.readJsonIfPresent(path, layout.rootPath, regenerationPolicySpecSchema);
      if (existing) {
        if (existing.digest !== parsed.digest) {
          throw pcError("PC_LEDGER_CONFLICT", "policy leaf digest conflict");
        }
        return existing;
      }
      await publishCreateOnlyJson(path, layout.rootPath, layout.policiesDir, parsed);
      return parsed;
    });
  }

  async loadPolicy(policyDigest: string): Promise<RegenerationPolicySpec> {
    return this.withLock(async () => {
      const layout = await this.prepareLayout();
      assertSafeDigest(policyDigest);
      const path = join(layout.policiesDir, `${policyDigest}.json`);
      const policy = await this.readJsonRequired(path, layout.rootPath, regenerationPolicySpecSchema);
      return parseRegenerationPolicySpec(policy);
    });
  }

  async writeGrantCreateOnly(input: {
    grant: RegenerationGrant;
    policy: RegenerationPolicySpec;
    production_id: string;
    ledger_root_identity: DirectoryIdentity;
  }): Promise<RegenerationGrant> {
    const grant = parseRegenerationGrant(input.grant);
    const policy = parseRegenerationPolicySpec(input.policy);
    if (grant.policy_spec_digest !== policy.digest) {
      throw pcError("PC_GRANT_INVALID", "grant policy_spec_digest does not match durable policy");
    }
    return this.withLock(async () => {
      const layout = await this.prepareLayout();
      await this.writePolicyUnlocked(layout, policy);
      const grantPath = join(layout.grantsDir, `${grant.digest}.json`);
      const existingGrant = await this.readJsonIfPresent(grantPath, layout.rootPath, regenerationGrantSchema);
      if (existingGrant) {
        if (existingGrant.digest !== grant.digest) {
          throw pcError("PC_LEDGER_CONFLICT", "grant leaf digest conflict");
        }
      } else {
        await publishCreateOnlyJson(grantPath, layout.rootPath, layout.grantsDir, grant);
      }

      const bindingPath = join(layout.bindingsDir, `${grant.digest}.json`);
      const bindingBody = {
        schema_version: 1 as const,
        grant_digest: grant.digest,
        production_id: input.production_id,
        ledger_root_identity: toStoredIdentity(input.ledger_root_identity),
        policy_digest: policy.digest,
        created_at: new Date().toISOString()
      };
      const binding = grantLedgerBindingSchema.parse({
        ...bindingBody,
        digest: sha256Canonical(bindingBody)
      });
      const existingBinding = await this.readJsonIfPresent(
        bindingPath,
        layout.rootPath,
        grantLedgerBindingSchema
      );
      if (existingBinding) {
        if (
          !sameStoredIdentity(existingBinding.ledger_root_identity, input.ledger_root_identity)
          || existingBinding.production_id !== binding.production_id
        ) {
          throw pcError(
            "PC_LEDGER_CONFLICT",
            "cross-root double budget rejected: grant already bound to a different ledger root"
          );
        }
      } else {
        await publishCreateOnlyJson(bindingPath, layout.rootPath, layout.bindingsDir, binding);
      }
      return grant;
    });
  }

  async loadGrant(grantDigest: string): Promise<RegenerationGrant> {
    return this.withLock(async () => {
      const layout = await this.prepareLayout();
      assertSafeDigest(grantDigest);
      const path = join(layout.grantsDir, `${grantDigest}.json`);
      return parseRegenerationGrant(
        await this.readJsonRequired(path, layout.rootPath, regenerationGrantSchema)
      );
    });
  }

  async loadGrantBinding(grantDigest: string): Promise<GrantLedgerBinding> {
    return this.withLock(async () => {
      const layout = await this.prepareLayout();
      assertSafeDigest(grantDigest);
      const path = join(layout.bindingsDir, `${grantDigest}.json`);
      return grantLedgerBindingSchema.parse(
        await this.readJsonRequired(path, layout.rootPath, grantLedgerBindingSchema)
      );
    });
  }

  async assertLedgerRootForGrant(
    grantDigest: string,
    liveIdentity: DirectoryIdentity
  ): Promise<GrantLedgerBinding> {
    const binding = await this.loadGrantBinding(grantDigest);
    if (!sameStoredIdentity(binding.ledger_root_identity, liveIdentity)) {
      throw pcError(
        "PC_LEDGER_CONFLICT",
        "cross-root double budget rejected: live ledger root does not match grant binding"
      );
    }
    return binding;
  }

  async writeAuthorizationCreateOnly(
    authorization: RegenerationAttemptAuthorization
  ): Promise<RegenerationAttemptAuthorization> {
    const auth = parseRegenerationAttemptAuthorization(authorization);
    return this.withLock(async () => {
      const layout = await this.prepareLayout();
      // Grant must already be durable.
      const grantPath = join(layout.grantsDir, `${auth.grant_digest}.json`);
      await this.readJsonRequired(grantPath, layout.rootPath, regenerationGrantSchema);
      const path = join(layout.authorizationsDir, `${auth.digest}.json`);
      const existing = await this.readJsonIfPresent(
        path,
        layout.rootPath,
        regenerationAttemptAuthorizationSchema
      );
      if (existing) {
        if (existing.digest !== auth.digest) {
          throw pcError("PC_LEDGER_CONFLICT", "authorization leaf digest conflict");
        }
        return parseRegenerationAttemptAuthorization(existing);
      }
      await publishCreateOnlyJson(path, layout.rootPath, layout.authorizationsDir, auth);
      return auth;
    });
  }

  async loadAuthorization(authDigest: string): Promise<RegenerationAttemptAuthorization> {
    return this.withLock(async () => {
      const layout = await this.prepareLayout();
      assertSafeDigest(authDigest);
      const path = join(layout.authorizationsDir, `${authDigest}.json`);
      return parseRegenerationAttemptAuthorization(
        await this.readJsonRequired(path, layout.rootPath, regenerationAttemptAuthorizationSchema)
      );
    });
  }

  private async writePolicyUnlocked(
    layout: Layout,
    policy: RegenerationPolicySpec
  ): Promise<void> {
    const path = join(layout.policiesDir, `${policy.digest}.json`);
    const existing = await this.readJsonIfPresent(path, layout.rootPath, regenerationPolicySpecSchema);
    if (existing) return;
    await publishCreateOnlyJson(path, layout.rootPath, layout.policiesDir, policy);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = await acquireProductionControlRootLock(this.root);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  private async prepareLayout(): Promise<Layout> {
    const rootPath = resolve(this.root);
    await assertSafeDirectory(rootPath);
    const storeRoot = join(rootPath, "regeneration");
    const policiesDir = join(storeRoot, "policies");
    const grantsDir = join(storeRoot, "grants");
    const authorizationsDir = join(storeRoot, "authorizations");
    const bindingsDir = join(storeRoot, "grant-bindings");
    for (const dir of [storeRoot, policiesDir, grantsDir, authorizationsDir, bindingsDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await assertSafeDirectory(dir);
    }
    return {
      rootPath,
      storeRoot,
      policiesDir,
      grantsDir,
      authorizationsDir,
      bindingsDir,
      identity: await captureDirIdentity(rootPath)
    };
  }

  private async readJsonIfPresent<T>(
    path: string,
    root: string,
    schema: z.ZodType<T>
  ): Promise<T | undefined> {
    try {
      await assertSafeRegularFile(path, root);
      return schema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error && typeof error === "object" && "code" in error) throw error;
      throw pcError("PC_LEDGER_UNSAFE", "regeneration store file is unreadable or invalid");
    }
  }

  private async readJsonRequired<T>(
    path: string,
    root: string,
    schema: z.ZodType<T>
  ): Promise<T> {
    const value = await this.readJsonIfPresent(path, root, schema);
    if (!value) throw pcError("PC_GRANT_INVALID", "durable regeneration record not found");
    return value;
  }
}

type Layout = {
  rootPath: string;
  storeRoot: string;
  policiesDir: string;
  grantsDir: string;
  authorizationsDir: string;
  bindingsDir: string;
  identity: DirectoryIdentity;
};

function assertSafeDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw pcError("PC_PATH_UNSAFE", "digest is not a safe path id");
  }
}

async function publishCreateOnlyJson(
  finalPath: string,
  rootPath: string,
  dirPath: string,
  value: unknown
): Promise<void> {
  assertContained(finalPath, rootPath);
  assertContained(finalPath, dirPath);
  await assertFinalLeafAvailable(finalPath);
  const tempPath = join(dirPath, `.${randomUUID().replace(/-/g, "").slice(0, 16)}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertFinalLeafAvailable(finalPath);
    try {
      await link(tempPath, finalPath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw pcError("PC_LEDGER_CONFLICT", "regeneration store leaf already exists");
      }
      throw pcError("PC_LEDGER_UNSAFE", "regeneration store leaf publication failed");
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function assertFinalLeafAvailable(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw pcError("PC_PATH_UNSAFE", "store leaf must not be a symbolic link");
    throw pcError("PC_LEDGER_CONFLICT", "store leaf already exists");
  } catch (error) {
    if (isNotFound(error)) return;
    if (error && typeof error === "object" && "code" in error) throw error;
    throw pcError("PC_LEDGER_UNSAFE", "store leaf availability check failed");
  }
}

async function assertSafeDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw pcError("PC_PATH_UNSAFE", "store directory must be a real directory");
  }
  for (let current = resolve(path);; current = dirname(current)) {
    const ancestor = await lstat(current);
    if (ancestor.isSymbolicLink()) {
      throw pcError("PC_PATH_UNSAFE", "store path has a symbolic-link ancestor");
    }
    if (current === dirname(current)) break;
  }
}

async function assertSafeRegularFile(path: string, root: string): Promise<void> {
  assertContained(path, root);
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw pcError("PC_PATH_UNSAFE", "store file must be a regular file");
  }
}

async function captureDirIdentity(path: string): Promise<DirectoryIdentity> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw pcError("PC_PATH_UNSAFE", "store root is unsafe");
  }
  return { device: stats.dev, inode: stats.ino, real_path: await realpath(path) };
}

function assertContained(target: string, root: string): void {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  if (resolvedTarget === resolvedRoot) return;
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === "" || isAbsolute(rel)) {
    throw pcError("PC_PATH_UNSAFE", "store path escapes root");
  }
  const segments = rel.split(/[/\\]/);
  if (segments[0] === ".." || segments.includes("..")) {
    throw pcError("PC_PATH_UNSAFE", "store path escapes root");
  }
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (!resolvedTarget.startsWith(rootPrefix)) {
    throw pcError("PC_PATH_UNSAFE", "store path escapes root");
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST");
}
