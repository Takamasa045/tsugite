import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep, resolve } from "node:path";
import type { Project } from "../project/schema.js";
import type { Manifest } from "../manifest/schema.js";
import { digest } from "../orchestrator/editorialProposal.js";
import { ArtifactStore } from "../productionControl/artifactStore.js";
import {
  buildJevRequest,
  compileFastEdit,
  decisionsFromAnswers,
  splitBeats,
  wordsFromAnalysis,
} from "./compile.js";

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function contained(root: string, path: string) {
  const [r, p] = await Promise.all([realpath(root), realpath(path)]);
  const rel = relative(r, p);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("Fast Edit artifact/source escapes project");
  return p;
}
export async function fastEditContext(
  configPath: string,
  project: Project,
  source: Manifest,
  stateDir?: string,
) {
  if (!project.edit.fast_edit?.enabled)
    throw new Error("edit.fast_edit.enabled must be true");
  if (
    project.edit.editorial ||
    project.edit.composition ||
    project.generation?.requests.length
  )
    throw new Error(
      "Fast Edit v1 requires an existing source timeline without other edit modes or generation",
    );
  const root = await realpath(dirname(resolve(configPath)));
  const runDir = await realpath(
    join(
      stateDir ? resolve(stateDir) : resolve(root, project.dist_dir),
      project.run_id ?? project.slug,
    ),
  );
  await contained(root, runDir);
  const rawPath = await contained(
    root,
    join(runDir, "analysis/raw-analysis.json"),
  );
  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  const sourceDigests: Record<string, string> = {};
  for (const clip of source.clips) {
    const path = await contained(
      root,
      resolve(dirname(resolve(root, project.manifest)), clip.src),
    );
    const sha = await hashFile(path);
    sourceDigests[clip.id] = sha;
    const matches = raw.results?.filter(
      (r: {
        adapter: string;
        metadata?: { api_used: boolean; network_used: boolean };
        output: string;
        source: {
          clip_id: string;
          sha256: string;
          analysis_start_seconds: number;
          analysis_end_seconds: number;
        };
      }) =>
        r.metadata?.api_used === false &&
        r.metadata?.network_used === false &&
        r.output === "transcript" &&
        r.source.clip_id === clip.id &&
        r.source.sha256 === sha &&
        r.source.analysis_start_seconds <= clip.in &&
        r.source.analysis_end_seconds >= clip.out,
    );
    if (matches?.length !== 1)
      throw new Error(
        `Whisper transcript does not match current source bytes/range: ${clip.id}`,
      );
  }
  const words = wordsFromAnalysis(source, raw),
    duration = source.clips.reduce((n, c) => n + c.duration, 0);
  const beats = splitBeats(
    words,
    duration,
    project.edit.fast_edit.beat_seconds,
  );
  const request = buildJevRequest(words, beats);
  const binding = {
    source_manifest_digest: digest(source),
    analysis_digest: digest(raw),
    source_digests: sourceDigests,
    request_digest: digest(request),
  };
  const bindingDigest = digest(binding);
  return {
    runDir,
    words,
    beats,
    request,
    binding,
    bindingDigest,
    artifactRoot: join(runDir, "fast-edit"),
    artifactId: `decisions-${bindingDigest}`,
  };
}
export type JevAsk = (
  request: ReturnType<typeof buildJevRequest>,
) => Promise<unknown>;
export async function prepareFastEdit(
  configPath: string,
  project: Project,
  source: Manifest,
  options: { stateDir?: string; answers?: unknown; ask?: JevAsk } = {},
) {
  const ctx = await fastEditContext(
    configPath,
    project,
    source,
    options.stateDir,
  );
  await mkdir(ctx.artifactRoot, { recursive: true });
  await contained(dirname(resolve(configPath)), ctx.artifactRoot);
  const store = new ArtifactStore(ctx.artifactRoot);
  const save = async (id: string, value: unknown) => {
    const bytes = JSON.stringify(value, null, 2) + "\n";
    const path = join(ctx.artifactRoot, "artifacts", `${id}.json`);
    try {
      const existing = await readFile(
        await contained(dirname(resolve(configPath)), path),
        "utf8",
      );
      if (existing !== bytes)
        throw new Error(
          "Fast Edit artifact already exists with different content; use a new run_id",
        );
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await store.create({ artifact_id: id, bytes });
    return path;
  };
  const requestPath = await save(`request-${ctx.bindingDigest}`, {
    ...ctx.binding,
    request: ctx.request,
  });
  if (options.answers === undefined && !options.ask)
    return {
      ok: true,
      status: "awaiting_decisions",
      question_count: ctx.request.questions.length,
      request_path: requestPath,
    };
  const answers = options.answers ?? (await options.ask!(ctx.request));
  // Preserve the actual response even when uncertain/malformed; never synthesize an approval.
  const responsePath = await save(`response-${digest(answers)}`, answers);
  const decisions = decisionsFromAnswers(ctx.words, ctx.beats, answers);
  const compilation = compileFastEdit(source, decisions);
  const artifactPath = await save(ctx.artifactId, {
    schema_version: 1,
    ...ctx.binding,
    decisions,
    edl: compilation.edl,
  });
  return {
    ok: true,
    status: "compiled",
    question_count: ctx.request.questions.length,
    request_path: requestPath,
    response_path: responsePath,
    artifact_path: artifactPath,
    edl_digest: compilation.edl.digest,
  };
}
export async function loadFastEdit(
  configPath: string,
  project: Project,
  source: Manifest,
) {
  const ctx = await fastEditContext(configPath, project, source);
  await contained(dirname(resolve(configPath)), ctx.artifactRoot);
  const artifact = JSON.parse(
    (
      await new ArtifactStore(ctx.artifactRoot).readBounded(
        ctx.artifactId,
        8 * 1024 * 1024,
      )
    ).toString("utf8"),
  );
  for (const [key, value] of Object.entries(ctx.binding))
    if (digest(artifact[key]) !== digest(value))
      throw new Error(`Fast Edit stale ${key}`);
  if (
    digest(artifact.decisions.words) !== digest(ctx.words) ||
    digest(
      artifact.decisions.beats.map(
        ({
          id,
          start,
          end,
          word_ids,
        }: {
          id: string;
          start: number;
          end: number;
          word_ids: string[];
        }) => ({ id, start, end, word_ids }),
      ),
    ) !== digest(ctx.beats)
  )
    throw new Error("Fast Edit words/beats no longer match analysis");
  const compiled = compileFastEdit(source, artifact.decisions);
  if (digest(compiled.edl) !== digest(artifact.edl))
    throw new Error("Fast Edit EDL mismatch");
  return compiled;
}
