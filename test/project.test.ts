import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadProject } from "../src/project/loadProject.js";
import { projectSchema, toExecutionProject } from "../src/project/schema.js";
import { validateProject } from "../src/project/validateProject.js";

describe("project validation", () => {
  it("loads a valid project.yaml", async () => {
    const project = await loadProject("fixtures/projects/local-valid.yaml");

    expect(project.slug).toBe("local-fixture");
    expect(project.edit.backend).toBe("remotion");
  });

  it("accepts an explicit editorial policy for analysis-derived cuts and captions", () => {
    const project = validProjectDefinition();
    project.edit = {
      backend: "remotion",
      editorial: {
        remove_kinds: ["filler"],
        remove_ids: ["silence-0001"],
        exclude_ids: ["filler-0002"],
        captions: { request_id: "subtitles-en" },
        chapters: { request_id: "chapters-ja" }
      }
    };
    project.analysis = {
      adapter: "fixture-adapter",
      requests: [
        { ...requestDefinition("analysis", "subtitles-en"), output: "subtitle_track" },
        { ...requestDefinition("analysis", "chapters-ja"), output: "chapters" }
      ]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.edit.editorial).toEqual({
        remove_kinds: ["filler"],
        remove_ids: ["silence-0001"],
        exclude_ids: ["filler-0002"],
        captions: { request_id: "subtitles-en" },
        chapters: { request_id: "chapters-ja" }
      });
    }
  });

  it("rejects editorial execution without analysis and rejects unsafe decision ids", () => {
    const withoutAnalysis = validProjectDefinition();
    withoutAnalysis.edit = {
      backend: "remotion",
      editorial: { remove_kinds: ["filler"] }
    };
    const unsafe = validProjectDefinition();
    unsafe.edit = {
      backend: "remotion",
      editorial: { remove_ids: ["../outside"] }
    };
    unsafe.analysis = {
      adapter: "fixture-adapter",
      requests: [requestDefinition("analysis", "transcript-ja")]
    };

    expect(projectSchema.safeParse(withoutAnalysis).success).toBe(false);
    expect(projectSchema.safeParse(unsafe).success).toBe(false);
  });

  it("rejects editorial execution together with generated clips until that timing contract is supported", () => {
    const project = validProjectDefinition();
    project.edit = {
      backend: "remotion",
      editorial: { remove_kinds: ["filler"] }
    };
    project.analysis = {
      adapter: "fixture-adapter",
      requests: [requestDefinition("analysis", "transcript-ja")]
    };
    project.generation = {
      adapter: "fixture-adapter",
      requests: [requestDefinition("generation", "generated-clip")]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: "edit.editorial cannot be combined with generation requests",
          path: ["generation"]
        })
      ]));
    }
  });

  it("rejects an unknown backend during validation", async () => {
    const result = await validateProject("fixtures/projects/unknown-backend.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("backend.not_found");
  });

  it("reports project schema errors", async () => {
    const result = await validateProject("fixtures/projects/invalid-schema.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("project.schema");
  });

  it("rejects unsafe run ids before state paths can be written", async () => {
    const result = await validateProject("fixtures/projects/bad-run-id.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("project.schema");
  });

  it("rejects unsafe backend ids before runner paths can be built", async () => {
    const root = await createProjectRoot();
    await writeProject(root, {
      clips: [clip({ src: "../media/clip.mp4" })]
    });
    await writeFile(join(root, "media/clip.mp4"), "not a real video");
    await writeFile(
      join(root, "projects/project.yaml"),
      [
        "slug: unsafe-backend",
        "run_id: unsafe-backend-run",
        "manifest: ../manifests/manifest.json",
        "dist_dir: dist",
        "edit:",
        "  backend: ../outside"
      ].join("\n")
    );

    const result = await validateProject(join(root, "projects/project.yaml"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("project.schema");
  });

  it.each(["generation", "analysis"] as const)("rejects unsafe %s request ids", (requestKind) => {
    const project = validProjectDefinition();
    project[requestKind] = {
      adapter: "fixture-adapter",
      requests: [requestDefinition(requestKind, "../escape")]
    };

    const result = projectSchema.safeParse(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([requestKind, "requests", 0, "id"]);
    }
  });

  it.each(["generation", "analysis"] as const)("rejects unsafe %s adapter names", (requestKind) => {
    const project = validProjectDefinition();
    project[requestKind] = {
      adapter: "../outside-adapter",
      requests: [requestDefinition(requestKind, "safe-request")]
    };

    const result = projectSchema.safeParse(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([requestKind, "adapter"]);
    }
  });

  it("accepts a generation connection without requiring the legacy adapter field", () => {
    const parsed = projectSchema.safeParse({
      ...validProjectDefinition(),
      generation: {
        connection: "pixverse-main",
        requests: [requestDefinition("generation", "connected-request")]
      }
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.generation).toMatchObject({
        connection: "pixverse-main",
        requests: [expect.objectContaining({ id: "connected-request" })]
      });
      expect(parsed.data.generation).not.toHaveProperty("adapter");
    }
  });

  it("asks which service to use when generation requests have no connection", async () => {
    const result = await validateProject("fixtures/projects/generation-connection-required.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: "generation.connection_required",
      message: "どのサービスを使って生成しますか？ `pipeline connections --json` で利用可能な候補を確認してください。",
      path: "generation.connection"
    });
    expect(result.issues.map((issue) => issue.code)).not.toContain("project.schema");
    expect(result.adapter).toBeUndefined();
  });

  it("resolves an explicit generation connection to its execution adapter", async () => {
    const result = await validateProject("fixtures/projects/generation-connection-topview.yaml");

    expect(result.ok).toBe(true);
    expect(result.adapter?.name).toBe("topview");
    expect(result.project?.generation).toMatchObject({
      connection: "topview",
      adapter: "topview"
    });
  });

  it("normalizes a spoken generation connection alias before adapter execution", async () => {
    const result = await validateProject("fixtures/projects/generation-connection-pixburst-alias.yaml");

    expect(result.ok).toBe(true);
    expect(result.adapter?.name).toBe("pixverse");
    expect(result.project?.generation).toMatchObject({
      connection: "pixverse",
      adapter: "pixverse"
    });
  });

  it("asks before using a known paid adapter without an explicit service connection", async () => {
    const result = await validateProject("fixtures/projects/generation-known-adapter-connection-required.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: "generation.connection_required",
      message: "どのサービスを使って生成しますか？ 候補 'pixverse' を generation.connection に明示してください。",
      path: "generation.connection"
    });
    expect(result.adapter).toBeUndefined();
  });

  it("asks before using an unregistered external adapter without a connection", async () => {
    const result = await validateProject("fixtures/projects/openclaw-connection-required.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "generation.connection_required",
      path: "generation.connection"
    }));
  });

  it("asks with every candidate when one adapter has multiple connection routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-project-connections-"));
    const catalogPath = join(root, "catalog.yaml");
    await writeFile(catalogPath, `
schema_version: 1
selection_prompt:
  id: generation-connection
  question: choose
  required_when: connection-unspecified
  instruction: ask
  no_subscription_message: none
  no_subscription_options: [generate-later]
connections:
  - id: pixverse-route-one
    display_name: PixVerse route one
    provider: first
    transport: cli
    auth_kind: subscription
    implementation_status: integrated
    adapter: pixverse
    capabilities: [video.text-to-video]
    automated_capabilities: [video.text-to-video]
    model_families: [pixverse]
    route_note: first
    setup_checks:
      - type: manual
        detail: verify first
  - id: pixverse-route-two
    display_name: PixVerse route two
    provider: second
    transport: cli
    auth_kind: subscription
    implementation_status: integrated
    adapter: pixverse
    capabilities: [video.text-to-video]
    automated_capabilities: [video.text-to-video]
    model_families: [pixverse]
    route_note: second
    setup_checks:
      - type: manual
        detail: verify second
`);

    const result = await validateProject(
      "fixtures/projects/generation-known-adapter-connection-required.yaml",
      { connectionCatalogPath: catalogPath }
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "generation.connection_required",
      message: "どのサービスを使って生成しますか？ 候補 'pixverse-route-one', 'pixverse-route-two' から generation.connection を明示してください。"
    }));
  });

  it("stops when explicit generation connection and legacy adapter disagree", async () => {
    const result = await validateProject("fixtures/projects/generation-connection-mismatch.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: "generation.connection_adapter_mismatch",
      message: "connection 'topview' uses adapter 'topview', not 'pixverse'",
      path: "generation.adapter"
    });
    expect(result.adapter).toBeUndefined();
  });

  it("stops when a removed legacy connection id is requested", async () => {
    const result = await validateProject("fixtures/projects/generation-connection-incompatible.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: "generation.connection_unavailable",
      message: "connection 'kling-via-pixverse' is not integrated for generation",
      path: "generation.connection"
    });
    expect(result.adapter).toBeUndefined();
  });

  it("checks an omitted input mode as text-to-video instead of bypassing automation compatibility", async () => {
    const result = await validateProject("fixtures/projects/generation-connection-default-t2v.yaml", {
      connectionCatalogPath: "fixtures/connections/image-only.catalog.yaml"
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "generation.connection_incompatible",
      path: "generation.requests"
    }));
    expect(result.adapter).toBeUndefined();
  });

  it("keeps a generation request without connection as a validation concern", () => {
    const parsed = projectSchema.safeParse({
      ...validProjectDefinition(),
      generation: {
        requests: [requestDefinition("generation", "unrouted-request")]
      }
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects unsafe generation connection names", () => {
    const parsed = projectSchema.safeParse({
      ...validProjectDefinition(),
      generation: {
        connection: "../outside-connection",
        requests: [requestDefinition("generation", "safe-request")]
      }
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["generation", "connection"]);
    }
  });

  it("rejects secret-like keys in generation params even when the value names an environment variable", () => {
    const project = validProjectDefinition();
    project.generation = {
      adapter: "fixture-adapter",
      requests: [
        {
          ...requestDefinition("generation", "secret-param"),
          params: { provider: { api_key: "PROVIDER_API_KEY" } }
        }
      ]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        message: "generation credentials must use adapter-declared environment variables",
        path: ["generation", "requests", 0, "params", "provider", "api_key"]
      }));
    }
  });

  it("rejects secret-like keys in audio params", () => {
    const parsed = projectSchema.safeParse({
      ...validProjectDefinition(),
      audio: {
        adapter: "hyperframes-media",
        bgm: {
          id: "main-bgm",
          prompt: "warm cinematic underscore"
        },
        params: { auth: { token: "must-not-be-stored" } }
      }
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        message: "audio credentials must use adapter-declared environment variables",
        path: ["audio", "params", "auth", "token"]
      }));
    }
  });

  it.each([
    "authorization",
    "cookie",
    "session_cookie",
    "session-cookie",
    "refresh_token",
    "secret_key",
    "private_key",
    "x_api_key",
    "api_token",
    "session_token",
    "authorization_header",
    "api_secret",
    "client_token",
    "auth_header",
    "access_key",
    "signing_key",
    "id_token"
  ])("rejects normalized secret parameter key '%s'", (key) => {
    const parsed = projectSchema.safeParse({
      ...validProjectDefinition(),
      audio: {
        adapter: "hyperframes-media",
        bgm: { id: "main-bgm", prompt: "warm cinematic underscore" },
        params: { auth: { [key]: "must-not-be-stored" } }
      }
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        message: "audio credentials must use adapter-declared environment variables",
        path: ["audio", "params", "auth", key]
      }));
    }
  });

  it.each(["generation", "analysis"] as const)("rejects top-level secret fields in %s requests", (requestKind) => {
    const project = validProjectDefinition();
    project[requestKind] = {
      ...(requestKind === "analysis" ? { mode: "cloud" as const } : {}),
      adapter: "fixture-adapter",
      requests: [{ ...requestDefinition(requestKind, "top-level-secret"), api_secret: "must-not-be-stored" }]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: [requestKind, "requests", 0, "api_secret"]
      }));
    }
  });

  it("allows non-secret parameter keys to refer to adapter-declared environment variables", () => {
    const parsed = projectSchema.safeParse({
      ...validProjectDefinition(),
      generation: {
        adapter: "fixture-adapter",
        requests: [
          {
            ...requestDefinition("generation", "environment-reference"),
            params: { credential_environment_variable: "PROVIDER_API_KEY" }
          }
        ]
      },
      audio: {
        adapter: "hyperframes-media",
        bgm: {
          id: "main-bgm",
          prompt: "warm cinematic underscore"
        },
        params: { environment_variable: "AUDIO_API_KEY" }
      }
    });

    expect(parsed.success).toBe(true);
  });

  it.each([
    ["api_key_environment_variable", "sk-live-secret"],
    ["apiKeyEnv", "sk-live-secret"],
    ["credential_environment_variable", "not-an-environment-name"]
  ])("rejects a literal secret disguised as environment reference '%s'", (key, value) => {
    const project = validProjectDefinition();
    project.generation = {
      adapter: "fixture-adapter",
      requests: [{
        ...requestDefinition("generation", "invalid-environment-reference"),
        params: { [key]: value }
      }]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: ["generation", "requests", 0, "params", key]
      }));
    }
  });

  it("rejects a literal secret in a nested auth environment reference", () => {
    const project = validProjectDefinition();
    project.generation = {
      adapter: "fixture-adapter",
      requests: [{
        ...requestDefinition("generation", "nested-invalid-environment-reference"),
        auth: { environment_variable: "sk-live-secret" }
      }]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: ["generation", "requests", 0, "auth", "environment_variable"]
      }));
    }
  });

  it.each([
    ["header", "Bearer must-not-be-stored"],
    ["value", "must-not-be-stored"]
  ])("rejects non-environment field '%s' inside an auth object", (key, value) => {
    const project = validProjectDefinition();
    project.generation = {
      adapter: "fixture-adapter",
      requests: [{
        ...requestDefinition("generation", "unsafe-auth-object"),
        params: { auth: { [key]: value } }
      }]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: ["generation", "requests", 0, "params", "auth", key]
      }));
    }
  });

  it.each(["generation", "analysis"] as const)("rejects duplicate %s request ids", (requestKind) => {
    const project = validProjectDefinition();
    project[requestKind] = {
      adapter: "fixture-adapter",
      requests: [requestDefinition(requestKind, "duplicate"), requestDefinition(requestKind, "duplicate")]
    };

    const result = projectSchema.safeParse(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "request ids must be unique",
            path: [requestKind, "requests", 1, "id"]
          })
        ])
      );
    }
  });

  it("loads every request-selected analysis adapter once while preserving the default adapter", async () => {
    const result = await validateProject("fixtures/projects/multi-analysis-adapters.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(true);
    expect(result.analysisAdapter?.name).toBe("mock-cli-analysis");
    expect(result.analysisAdapters?.map((adapter) => adapter.name)).toEqual([
      "mock-cli-transcription",
      "mock-cli-analysis"
    ]);
  });

  it("rejects an editorial caption track when the selected backend cannot render captions", async () => {
    const result = await validateProject("fixtures/projects/editorial-captions-limited.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"],
      backendDirs: ["fixtures/backends", "backends"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "backend.capability.captions" }));
  });

  it.each([
    ["analysis-request-adapter-not-found.yaml", "adapter.not_found"],
    ["analysis-request-class-mismatch.yaml", "adapter.class_mismatch"],
    ["analysis-request-offline-mismatch.yaml", "analysis.offline_contract_required"],
    ["analysis-request-output-mismatch.yaml", "analysis.output_unsupported"]
  ])("validates each request-selected adapter in %s", async (fixture, code) => {
    const result = await validateProject(`fixtures/projects/${fixture}`, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code }));
  });

  it.each([
    ["analysis-dependency-unknown.yaml", "analysis.dependency_not_found"],
    ["analysis-dependency-cycle.yaml", "analysis.dependency_cycle"],
    ["analysis-dependency-source-mismatch.yaml", "analysis.dependency_source_mismatch"],
    ["analysis-dependency-adapter-mismatch.yaml", "analysis.dependency_adapter_mismatch"]
  ])("rejects an invalid analysis dependency graph in %s", async (fixture, code) => {
    const result = await validateProject(`fixtures/projects/${fixture}`, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code }));
  });

  it("accepts explicit prompt guidance metadata without defaulting existing requests", () => {
    const project = validProjectDefinition();
    project.generation = {
      adapter: "fixture-adapter",
      requests: [
        {
          ...requestDefinition("generation", "guided-request"),
          input_mode: "image-to-video",
          prompt_guide: { catalog: "seedance", model: "seedance-2.0" }
        }
      ]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.generation?.requests[0]).toMatchObject({
        input_mode: "image-to-video",
        prompt_guide: { catalog: "seedance", model: "seedance-2.0" }
      });
    }
  });

  it("accepts mode and first_frame for a first-class image-to-video request", () => {
    const project = validProjectDefinition();
    project.generation = {
      adapter: "topview",
      requests: [
        {
          ...requestDefinition("generation", "opening-shot"),
          mode: "image-to-video",
          first_frame: "assets/opening.png"
        }
      ]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.generation?.requests[0]).toMatchObject({
        mode: "image-to-video",
        first_frame: "assets/opening.png"
      });
    }
  });

  it.each([
    ["missing", "assets/missing.png", "generation.first_frame.exists"],
    ["outside", "../../outside.png", "generation.first_frame.safe"]
  ])("rejects a %s generation first_frame", async (_kind, firstFrame, code) => {
    const root = await createGenerationProjectRoot(firstFrame);

    const result = await validateProject(join(root, "projects/project.yaml"));

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code }));
  });

  it("rejects absolute and symbolic-link generation first_frame paths", async () => {
    const absoluteRoot = await createGenerationProjectRoot("/tmp/outside.png");
    const linkedRoot = await createGenerationProjectRoot("assets/opening-link.png");
    await mkdir(join(linkedRoot, "projects/assets"), { recursive: true });
    await writeFile(join(linkedRoot, "projects/assets/opening.png"), "fixture image");
    await symlink("opening.png", join(linkedRoot, "projects/assets/opening-link.png"));

    const absolute = await validateProject(join(absoluteRoot, "projects/project.yaml"));
    const linked = await validateProject(join(linkedRoot, "projects/project.yaml"));

    expect(absolute.issues).toContainEqual(expect.objectContaining({ code: "generation.first_frame.safe" }));
    expect(linked.issues).toContainEqual(expect.objectContaining({ code: "generation.first_frame.symlink" }));
  });

  it("keeps advisory guide selectors out of execution input while retaining input mode", () => {
    const parsed = projectSchema.parse({
      ...validProjectDefinition(),
      generation: {
        adapter: "fixture-adapter",
        requests: [
          {
            ...requestDefinition("generation", "guided-execution"),
            input_mode: "image-to-video",
            prompt_guide: { catalog: "seedance" }
          }
        ]
      }
    });

    const execution = toExecutionProject(parsed);

    expect(execution.generation?.requests[0]).not.toHaveProperty("prompt_guide");
    expect(execution.generation?.requests[0]?.input_mode).toBe("image-to-video");
    expect(parsed.generation?.requests[0]?.prompt_guide?.catalog).toBe("seedance");
  });

  it("normalizes the legacy generation mode alias for adapter execution", () => {
    const parsed = projectSchema.parse({
      ...validProjectDefinition(),
      generation: {
        adapter: "fixture-adapter",
        requests: [
          {
            ...requestDefinition("generation", "legacy-mode"),
            mode: "image-to-video",
            prompt_guide: { catalog: "seedance" }
          }
        ]
      }
    });

    const executionRequest = toExecutionProject(parsed).generation?.requests[0];

    expect(executionRequest).not.toHaveProperty("prompt_guide");
    expect(executionRequest).not.toHaveProperty("mode");
    expect(executionRequest?.input_mode).toBe("image-to-video");
    expect(parsed.generation?.requests[0]?.mode).toBe("image-to-video");
  });

  it("parses an explicit fail-closed audio generation request", () => {
    const parsed = projectSchema.parse({
      ...validProjectDefinition(),
      audio: {
        adapter: "hyperframes-media",
        bgm: {
          id: "main-bgm",
          mode: "generate",
          prompt: "warm cinematic underscore",
          volume: 0.2
        },
        sfx: [
          {
            id: "opening-whoosh",
            prompt: "soft whoosh",
            start: 0.25
          }
        ]
      }
    });

    expect(parsed.audio).toMatchObject({
      adapter: "hyperframes-media",
      fallback: "fail",
      bgm: {
        id: "main-bgm",
        mode: "generate",
        start: 0,
        volume: 0.2
      },
      sfx: [
        {
          id: "opening-whoosh",
          prompt: "soft whoosh",
          start: 0.25
        }
      ]
    });
  });

  it("resolves an audio connection to its canonical adapter", async () => {
    const result = await validateProject("fixtures/projects/audio-connection.yaml");

    expect(result.ok).toBe(true);
    expect(result.project?.audio).toMatchObject({
      connection: "hyperframes-media",
      adapter: "hyperframes-media"
    });
    expect(result.audioConnection).toMatchObject({
      id: "hyperframes-media",
      adapter: "hyperframes-media",
      transport: "cli"
    });
  });

  it("asks which service to use when an audio connection and adapter are both absent", async () => {
    const result = await validateProject("fixtures/projects/audio-connection-required.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "audio.connection_required",
      message: expect.stringContaining("どのサービスを使って生成しますか？"),
      path: "audio.connection"
    }));
  });

  it("asks before using a known audio adapter without an explicit service connection", async () => {
    const result = await validateProject("fixtures/projects/audio-known-adapter-connection-required.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: "audio.connection_required",
      message: "どのサービスを使って生成しますか？ 候補 'hyperframes-media' を audio.connection に明示してください。",
      path: "audio.connection"
    });
    expect(result.audioAdapter).toBeUndefined();
  });

  it.each([
    ["audio-connection-incompatible.yaml", "audio.connection_incompatible"],
    ["audio-connection-mismatch.yaml", "audio.connection_adapter_mismatch"]
  ])("rejects an invalid audio connection contract in %s", async (fixture, code) => {
    const result = await validateProject(`fixtures/projects/${fixture}`, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code }));
  });

  it("rejects an audio request that has neither BGM nor SFX", () => {
    const parsed = projectSchema.safeParse({
      ...validProjectDefinition(),
      audio: {
        adapter: "hyperframes-media"
      }
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["audio"]);
    }
  });

  it("rejects unsafe prompt guide catalog ids", () => {
    const project = validProjectDefinition();
    project.generation = {
      adapter: "fixture-adapter",
      requests: [
        {
          ...requestDefinition("generation", "unsafe-guide"),
          prompt_guide: { catalog: "../outside" }
        }
      ]
    };

    const parsed = projectSchema.safeParse(project);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["generation", "requests", 0, "prompt_guide", "catalog"]);
    }
  });

  it("rejects manifest paths that escape beyond the project asset root", async () => {
    const root = await createProjectRoot();
    await writeFile(
      join(root, "projects/project.yaml"),
      [
        "slug: unsafe-manifest",
        "run_id: unsafe-manifest-run",
        "manifest: ../../outside/manifest.json",
        "dist_dir: dist",
        "edit:",
        "  backend: remotion"
      ].join("\n")
    );

    const result = await validateProject(join(root, "projects/project.yaml"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("project.schema");
  });

  it("reports missing manifest files as validation issues", async () => {
    const result = await validateProject("fixtures/projects/missing-manifest.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.read_failed");
  });

  it("reports malformed backend definitions as structured issues", async () => {
    const result = await validateProject("fixtures/projects/malformed-backend.yaml", {
      backendDirs: ["fixtures/backends", "backends"]
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("backend.schema");
    expect(result.issues.map((issue) => issue.code)).not.toContain("backend.not_found");
  });

  it("resolves manifest paths relative to the config file", async () => {
    const result = await validateProject("fixtures/projects/local-valid.yaml");

    expect(result.ok).toBe(true);
    expect(result.manifest?.clips[0]?.src).toBe("../media/clip-001.mp4");
  });

  it("accepts local media projects without generation requests", async () => {
    const result = await validateProject("fixtures/projects/local-media-only.yaml");

    expect(result.ok).toBe(true);
    expect(result.project?.generation).toBeUndefined();
  });

  it("accepts a Remotion article dialogue project with local character images", async () => {
    const result = await validateProject("fixtures/projects/dialogue-remotion.yaml");

    expect(result.ok).toBe(true);
    expect(result.manifest?.images).toHaveLength(2);
  });

  it("reports missing local image assets", async () => {
    const result = await validateProject("fixtures/projects/missing-image-asset.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.image.src.exists");
  });

  it("reports missing local clip assets", async () => {
    const result = await validateProject("fixtures/projects/missing-asset.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.clip.src.exists");
  });

  it("rejects asset paths that point to directories", async () => {
    const result = await validateProject("fixtures/projects/directory-asset.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.clip.src.exists");
  });

  it("reports missing local audio track assets", async () => {
    const result = await validateProject("fixtures/projects/missing-audio-asset.yaml");

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.audio.src.exists");
  });

  it("rejects absolute clip asset paths before copying into a run", async () => {
    const root = await createProjectRoot();
    const outside = join(root, "outside.mp4");
    await writeFile(outside, "not a real video");
    await writeProject(root, {
      clips: [clip({ src: outside })]
    });

    const result = await validateProject(join(root, "projects/project.yaml"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.clip.src.safe");
  });

  it("rejects audio asset paths that escape the project asset root", async () => {
    const root = await createProjectRoot();
    const outsideRoot = await mkdtemp(join(tmpdir(), "tsugite-outside-"));
    const outsideAudio = join(outsideRoot, "outside.mp3");
    await writeFile(join(root, "media/clip.mp4"), "not a real video");
    await writeFile(outsideAudio, "not real audio");
    await writeProject(root, {
      clips: [clip({ src: "../media/clip.mp4" })],
      audio: {
        bgm: [{ id: "outside-audio", src: relative(join(root, "manifests"), outsideAudio) }],
        narration: [],
        sfx: []
      }
    });

    const result = await validateProject(join(root, "projects/project.yaml"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.audio.src.safe");
  });

  it("rejects clip assets that escape the project asset root through a symbolic link", async () => {
    const root = await createProjectRoot();
    const outsideRoot = await mkdtemp(join(tmpdir(), "tsugite-outside-"));
    const outsideVideo = join(outsideRoot, "outside.mp4");
    await writeFile(outsideVideo, "not a real video");
    await symlink(outsideVideo, join(root, "media/link.mp4"));
    await writeProject(root, {
      clips: [clip({ src: "../media/link.mp4" })]
    });

    const result = await validateProject(join(root, "projects/project.yaml"));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest.clip.src.safe");
  });
});

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-project-"));
  await mkdir(join(root, "projects"), { recursive: true });
  await mkdir(join(root, "manifests"), { recursive: true });
  await mkdir(join(root, "media"), { recursive: true });
  return root;
}

async function createGenerationProjectRoot(firstFrame: string): Promise<string> {
  const root = await createProjectRoot();
  await writeFile(join(root, "media/clip.mp4"), "fixture video");
  await writeProject(root, { clips: [clip({ src: "../media/clip.mp4" })] });
  await writeFile(
    join(root, "projects/project.yaml"),
    [
      "slug: topview-image",
      "run_id: topview-image-run",
      "manifest: ../manifests/manifest.json",
      "dist_dir: dist",
      "edit:",
      "  backend: remotion",
      "generation:",
      "  adapter: topview",
      "  requests:",
      "    - id: opening-shot",
      "      mode: image-to-video",
      `      first_frame: ${firstFrame}`,
      "      prompt: slow camera push",
      "      model: Standard",
      "      duration: 5",
      '      aspect: "9:16"',
      "      params: {}"
    ].join("\n")
  );
  return root;
}

async function writeProject(
  root: string,
  manifest: {
    clips: Array<ReturnType<typeof clip>>;
    audio?: {
      bgm: Array<{ id: string; src: string }>;
      narration: Array<{ id: string; src: string }>;
      sfx: Array<{ id: string; src: string }>;
    };
  }
): Promise<void> {
  await writeFile(
    join(root, "projects/project.yaml"),
    [
      "slug: safe-assets",
      "run_id: safe-assets-run",
      "manifest: ../manifests/manifest.json",
      "dist_dir: dist",
      "edit:",
      "  backend: remotion"
    ].join("\n")
  );
  await writeFile(
    join(root, "manifests/manifest.json"),
    `${JSON.stringify(
      {
        meta: {
          aspect: "16:9",
          fps: 30,
          target_duration_seconds: 3,
          slug: "safe-assets"
        },
        clips: manifest.clips,
        audio: manifest.audio ?? { bgm: [], narration: [], sfx: [] },
        captions: [],
        provenance: []
      },
      null,
      2
    )}\n`
  );
}

function clip(overrides: { src: string }) {
  return {
    id: "clip-001",
    src: overrides.src,
    in: 0,
    out: 3,
    duration: 3,
    fps: 30,
    resolution: {
      width: 1920,
      height: 1080
    },
    audio: true
  };
}

function validProjectDefinition(): Record<string, unknown> {
  return {
    slug: "request-validation",
    run_id: "request-validation-run",
    manifest: "../manifests/manifest.json",
    dist_dir: "dist",
    edit: {
      backend: "remotion"
    }
  };
}

function requestDefinition(kind: "generation" | "analysis", id: string) {
  if (kind === "analysis") {
    return {
      id,
      output: "captions",
      params: {}
    };
  }
  return {
    id,
    prompt: "fixture prompt",
    model: "fixture-model",
    duration: 1,
    aspect: "16:9",
    params: {}
  };
}
