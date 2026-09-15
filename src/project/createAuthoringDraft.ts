import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAuthoringEngineRun } from "../productionControl/authoringEngine.js";
import { PipelineError } from "../types.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NAME_MAX = 120;
const BRIEF_MAX = 4_000;

export type CreateAuthoringDraftInput = {
  projectsHome: string;
  name?: string;
  brief?: string;
  adapterId?: string;
};

export type CreatedAuthoringDraft = {
  adapterId: string;
  slug: string;
  name: string;
  projectRoot: string;
  configPath: string;
};

type DraftSpec = {
  adapterId: string;
  engineAdapterId: string;
  unusedHistoricalBackend: string;
  state: string;
  workspace: string;
};

async function loadDraftFactory(): Promise<{
  getAuthoringDraftSpec: (adapterId: string) => DraftSpec | undefined;
  defaultDraftAuthoringAdapterId: () => string | undefined;
}> {
  const modulePath = join(REPO_ROOT, "adapters", "authoringDraftFactory.mjs");
  return await import(pathToFileURL(modulePath).href) as {
    getAuthoringDraftSpec: (adapterId: string) => DraftSpec | undefined;
    defaultDraftAuthoringAdapterId: () => string | undefined;
  };
}

export async function createAuthoringDraft(
  input: CreateAuthoringDraftInput
): Promise<CreatedAuthoringDraft> {
  const factory = await loadDraftFactory();
  const adapterId = input.adapterId ?? factory.defaultDraftAuthoringAdapterId();
  if (!adapterId) {
    throw new PipelineError({
      code: "authoring.adapter_unregistered",
      message: "no registered authoring adapter can create a draft"
    });
  }
  const spec = factory.getAuthoringDraftSpec(adapterId);
  if (!spec) {
    throw new PipelineError({
      code: "authoring.adapter_unregistered",
      message: "authoring adapter cannot create a draft",
      path: "production.adapter"
    });
  }
  const name = normalizeName(input.name);
  const brief = normalizeBrief(input.brief, name);
  const slug = await allocateSlug(input.projectsHome);
  const projectRoot = join(input.projectsHome, slug);
  await mkdir(join(projectRoot, spec.workspace), { recursive: true, mode: 0o700 });
  await mkdir(join(projectRoot, ".tsugite", "authoring"), { recursive: true, mode: 0o700 });
  const run = createAuthoringEngineRun({
    production_id: slug,
    adapter_id: spec.engineAdapterId,
    brief_digest: sha256(brief),
    reference_digest: null,
    import_allowlist_digest: sha256(`draft:${spec.adapterId}`)
  });
  const state = {
    productionRoot: projectRoot,
    workspace: join(projectRoot, spec.workspace),
    brief,
    instruction: "",
    run,
    ui: { progress: "draft", fake: false }
  };
  await writeFile(join(projectRoot, spec.state), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    join(projectRoot, "manifest.json"),
    `${JSON.stringify({
      meta: { aspect: "9:16", fps: 30, target_duration_seconds: 30, slug },
      clips: [],
      audio: { bgm: [], narration: [], sfx: [] }
    }, null, 2)}\n`
  );
  await writeFile(join(projectRoot, "project.yaml"), renderAuthoringProjectYaml({
    slug,
    name,
    adapterId: spec.adapterId,
    state: spec.state,
    workspace: spec.workspace,
    backend: spec.unusedHistoricalBackend
  }));
  return {
    adapterId: spec.adapterId,
    slug,
    name,
    projectRoot,
    configPath: join(projectRoot, "project.yaml")
  };
}

function normalizeName(value: string | undefined): string {
  const name = value?.trim() ?? "";
  if (!name) return "参考動画から作る制作";
  if (name.length > NAME_MAX) {
    throw new PipelineError({
      code: "authoring.draft_name_invalid",
      message: `name must be at most ${NAME_MAX} characters`,
      path: "name"
    });
  }
  return name;
}

function normalizeBrief(value: string | undefined, name: string): string {
  const brief = value?.trim() ?? "";
  if (brief.length > BRIEF_MAX) {
    throw new PipelineError({
      code: "authoring.draft_brief_invalid",
      message: `brief must be at most ${BRIEF_MAX} characters`,
      path: "brief"
    });
  }
  return brief || name;
}

async function allocateSlug(projectsHome: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slug = `draft-${day}-${randomBytes(4).toString("hex")}`;
    try {
      await mkdir(join(projectsHome, slug), { recursive: false, mode: 0o700 });
      return slug;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new PipelineError({
    code: "authoring.draft_id_conflict",
    message: "could not allocate a unique authoring project id"
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function renderAuthoringProjectYaml(input: {
  slug: string;
  name: string;
  adapterId: string;
  state: string;
  workspace: string;
  backend: string;
}): string {
  return [
    `slug: ${input.slug}`,
    `name: ${yamlScalar(input.name)}`,
    `run_id: ${input.slug}`,
    "production:",
    "  kind: authoring",
    `  adapter: ${input.adapterId}`,
    `  state: ${input.state}`,
    `  workspace: ${input.workspace}`,
    "manifest: manifest.json",
    "dist_dir: dist",
    "edit:",
    `  backend: ${input.backend}`,
    ""
  ].join("\n");
}
