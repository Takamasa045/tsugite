import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parse, parseDocument } from "yaml";
import { validateManifest } from "../manifest/validate.js";
import { projectSchema } from "../project/schema.js";
import type { Issue, Result } from "../types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DEFAULT_ACCENT = "#6B7A5A";

export type ShitateImportOptions = {
  configPath: string;
  shitateRoot: string;
  character: string;
  runId: string;
  anchor?: string;
  requestId?: string;
  speakerId?: string;
  displayName?: string;
  side?: "left" | "right";
  accent?: string;
};

export type ShitateImportResult = Result<{
  destination: string;
  lockPath: string;
  imageId: string;
  speakerId: string;
  requestImagePath: string;
  alreadyImported: boolean;
  warnings: Issue[];
}>;

type ShitateManifest = {
  run_id: string;
  character: string;
  base_version: string;
  base_sha: string;
  tool?: string;
  tool_version?: string;
  references?: unknown;
};

type SnapshotFile = {
  role: "prompt" | "negative" | "shitate-manifest" | "anchor";
  sourcePath: string;
  destinationName: string;
  sha256: string;
};

type SnapshotLock = {
  schema_version: 1;
  source: {
    kind: "shitate";
    character: string;
    run_id: string;
    base_version: string;
    base_sha: string;
    tool?: string;
    tool_version?: string;
  };
  binding: {
    image_id: string;
    speaker_id: string;
    request_id?: string;
  };
  files: Array<{
    role: SnapshotFile["role"];
    path: string;
    sha256: string;
  }>;
  imported_at: string;
};

type PreparedProject = {
  configPath: string;
  configText: string;
  updatedConfigText: string;
  manifestPath: string;
  manifestText: string;
  updatedManifestText: string;
  destination: string;
  destinationRoot: string;
  manifestAnchorPath: string;
  requestImagePath: string;
  imageId: string;
  speakerId: string;
};

export async function importShitateSnapshot(
  options: ShitateImportOptions
): Promise<ShitateImportResult> {
  try {
    return await importSnapshot(options);
  } catch (error) {
    const issue = error instanceof ShitateImportError
      ? error.issue
      : {
          code: "shitate_import.failed",
          message: error instanceof Error ? error.message : String(error)
        };
    return { ok: false, issues: [issue] };
  }
}

async function importSnapshot(options: ShitateImportOptions): Promise<ShitateImportResult> {
  validateOptions(options);
  const shitateRoot = await existingDirectory(options.shitateRoot, "shitate_import.root_missing");
  const characterRoot = await containedDirectory(
    join(shitateRoot, "characters", options.character),
    shitateRoot,
    "shitate_import.character_missing"
  );
  const runRoot = await containedDirectory(
    join(characterRoot, "outputs", options.runId),
    characterRoot,
    "shitate_import.run_missing"
  );

  const shitateManifestPath = await containedFile(
    join(runRoot, "manifest.json"),
    runRoot,
    "shitate_import.source_missing"
  );
  const shitateManifest = parseShitateManifest(await readJson(shitateManifestPath), options);
  const anchorPath = await resolveAnchor(characterRoot, shitateManifest, options.anchor);
  const promptPath = await containedFile(join(runRoot, "prompt.txt"), runRoot, "shitate_import.source_missing");
  const negativePath = await containedFile(join(runRoot, "negative.txt"), runRoot, "shitate_import.source_missing");
  const anchorExtension = extname(anchorPath).toLowerCase();
  const speakerId = options.speakerId ?? options.character;
  const imageId = `${speakerId}-anchor`;
  const files = await snapshotFiles({ promptPath, negativePath, shitateManifestPath, anchorPath, anchorExtension });
  const prepared = await prepareProject(options, shitateManifest, imageId, speakerId, anchorExtension);
  const lock = createLock(options, shitateManifest, imageId, speakerId, files);
  const lockPath = join(prepared.destination, "character-lock.json");

  const destinationExists = await pathExists(prepared.destination);
  if (destinationExists) {
    await assertSafeDestination(prepared.destination, prepared.destinationRoot);
    await assertExistingSnapshot(prepared.destination, lock);
  } else {
    await writeSnapshot(prepared.destination, prepared.destinationRoot, files, lock);
  }

  try {
    await writeProjectUpdates(prepared);
  } catch (error) {
    if (!destinationExists) await rm(prepared.destination, { recursive: true, force: true });
    throw error;
  }

  return {
    ok: true,
    issues: [],
    destination: prepared.destination,
    lockPath,
    imageId,
    speakerId,
    requestImagePath: prepared.requestImagePath,
    alreadyImported: destinationExists,
    warnings: [
      {
        code: "shitate_import.negative_prompt_not_applied",
        message: "negative.txt was preserved in the snapshot but was not added to the video request"
      }
    ]
  };
}

function validateOptions(options: ShitateImportOptions): void {
  for (const [field, value] of [
    ["character", options.character],
    ["run_id", options.runId],
    ["speaker_id", options.speakerId],
    ["request_id", options.requestId]
  ] as const) {
    if (value !== undefined && !SAFE_ID.test(value)) {
      fail("shitate_import.safe_id", `${field} must be a safe id`, field);
    }
  }
  if (options.side !== undefined && options.side !== "left" && options.side !== "right") {
    fail("shitate_import.side", "side must be left or right", "side");
  }
  if (options.anchor !== undefined && !isSafeRelativePath(options.anchor)) {
    fail("shitate_import.anchor_path", "anchor must be a safe path relative to the character directory", "anchor");
  }
}

async function resolveAnchor(
  characterRoot: string,
  manifest: ShitateManifest,
  explicitAnchor?: string
): Promise<string> {
  if (explicitAnchor) {
    return containedImage(join(characterRoot, explicitAnchor), characterRoot);
  }

  const references = Array.isArray(manifest.references)
    ? manifest.references.filter((value): value is string => typeof value === "string")
    : [];
  const manifestAnchors = references.filter((value) =>
    value.toLowerCase().includes("anchor") && IMAGE_EXTENSIONS.has(extname(value).toLowerCase())
  );
  if (manifestAnchors.length === 1) {
    if (!isSafeRelativePath(manifestAnchors[0]!)) {
      fail("shitate_import.anchor_path", "manifest anchor must stay within the character directory");
    }
    return containedImage(join(characterRoot, manifestAnchors[0]!), characterRoot);
  }
  if (manifestAnchors.length > 1) {
    fail("shitate_import.anchor_ambiguous", "multiple manifest anchors found; select one with --anchor");
  }

  const imagesRoot = join(characterRoot, "references", "images");
  let entries;
  try {
    entries = await readdir(imagesRoot, { withFileTypes: true });
  } catch {
    fail("shitate_import.anchor_missing", "no anchor image was found", imagesRoot);
  }
  const candidates = entries
    .filter((entry) => entry.name.toLowerCase().includes("anchor"))
    .filter((entry) => IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(imagesRoot, entry.name));
  if (candidates.length === 0) {
    fail("shitate_import.anchor_missing", "no anchor image was found", imagesRoot);
  }
  if (candidates.length > 1) {
    fail("shitate_import.anchor_ambiguous", "multiple anchor images found; select one with --anchor", imagesRoot);
  }
  return containedImage(candidates[0]!, characterRoot);
}

async function containedImage(candidate: string, characterRoot: string): Promise<string> {
  const extension = extname(candidate).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    fail("shitate_import.anchor_type", "anchor must be JPEG, PNG, or WebP", candidate);
  }
  return containedFile(candidate, characterRoot, "shitate_import.anchor_escape");
}

async function snapshotFiles(input: {
  promptPath: string;
  negativePath: string;
  shitateManifestPath: string;
  anchorPath: string;
  anchorExtension: string;
}): Promise<SnapshotFile[]> {
  const definitions: Array<Omit<SnapshotFile, "sha256">> = [
    { role: "prompt", sourcePath: input.promptPath, destinationName: "prompt.txt" },
    { role: "negative", sourcePath: input.negativePath, destinationName: "negative.txt" },
    { role: "shitate-manifest", sourcePath: input.shitateManifestPath, destinationName: "shitate-manifest.json" },
    { role: "anchor", sourcePath: input.anchorPath, destinationName: `anchor${input.anchorExtension}` }
  ];
  return Promise.all(definitions.map(async (file) => ({ ...file, sha256: await sha256(file.sourcePath) })));
}

async function prepareProject(
  options: ShitateImportOptions,
  shitateManifest: ShitateManifest,
  imageId: string,
  speakerId: string,
  anchorExtension: string
): Promise<PreparedProject> {
  const configPath = await containedFile(resolve(options.configPath), dirname(resolve(options.configPath)), "shitate_import.config_missing");
  const configText = await readFile(configPath, "utf8");
  const projectInput = parse(configText) as unknown;
  const parsedProject = projectSchema.safeParse(projectInput);
  if (!parsedProject.success) {
    const issue = parsedProject.error.issues[0];
    fail("shitate_import.project_schema", issue?.message ?? "invalid project", issue?.path.join("."));
  }

  const configDir = dirname(configPath);
  const manifestCandidate = resolve(configDir, parsedProject.data.manifest);
  if (!isWithin(manifestCandidate, configDir)) {
    fail("shitate_import.manifest_escape", "project manifest must stay within the project directory", manifestCandidate);
  }
  if (!(await pathExists(manifestCandidate))) {
    fail("shitate_import.manifest_missing", "project manifest was not found", manifestCandidate);
  }
  const manifestPath = await containedFile(manifestCandidate, configDir, "shitate_import.manifest_escape");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifestInput = JSON.parse(manifestText) as Record<string, unknown>;
  const currentManifest = validateManifest(manifestInput);
  if (!currentManifest.ok) {
    fail("shitate_import.manifest_schema", currentManifest.issues[0]?.message ?? "invalid manifest", currentManifest.issues[0]?.path);
  }

  const destination = join(configDir, "media", "shitate", options.character, options.runId);
  const destinationAnchor = join(destination, `anchor${anchorExtension}`);
  const manifestAnchorPath = portableRelative(dirname(manifestPath), destinationAnchor);
  const requestImagePath = executionPath(destinationAnchor);
  const displayName = options.displayName ?? options.character;

  const updatedManifest = addManifestBindings(manifestInput, {
    imageId,
    speakerId,
    displayName,
    side: options.side ?? "left",
    accent: options.accent ?? DEFAULT_ACCENT,
    manifestAnchorPath,
    character: options.character,
    runId: options.runId,
    baseVersion: shitateManifest.base_version,
    baseSha: shitateManifest.base_sha,
    lockPath: portableRelative(dirname(manifestPath), join(destination, "character-lock.json"))
  });
  const updatedManifestValidation = validateManifest(updatedManifest);
  if (!updatedManifestValidation.ok) {
    fail(
      "shitate_import.manifest_update_invalid",
      updatedManifestValidation.issues[0]?.message ?? "updated manifest is invalid",
      updatedManifestValidation.issues[0]?.path
    );
  }

  const updatedConfigText = updateProjectRequest(configText, options.requestId, requestImagePath);
  const updatedProjectValidation = projectSchema.safeParse(parse(updatedConfigText));
  if (!updatedProjectValidation.success) {
    const issue = updatedProjectValidation.error.issues[0];
    fail("shitate_import.project_update_invalid", issue?.message ?? "updated project is invalid", issue?.path.join("."));
  }

  return {
    configPath,
    configText,
    updatedConfigText,
    manifestPath,
    manifestText,
    updatedManifestText: `${JSON.stringify(updatedManifest, null, 2)}\n`,
    destination,
    destinationRoot: configDir,
    manifestAnchorPath,
    requestImagePath,
    imageId,
    speakerId
  };
}

function addManifestBindings(
  manifest: Record<string, unknown>,
  binding: {
    imageId: string;
    speakerId: string;
    displayName: string;
    side: "left" | "right";
    accent: string;
    manifestAnchorPath: string;
    character: string;
    runId: string;
    baseVersion: string;
    baseSha: string;
    lockPath: string;
  }
): Record<string, unknown> {
  const images = Array.isArray(manifest.images) ? [...manifest.images] as Array<Record<string, unknown>> : [];
  const speakers = Array.isArray(manifest.speakers) ? [...manifest.speakers] as Array<Record<string, unknown>> : [];
  const expectedImage = {
    id: binding.imageId,
    src: binding.manifestAnchorPath,
    alt: `${binding.displayName} Shitate anchor`
  };
  const existingImage = images.find((image) => image.id === binding.imageId);
  if (existingImage && existingImage.src !== binding.manifestAnchorPath) {
    fail("shitate_import.image_conflict", `manifest image '${binding.imageId}' already points elsewhere`, binding.imageId);
  }
  const nextImages = existingImage ? images : [...images, expectedImage];

  const expectedSpeaker = {
    id: binding.speakerId,
    display_name: binding.displayName,
    side: binding.side,
    accent: binding.accent,
    poses: { neutral: binding.imageId },
    source: {
      kind: "shitate",
      character: binding.character,
      run_id: binding.runId,
      base_version: binding.baseVersion,
      base_sha: binding.baseSha,
      lock: binding.lockPath
    }
  };
  const existingSpeaker = speakers.find((speaker) => speaker.id === binding.speakerId);
  if (existingSpeaker && !speakerBindingMatches(existingSpeaker, expectedSpeaker)) {
    fail("shitate_import.speaker_conflict", `manifest speaker '${binding.speakerId}' already differs`, binding.speakerId);
  }
  const nextSpeakers = existingSpeaker ? speakers : [...speakers, expectedSpeaker];

  return { ...manifest, images: nextImages, speakers: nextSpeakers };
}

function speakerBindingMatches(existing: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const poses = isRecord(existing.poses) ? existing.poses : {};
  return existing.display_name === expected.display_name
    && existing.side === expected.side
    && existing.accent === expected.accent
    && poses.neutral === (expected.poses as Record<string, unknown>).neutral;
}

function updateProjectRequest(configText: string, requestId: string | undefined, imagePath: string): string {
  if (!requestId) return configText;
  const document = parseDocument(configText);
  const input = document.toJS() as Record<string, unknown>;
  const generation = isRecord(input.generation) ? input.generation : undefined;
  const requests = generation && Array.isArray(generation.requests) ? generation.requests : [];
  const requestIndex = requests.findIndex((request) => isRecord(request) && request.id === requestId);
  if (requestIndex < 0) {
    fail("shitate_import.request_missing", `generation request '${requestId}' was not found`, requestId);
  }
  const request = requests[requestIndex] as Record<string, unknown>;
  const params = isRecord(request.params) ? request.params : {};
  if (typeof params.image === "string" && params.image !== imagePath) {
    fail("shitate_import.request_conflict", `generation request '${requestId}' already uses another image`, requestId);
  }
  document.setIn(["generation", "requests", requestIndex, "input_mode"], "image-to-video");
  document.setIn(["generation", "requests", requestIndex, "params", "image"], imagePath);
  return document.toString();
}

function createLock(
  options: ShitateImportOptions,
  manifest: ShitateManifest,
  imageId: string,
  speakerId: string,
  files: SnapshotFile[]
): SnapshotLock {
  return {
    schema_version: 1,
    source: {
      kind: "shitate",
      character: options.character,
      run_id: options.runId,
      base_version: manifest.base_version,
      base_sha: manifest.base_sha,
      ...(manifest.tool ? { tool: manifest.tool } : {}),
      ...(manifest.tool_version ? { tool_version: manifest.tool_version } : {})
    },
    binding: {
      image_id: imageId,
      speaker_id: speakerId,
      ...(options.requestId ? { request_id: options.requestId } : {})
    },
    files: files.map((file) => ({ role: file.role, path: file.destinationName, sha256: file.sha256 })),
    imported_at: new Date().toISOString()
  };
}

async function writeSnapshot(
  destination: string,
  destinationRoot: string,
  files: SnapshotFile[],
  lock: SnapshotLock
): Promise<void> {
  const parent = dirname(destination);
  await ensureSafeDestinationParent(parent, destinationRoot);
  const staging = await mkdtemp(join(parent, ".shitate-import-"));
  try {
    await Promise.all(files.map((file) => copyFile(file.sourcePath, join(staging, file.destinationName))));
    await writeFile(join(staging, "character-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (await pathExists(destination)) {
      fail("shitate_import.destination_conflict", "snapshot destination already exists", destination);
    }
    throw error;
  }
}

async function ensureSafeDestinationParent(parent: string, root: string): Promise<void> {
  const resolvedRoot = await realpath(root);
  if (!isWithin(parent, resolvedRoot)) {
    fail("shitate_import.destination_escape", "snapshot destination escapes the project", parent);
  }
  const segments = relative(resolvedRoot, parent).split(/[\\/]/).filter(Boolean);
  let current = resolvedRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        fail("shitate_import.destination_escape", "snapshot destination parents must be real directories", current);
      }
    } catch (error) {
      if (error instanceof ShitateImportError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
}

async function assertExistingSnapshot(destination: string, expected: SnapshotLock): Promise<void> {
  let existing: SnapshotLock;
  try {
    existing = JSON.parse(await readFile(join(destination, "character-lock.json"), "utf8")) as SnapshotLock;
  } catch {
    fail("shitate_import.destination_conflict", "existing snapshot has no readable character-lock.json", destination);
  }
  if (JSON.stringify(lockIdentity(existing!)) !== JSON.stringify(lockIdentity(expected))) {
    fail("shitate_import.destination_conflict", "existing snapshot was created from different source content", destination);
  }
  for (const file of existing!.files) {
    const candidate = join(destination, file.path);
    let resolvedCandidate: string;
    try {
      resolvedCandidate = await containedFile(candidate, destination, "shitate_import.destination_conflict");
    } catch {
      fail("shitate_import.destination_conflict", "existing snapshot contains an unsafe file", candidate);
    }
    if (await sha256(resolvedCandidate!) !== file.sha256) {
      fail("shitate_import.destination_conflict", "existing snapshot checksum does not match its lock", candidate);
    }
  }
}

async function assertSafeDestination(destination: string, root: string): Promise<void> {
  const [entry, resolvedDestination, resolvedRoot] = await Promise.all([
    lstat(destination),
    realpath(destination),
    realpath(root)
  ]);
  if (entry.isSymbolicLink() || !entry.isDirectory() || !isWithin(resolvedDestination, resolvedRoot)) {
    fail("shitate_import.destination_escape", "snapshot destination must be a real directory inside the project", destination);
  }
}

function lockIdentity(lock: SnapshotLock): Omit<SnapshotLock, "imported_at"> {
  const { imported_at: _importedAt, ...identity } = lock;
  return identity;
}

async function writeProjectUpdates(prepared: PreparedProject): Promise<void> {
  let manifestWritten = false;
  try {
    if (prepared.updatedManifestText !== prepared.manifestText) {
      await writeAtomic(prepared.manifestPath, prepared.updatedManifestText);
      manifestWritten = true;
    }
    if (prepared.updatedConfigText !== prepared.configText) {
      await writeAtomic(prepared.configPath, prepared.updatedConfigText);
    }
  } catch (error) {
    if (manifestWritten) await writeAtomic(prepared.manifestPath, prepared.manifestText);
    throw error;
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseShitateManifest(input: unknown, options: ShitateImportOptions): ShitateManifest {
  if (!isRecord(input)
    || typeof input.run_id !== "string"
    || typeof input.character !== "string"
    || typeof input.base_version !== "string"
    || typeof input.base_sha !== "string") {
    fail("shitate_import.manifest", "Shitate manifest is missing required identity fields");
  }
  if (input.character !== options.character || input.run_id !== options.runId) {
    fail("shitate_import.manifest_mismatch", "Shitate manifest identity does not match the requested snapshot");
  }
  return input as ShitateManifest;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail("shitate_import.json", error instanceof Error ? error.message : String(error), path);
  }
}

async function existingDirectory(path: string, code: string): Promise<string> {
  try {
    const resolved = await realpath(resolve(path));
    if (!(await stat(resolved)).isDirectory()) fail(code, "directory is required", path);
    return resolved;
  } catch (error) {
    if (error instanceof ShitateImportError) throw error;
    fail(code, "directory was not found", path);
  }
}

async function containedDirectory(candidate: string, root: string, code: string): Promise<string> {
  const resolved = await existingDirectory(candidate, code);
  if (!isWithin(resolved, root)) fail(code, "directory escapes its allowed root", candidate);
  return resolved;
}

async function containedFile(candidate: string, root: string, code: string): Promise<string> {
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!isWithin(resolvedFile, resolvedRoot)) fail(code, "file escapes its allowed root", candidate);
    if (!(await stat(resolvedFile)).isFile()) fail(code, "regular file is required", candidate);
    return resolvedFile;
  } catch (error) {
    if (error instanceof ShitateImportError) throw error;
    fail(code, "file was not found", candidate);
  }
}

function isWithin(candidate: string, root: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\\")) return false;
  return !path.split("/").some((part) => part === ".." || part === "" || part === ".");
}

function portableRelative(from: string, to: string): string {
  return relative(from, to).split("\\").join("/");
}

function executionPath(path: string): string {
  const fromCwd = portableRelative(process.cwd(), path);
  return fromCwd.startsWith("../") ? path : fromCwd;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ShitateImportError extends Error {
  constructor(readonly issue: Issue) {
    super(issue.message);
    this.name = "ShitateImportError";
  }
}

function fail(code: string, message: string, path?: string): never {
  throw new ShitateImportError({ code, message, ...(path ? { path } : {}) });
}
