import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Issue, Result } from "../types.js";
import type { GenerationRequest, Project } from "./schema.js";
import { toPortablePath } from "../platform/path.js";

export async function validateGenerationAssets(
  project: Project,
  configDir: string,
  assetRoot: string
): Promise<Result<{}>> {
  const issues: Issue[] = [];
  for (const [index, request] of project.generation?.requests.entries() ?? []) {
    if (request.first_frame) {
      const result = await resolveGenerationAsset(
        request.first_frame,
        configDir,
        assetRoot,
        `generation.requests.${index}.first_frame`,
        "generation.first_frame"
      );
      if (!result.ok) issues.push(...result.issues);
    }
    for (const [referenceIndex, referenceImage] of request.reference_images?.entries() ?? []) {
      const result = await resolveGenerationAsset(
        referenceImage,
        configDir,
        assetRoot,
        `generation.requests.${index}.reference_images.${referenceIndex}`,
        "generation.reference_images"
      );
      if (!result.ok) issues.push(...result.issues);
    }
    const extraAssets = [
      ...(request.input_images ?? []).map((source, assetIndex) => ({ source, field: "input_images", assetIndex })),
      ...(request.input_video ? [{ source: request.input_video, field: "input_video", assetIndex: 0 }] : []),
      ...(request.input_videos ?? []).map((source, assetIndex) => ({ source, field: "input_videos", assetIndex })),
      ...(request.input_audios ?? []).map((source, assetIndex) => ({ source, field: "input_audios", assetIndex }))
    ];
    for (const field of ["image", "video"] as const) {
      const source = localProviderInput(request.params[field]);
      if (source) extraAssets.push({ source, field: `params.${field}`, assetIndex: 0 });
    }
    for (const asset of extraAssets) {
      const result = await resolveGenerationAsset(
        asset.source,
        configDir,
        assetRoot,
        `generation.requests.${index}.${asset.field}${asset.field === "input_video" || asset.field.startsWith("params.") ? "" : `.${asset.assetIndex}`}`,
        `generation.${asset.field}`,
        asset.field.startsWith("params.")
      );
      if (!result.ok) issues.push(...result.issues);
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [] };
}

export async function pinGenerationAssets(
  requests: GenerationRequest[],
  configDir: string,
  assetRoot: string,
  runDir: string
): Promise<Result<{
  requests: GenerationRequest[];
  manifestPaths: Map<string, string>;
  referenceManifestPaths: Map<string, string[]>;
}>> {
  const prepared: GenerationRequest[] = [];
  const manifestPaths = new Map<string, string>();
  const referenceManifestPaths = new Map<string, string[]>();

  for (const [index, request] of requests.entries()) {
    let pinnedRequest = request;
    if (request.first_frame) {
      const resolved = await resolveGenerationAsset(
        request.first_frame,
        configDir,
        assetRoot,
        `generation.requests.${index}.first_frame`,
        "generation.first_frame"
      );
      if (!resolved.ok) return resolved;

      const relativePath = toPortablePath(join(
        "assets",
        "generation-inputs",
        request.id,
        `001-first-frame${extension(request.first_frame)}`
      ));
      const target = join(runDir, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolved.path, target);
      await assertVerifiedCopy(resolved.path, target, request.first_frame);
      pinnedRequest = { ...pinnedRequest, first_frame: target };
      manifestPaths.set(request.id, relativePath);
    }

    const pinnedReferences: string[] = [];
    const referencePaths: string[] = [];
    for (const [referenceIndex, referenceImage] of request.reference_images?.entries() ?? []) {
      const resolved = await resolveGenerationAsset(
        referenceImage,
        configDir,
        assetRoot,
        `generation.requests.${index}.reference_images.${referenceIndex}`,
        "generation.reference_images"
      );
      if (!resolved.ok) return resolved;

      const relativePath = toPortablePath(join(
        "assets",
        "generation-inputs",
        request.id,
        `${String(referenceIndex + 2).padStart(3, "0")}-reference${extension(referenceImage)}`
      ));
      const target = join(runDir, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolved.path, target);
      await assertVerifiedCopy(resolved.path, target, referenceImage);
      pinnedReferences.push(target);
      referencePaths.push(relativePath);
    }
    if (pinnedReferences.length > 0) {
      pinnedRequest = { ...pinnedRequest, reference_images: pinnedReferences };
      referenceManifestPaths.set(request.id, referencePaths);
    }
    for (const field of ["input_images", "input_videos", "input_audios"] as const) {
      const sources = request[field] ?? [];
      if (sources.length === 0) continue;
      const pinned: string[] = [];
      for (const [assetIndex, source] of sources.entries()) {
        const resolved = await resolveGenerationAsset(
          source,
          configDir,
          assetRoot,
          `generation.requests.${index}.${field}.${assetIndex}`,
          `generation.${field}`
        );
        if (!resolved.ok) return resolved;
        const relativePath = toPortablePath(join(
          "assets", "generation-inputs", request.id,
          `${field}-${String(assetIndex + 1).padStart(3, "0")}${extension(source)}`
        ));
        const target = join(runDir, relativePath);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(resolved.path, target);
        pinned.push(target);
      }
      pinnedRequest = { ...pinnedRequest, [field]: pinned };
    }
    if (request.input_video) {
      const resolved = await resolveGenerationAsset(
        request.input_video,
        configDir,
        assetRoot,
        `generation.requests.${index}.input_video`,
        "generation.input_video"
      );
      if (!resolved.ok) return resolved;
      const relativePath = toPortablePath(join(
        "assets", "generation-inputs", request.id, `input-video${extension(request.input_video)}`
      ));
      const target = join(runDir, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolved.path, target);
      pinnedRequest = { ...pinnedRequest, input_video: target };
    }
    let pinnedParams = pinnedRequest.params;
    for (const field of ["image", "video"] as const) {
      const source = localProviderInput(request.params[field]);
      if (!source) continue;
      const resolved = await resolveGenerationAsset(
        source,
        configDir,
        assetRoot,
        `generation.requests.${index}.params.${field}`,
        `generation.params.${field}`,
        true
      );
      if (!resolved.ok) return resolved;
      const relativePath = toPortablePath(join(
        "assets", "generation-inputs", request.id, `legacy-${field}${extension(source)}`
      ));
      const target = join(runDir, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolved.path, target);
      pinnedParams = { ...pinnedParams, [field]: target };
    }
    if (pinnedParams !== pinnedRequest.params) pinnedRequest = { ...pinnedRequest, params: pinnedParams };
    prepared.push(pinnedRequest);
  }

  return {
    ok: true,
    issues: [],
    requests: prepared,
    manifestPaths,
    referenceManifestPaths
  };
}

async function assertVerifiedCopy(source: string, target: string, label: string): Promise<void> {
  if (await sha256File(source) !== await sha256File(target)) {
    throw new Error(`generation asset changed while it was being pinned: ${label}`);
  }
}

async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolveDigest, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveDigest(hash.digest("hex")));
  });
}

export function projectAssetRoot(configDir: string, manifest: string): string {
  return manifest.startsWith("../") ? resolve(configDir, "..") : configDir;
}

async function resolveGenerationAsset(
  source: string,
  baseDir: string,
  assetRoot: string,
  path: string,
  codePrefix: string,
  allowAbsoluteWithinRoot = false
): Promise<Result<{ path: string }>> {
  if ((isAbsolute(source) && !allowAbsoluteWithinRoot) || source.includes("\\")) {
    return failure(`${codePrefix}.safe`, "generation asset must be a relative local path", path);
  }

  const root = resolve(assetRoot);
  const candidates = [resolve(baseDir, source)];
  if (allowAbsoluteWithinRoot && !isAbsolute(source)) candidates.push(resolve(process.cwd(), source));
  const candidate = candidates.find((item) => isWithin(root, item)) ?? candidates[0]!;
  if (!allowAbsoluteWithinRoot && !isWithin(root, candidate)) {
    return failure(`${codePrefix}.safe`, "generation asset must stay within the project asset root", path);
  }

  const symlink = !allowAbsoluteWithinRoot && await containsSymlink(root, candidate);
  if (symlink) {
    return failure(`${codePrefix}.symlink`, "generation asset paths must not contain symbolic links", path);
  }

  try {
    const inspected = await lstat(candidate);
    if (!inspected.isFile()) {
      return failure(`${codePrefix}.exists`, "generation asset must point to an existing regular file", path);
    }
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!isWithin(realRoot, realCandidate)) {
      return failure(`${codePrefix}.safe`, "generation asset must stay within the project asset root", path);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return failure(`${codePrefix}.exists`, "generation asset must point to an existing regular file", path);
    }
    return failure(`${codePrefix}.safe`, "generation asset could not be resolved safely", path);
  }

  return { ok: true, issues: [], path: candidate };
}

async function containsSymlink(root: string, candidate: string): Promise<boolean> {
  const fromRoot = relative(root, candidate);
  let current = root;
  for (const part of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function localProviderInput(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (/^https:\/\//i.test(value) || /^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  return value;
}

function failure(code: string, message: string, path: string): { ok: false; issues: Issue[] } {
  return { ok: false, issues: [{ code, message, path }] };
}
