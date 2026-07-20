import { access, appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleLocalMediaRun, manifestDigestInput } from "../src/orchestrator/run.js";
import {
  createPlannedState,
  markGateAwaiting,
  recordGateDecision
} from "../src/orchestrator/state.js";
import { validateProject } from "../src/project/validateProject.js";

describe("local media run assembly", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed when an MCP generation connection is explicitly agent-handoff only", async () => {
    const validation = await validateProject("fixtures/projects/generation-connection-topview.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-mcp-handoff-run-"));
    const gate1 = markGateAwaiting(createPlannedState("generation-connection-topview-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");

    const result = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/minimal.valid.json",
      stateDir,
      state: running,
      generationConnection: {
        ...validation.generationConnection!,
        execution_mode: "agent-handoff"
      }
    }, validation.adapter);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: "run.connection_handoff_required",
      message: "generation connection 'topview' uses MCP and requires an agent handoff; pipeline run will not execute adapter 'topview' as CLI",
      path: "generation.connection"
    });
    await expect(access(join(stateDir, "generation-connection-topview-run"))).rejects.toThrow();
  });

  it("fails closed before generation when the selected CLI connection needs setup", async () => {
    vi.stubEnv("PATH", "/missing");
    const validation = await validateProject("fixtures/projects/generation-connection-pixburst-alias.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-connection-setup-run-"));
    const gate1 = markGateAwaiting(createPlannedState("generation-connection-pixburst-alias-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");

    const result = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/minimal.valid.json",
      stateDir,
      state: running,
      generationConnection: validation.generationConnection
    }, validation.adapter);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: "run.connection_setup_required",
      message: "generation connection 'pixverse' is needs-setup; complete setup before run",
      path: "generation.connection"
    });
    await expect(access(join(stateDir, "generation-connection-pixburst-alias-run"))).rejects.toThrow();
  });

  it("requires approved Gate 1 verification before an audio connection can execute", async () => {
    const validation = await validateProject("fixtures/projects/audio-connection.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-audio-connection-run-"));
    const gate1 = markGateAwaiting(createPlannedState("audio-connection-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");

    const result = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/minimal.valid.json",
      stateDir,
      state: running,
      audioConnection: validation.audioConnection
    }, validation.adapter, validation.audioAdapter);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: "run.audio_connection_verification_required",
      message: "audio connection 'hyperframes-media' needs verification recorded in the approved Gate 1 review before run",
      path: "audio.connection"
    });
    await expect(access(join(stateDir, "audio-connection-run"))).rejects.toThrow();
  });

  it("requires an approved Gate 1 verification record for a needs-verification CLI connection", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const generationConnection = {
      id: "fixture-subscription",
      adapter: "mock-cli",
      transport: "cli" as const,
      provider: "fixture",
      route_note: "local test adapter",
      setup_status: "needs-verification" as const,
      execution_mode: "pipeline-adapter" as const
    };
    const blockedStateDir = await mkdtemp(join(tmpdir(), "tsugite-connection-verification-blocked-"));

    const blocked = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir: blockedStateDir,
        state: running,
        generationConnection
      },
      validation.adapter
    );

    expect(blocked.ok).toBe(false);
    expect(blocked.issues).toContainEqual({
      code: "run.connection_verification_required",
      message: "generation connection 'fixture-subscription' needs verification recorded in the approved Gate 1 review before run",
      path: "generation.connection"
    });
    await expect(access(join(blockedStateDir, "cli-generation-run"))).rejects.toThrow();

    const approvedStateDir = await mkdtemp(join(tmpdir(), "tsugite-connection-verification-approved-"));
    const approved = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir: approvedStateDir,
        state: running,
        generationConnection,
        connectionVerificationApproved: true
      },
      validation.adapter
    );

    expect(approved.ok).toBe(true);
  });

  it("pins local images before invoking a credit-bearing generation adapter", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-generation-image-order-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const project = {
      ...validation.project!,
      generation: {
        ...validation.project!.generation!,
        requests: validation.project!.generation!.requests.map((request) => ({
          ...request,
          params: { fail_once: true }
        }))
      }
    };
    const manifest = {
      ...validation.manifest!,
      images: [{ id: "missing-character", src: "../media/missing-character.png" }]
    };

    await expect(
      assembleLocalMediaRun(project, manifest, {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      }, validation.adapter)
    ).rejects.toThrow();
    await expect(access(join(stateDir, "cli-generation-run", ".mock-failed-generated-001"))).rejects.toThrow();
  });

  it("removes newly introduced empty defaults from the persisted input digest", async () => {
    const validation = await validateProject("fixtures/projects/local-media-only.yaml");
    const input = {
      ...validation.manifest!,
      images: [],
      speakers: [],
      presentation: { preset: "legacy-preset", draft: false },
      captions: [
        {
          text: "legacy caption",
          start: 0,
          end: 1,
          emphasis: [],
          visual: { headline: "Legacy", badges: [] }
        }
      ]
    };

    const canonical = manifestDigestInput(input) as Record<string, any>;

    expect(canonical).not.toHaveProperty("images");
    expect(canonical).not.toHaveProperty("speakers");
    expect(canonical.presentation).not.toHaveProperty("draft");
    expect(canonical.captions[0]).not.toHaveProperty("emphasis");
    expect(canonical.captions[0].visual).not.toHaveProperty("badges");
  });

  it("copies first-class image assets into the guarded run directory", async () => {
    const validation = await validateProject("fixtures/projects/dialogue-remotion.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-dialogue-run-"));
    const gate1 = markGateAwaiting(createPlannedState("dialogue-fixture-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");

    const result = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/dialogue.valid.json",
      stateDir,
      state: running
    });

    expect(result.ok).toBe(true);
    expect(result.assetCount).toBe(3);
    const manifest = JSON.parse(await readFile(result.manifestPath!, "utf8"));
    const qc = JSON.parse(await readFile(result.qcReportPath!, "utf8"));
    expect(manifest.images.map((image: { src: string }) => image.src)).toEqual([
      "assets/images/001-left-neutral.svg",
      "assets/images/002-right-neutral.svg"
    ]);
    expect(qc.assets.filter((asset: { kind: string }) => asset.kind === "image")).toHaveLength(2);
  });

  it("runs an approved audio adapter before Gate 2 and pins its BGM and SFX", async () => {
    const validation = await validateProject("fixtures/projects/audio-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-audio-run-"));
    const gate1 = markGateAwaiting(createPlannedState("audio-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");

    const result = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/minimal.valid.json",
        stateDir,
        state: running
      },
      validation.adapter,
      validation.audioAdapter
    );

    expect(result.ok).toBe(true);
    expect(result.assetCount).toBe(4);
    expect(result.actualCredits).toBe(0);
    const manifest = JSON.parse(await readFile(result.manifestPath!, "utf8"));
    const runLog = await readFile(result.runLogPath!, "utf8");
    expect(manifest.audio.bgm).toEqual([
      expect.objectContaining({
        id: "main-bgm",
        src: "generated-audio/main-bgm.wav",
        start: 0,
        end: 6,
        volume: 0.2
      })
    ]);
    expect(manifest.audio.sfx).toEqual([
      expect.objectContaining({
        id: "opening-whoosh",
        src: "generated-audio/opening-whoosh.wav",
        start: 0.25,
        volume: 0.35
      })
    ]);
    expect(runLog).toContain("audio_adapter: mock-cli-audio");
    expect(runLog).toContain("elevenlabs_used: false");
  });

  it("rejects requested audio ids already present in the manifest before invoking the adapter", async () => {
    const validation = await validateProject("fixtures/projects/audio-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const projectDir = await mkdtemp(join(tmpdir(), "tsugite-audio-duplicate-input-"));
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-audio-duplicate-run-"));
    const existingAudioPath = join(projectDir, "existing.wav");
    await writeFile(existingAudioPath, silentWav());
    const gate1 = markGateAwaiting(createPlannedState("audio-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const manifest = {
      ...validation.manifest!,
      audio: {
        ...validation.manifest!.audio,
        bgm: [{ id: "main-bgm", src: existingAudioPath, start: 0, end: 1, volume: 0.2 }]
      }
    };

    const result = await assembleLocalMediaRun(
      validation.project!,
      manifest,
      {
        manifestPath: "fixtures/manifests/minimal.valid.json",
        stateDir,
        state: running
      },
      validation.adapter,
      validation.audioAdapter
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.audio_track_id_duplicate");
    await expect(access(join(stateDir, "audio-generation-run", "generated-audio", "main-bgm.wav"))).rejects.toThrow();
  });

  it("rejects assembly before Gate 1 has approved a running state", async () => {
    const validation = await validateProject("fixtures/projects/local-media-only.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));

    const result = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/minimal.valid.json",
      stateDir,
      state: createPlannedState("local-media-only-run")
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.invalid_state");
  });

  it("reports a missing assembled manifest for an awaiting Gate 2 state", async () => {
    const validation = await validateProject("fixtures/projects/local-media-only.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("local-media-only-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const awaitingGate2 = markGateAwaiting(running, "gate_2");

    const result = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/minimal.valid.json",
      stateDir,
      state: awaitingGate2
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.manifest_missing");
  });

  it("does not resume an awaiting Gate 2 run from an assembled manifest alone", async () => {
    const validation = await validateProject("fixtures/projects/local-media-only.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const runDir = join(stateDir, "local-media-only-run");
    const gate1 = markGateAwaiting(createPlannedState("local-media-only-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const awaitingGate2 = markGateAwaiting(running, "gate_2");

    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(validation.manifest!, null, 2)}\n`);

    const result = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/minimal.valid.json",
      stateDir,
      state: awaitingGate2
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.qc_report_missing");
  });

  it("assembles generated clips from a cli adapter command", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");

    const result = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );

    expect(result.ok).toBe(true);
    expect(result.assetCount).toBe(1);
    expect(result.actualCredits).toBe(0.25);
    expect(result.state?.status).toBe("awaiting_gate_2");

    const manifest = JSON.parse(await readFile(result.manifestPath!, "utf8"));
    const qc = JSON.parse(await readFile(result.qcReportPath!, "utf8"));
    const runLog = await readFile(result.runLogPath!, "utf8");

    expect(manifest.clips[0].id).toBe("generated-001-clip");
    expect(manifest.clips[0].src).toBe("assets/clips/001-generated-001-clip.mp4");
    expect(manifest.provenance[0].credits).toBe(0.25);
    expect(qc.asset_count).toBe(1);
    expect(runLog).toContain("actual_credits: 0.25");
    expect(runLog).toContain("review_path: review/index.html");
    expect(runLog).toContain("review_data_path: review/review-data.json");
  });

  it("assembles generated images and narration into the project manifest without replacing existing clips", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-media-"));
    const runDir = join(stateDir, "cli-generation-run");
    await mkdir(runDir, { recursive: true });
    const imageSrc = join(runDir, "provider-image.png");
    const audioSrc = join(runDir, "provider-voice.wav");
    await writeFile(imageSrc, "fixture image");
    await writeFile(audioSrc, silentWav());
    const project = {
      ...validation.project!,
      generation: {
        ...validation.project!.generation!,
        requests: [{
          id: "generated-image",
          operation: "image" as const,
          prompt: "fixture image",
          model: "fixture-model",
          params: {
            output: { request_id: "generated-image", credits: 0.4, clips: [], images: [{ id: "hero-image", src: imageSrc }], audio: [], metadata: {} }
          }
        }, {
          id: "generated-voice",
          operation: "voice" as const,
          output_kind: "audio" as const,
          audio_role: "narration" as const,
          prompt: "fixture voice",
          model: "fixture-model",
          params: {
            output: { request_id: "generated-voice", credits: 0.6, clips: [], images: [], audio: [{ id: "voice-track", src: audioSrc, role: "narration", start: 0 }], metadata: {} }
          }
        }]
      }
    };
    const adapter = {
      ...validation.adapter!,
      command: { ...validation.adapter!.command!, args: ["fixtures/adapters/mock-cli/output-from-params.mjs"] }
    };
    const running = recordGateDecision(
      markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1"), "gate_1", "approved"
    );

    const result = await assembleLocalMediaRun(project, validation.manifest!, {
      manifestPath: "fixtures/manifests/render-local.valid.json",
      stateDir,
      state: running
    }, adapter);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest.clips).toHaveLength(validation.manifest!.clips.length);
    expect(manifest.images).toContainEqual(expect.objectContaining({ id: "hero-image", src: "assets/images/generated/001-hero-image.png" }));
    expect(manifest.audio.narration).toContainEqual(expect.objectContaining({ id: "voice-track", src: "assets/audio/narration/001-voice-track.wav" }));
    expect(result.actualCredits).toBe(1);
  });

  it("pins audio assets for generated runs so Gate 2 can validate and resume them", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const projectDir = await mkdtemp(join(tmpdir(), "tsugite-generation-audio-input-"));
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-generation-audio-run-"));
    const audioPath = join(projectDir, "country-day.wav");
    await writeFile(audioPath, silentWav());
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const manifest = {
      ...validation.manifest!,
      audio: {
        ...validation.manifest!.audio,
        bgm: [
          {
            id: "country-day",
            src: "country-day.wav",
            start: 0,
            end: 1,
            volume: 0.4
          }
        ]
      }
    };

    const result = await assembleLocalMediaRun(
      validation.project!,
      manifest,
      {
        manifestPath: join(projectDir, "manifest.json"),
        stateDir,
        state: running
      },
      validation.adapter
    );

    expect(result.ok).toBe(true);
    expect(result.assetCount).toBe(2);
    const assembled = JSON.parse(await readFile(result.manifestPath!, "utf8"));
    const qc = JSON.parse(await readFile(result.qcReportPath!, "utf8"));
    expect(assembled.audio.bgm[0].src).toBe("assets/audio/bgm/001-country-day.wav");
    expect(qc.ok).toBe(true);
    expect(qc.assets.filter((asset: { kind: string }) => asset.kind === "audio")).toHaveLength(1);
    await expect(access(join(stateDir, "cli-generation-run", assembled.audio.bgm[0].src))).resolves.toBeUndefined();

    const resumed = await assembleLocalMediaRun(validation.project!, manifest, {
      manifestPath: join(projectDir, "manifest.json"),
      stateDir,
      state: result.state!,
      audioConnection: {
        id: "audio-provider-offline",
        adapter: "mock-cli-audio",
        transport: "cli",
        provider: "fixture",
        route_note: "provider removed after assembly",
        setup_status: "needs-setup",
        execution_mode: "pipeline-adapter"
      }
    }, validation.adapter);
    expect(resumed.ok).toBe(true);
    expect(resumed.alreadyAssembled).toBe(true);
  });

  it("resumes generated runs with the original asset count and actual credits", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const firstRequest = validation.project!.generation!.requests[0]!;
    const project = {
      ...validation.project!,
      generation: {
        adapter: validation.project!.generation!.adapter,
        requests: [firstRequest, { ...firstRequest, id: "generated-002" }]
      }
    };

    const first = await assembleLocalMediaRun(
      project,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );
    expect(first.ok).toBe(true);

    const resumed = await assembleLocalMediaRun(
      project,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: first.state!,
        generationConnection: {
          id: "generation-provider-offline",
          adapter: "mock-cli",
          transport: "cli",
          provider: "fixture",
          route_note: "provider removed after assembly",
          setup_status: "needs-setup",
          execution_mode: "pipeline-adapter"
        }
      },
      validation.adapter
    );

    expect(resumed.ok).toBe(true);
    expect(resumed.alreadyAssembled).toBe(true);
    expect(resumed.assetCount).toBe(first.assetCount);
    expect(resumed.assetCount).toBe(2);
    expect(resumed.actualCredits).toBe(first.actualCredits);
    expect(resumed.actualCredits).toBe(0.5);
  });

  it("rejects resume when the project inputs changed under the same run id", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const first = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );
    expect(first.ok).toBe(true);
    const changedProject = {
      ...validation.project!,
      generation: {
        ...validation.project!.generation!,
        requests: validation.project!.generation!.requests.map((request) => ({
          ...request,
          prompt: `${request.prompt} changed`
        }))
      }
    };

    const resumed = await assembleLocalMediaRun(
      changedProject,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: first.state!
      },
      validation.adapter
    );

    expect(resumed.ok).toBe(false);
    expect(resumed.issues[0]?.code).toBe("run.input_changed");
  });

  it("rejects resume when an assembled asset is missing", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const first = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );
    expect(first.ok).toBe(true);
    const assembledManifest = JSON.parse(await readFile(first.manifestPath!, "utf8"));
    await rm(join(stateDir, "cli-generation-run", assembledManifest.clips[0].src));

    const resumed = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: first.state!
      },
      validation.adapter
    );

    expect(resumed.ok).toBe(false);
    expect(resumed.issues[0]?.code).toBe("run.asset_missing");
  });

  it("rejects resume when an assembled asset changed after Gate 2 QC", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const first = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );
    expect(first.ok).toBe(true);
    const assembledManifest = JSON.parse(await readFile(first.manifestPath!, "utf8"));
    const assembledAssetPath = join(stateDir, "cli-generation-run", assembledManifest.clips[0].src);
    await writeFile(assembledAssetPath, "changed after QC\n");

    const resumed = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: first.state!
      },
      validation.adapter
    );

    expect(resumed.ok).toBe(false);
    expect(resumed.issues[0]?.code).toBe("run.qc_report_stale");
  });

  it("rejects a same-metadata media replacement by its content fingerprint", async () => {
    const validation = await validateProject("fixtures/projects/render-local-media.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-media-fingerprint-"));
    const gate1 = markGateAwaiting(createPlannedState("render-local-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const first = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/render-local.valid.json",
      stateDir,
      state: running
    });
    expect(first.ok).toBe(true);
    const assembledManifest = JSON.parse(await readFile(first.manifestPath!, "utf8"));
    const assembledAssetPath = join(stateDir, "render-local-run", assembledManifest.clips[0].src);
    await appendFile(assembledAssetPath, Buffer.from([0]));

    const resumed = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/render-local.valid.json",
      stateDir,
      state: first.state!
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.issues[0]?.code).toBe("run.qc_report_stale");
  });

  it("rejects resume when an assembled image is replaced with different same-shape content", async () => {
    const validation = await validateProject("fixtures/projects/dialogue-remotion.yaml");
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-image-resume-"));
    const gate1 = markGateAwaiting(createPlannedState("dialogue-fixture-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const first = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/dialogue.valid.json",
      stateDir,
      state: running
    });
    expect(first.ok).toBe(true);
    const assembledManifest = JSON.parse(await readFile(first.manifestPath!, "utf8"));
    const imagePath = join(stateDir, "dialogue-fixture-run", assembledManifest.images[0].src);
    const original = await readFile(imagePath, "utf8");
    await writeFile(imagePath, original.replace("#f6a95f", "#f5a85e"));

    const resumed = await assembleLocalMediaRun(validation.project!, validation.manifest!, {
      manifestPath: "fixtures/manifests/dialogue.valid.json",
      stateDir,
      state: first.state!
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.issues[0]?.code).toBe("run.qc_report_stale");
  });

  it("rejects resume when an assembled manifest points outside its run directory", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const first = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );
    expect(first.ok).toBe(true);

    const externalAssetPath = join(process.cwd(), "fixtures/media/render-001.mp4");
    const assembledManifest = JSON.parse(await readFile(first.manifestPath!, "utf8"));
    assembledManifest.clips[0].src = externalAssetPath;
    await writeFile(first.manifestPath!, `${JSON.stringify(assembledManifest, null, 2)}\n`);
    const qc = JSON.parse(await readFile(first.qcReportPath!, "utf8"));
    qc.assets[0].src = externalAssetPath;
    qc.assets[0].path = externalAssetPath;
    await writeFile(first.qcReportPath!, `${JSON.stringify(qc, null, 2)}\n`);

    const resumed = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: first.state!
      },
      validation.adapter
    );

    expect(resumed.ok).toBe(false);
    expect(resumed.issues[0]?.code).toBe("run.asset_path_invalid");
  });

  it("rejects resume when an assembled asset symlink escapes the run directory", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const first = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );
    expect(first.ok).toBe(true);
    const assembledManifest = JSON.parse(await readFile(first.manifestPath!, "utf8"));
    const assembledAssetPath = join(stateDir, "cli-generation-run", assembledManifest.clips[0].src);
    await rm(assembledAssetPath);
    await symlink(join(process.cwd(), "fixtures/media/render-001.mp4"), assembledAssetPath);

    const resumed = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: first.state!
      },
      validation.adapter
    );

    expect(resumed.ok).toBe(false);
    expect(resumed.issues[0]?.code).toBe("run.asset_path_invalid");
  });

  it("rejects resume when Gate 2 QC disagrees with the assembled manifest", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const first = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );
    expect(first.ok).toBe(true);
    const qc = JSON.parse(await readFile(first.qcReportPath!, "utf8"));
    qc.asset_count = 99;
    await writeFile(first.qcReportPath!, `${JSON.stringify(qc, null, 2)}\n`);

    const resumed = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: first.state!
      },
      validation.adapter
    );

    expect(resumed.ok).toBe(false);
    expect(resumed.issues[0]?.code).toBe("run.qc_report_inconsistent");
  });

  it("rejects resume when manifest timing no longer matches the Gate 2 QC summary", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const first = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );
    expect(first.ok).toBe(true);
    const assembledManifest = JSON.parse(await readFile(first.manifestPath!, "utf8"));
    assembledManifest.meta.target_duration_seconds += 1;
    await writeFile(first.manifestPath!, `${JSON.stringify(assembledManifest, null, 2)}\n`);

    const resumed = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: first.state!
      },
      validation.adapter
    );

    expect(resumed.ok).toBe(false);
    expect(resumed.issues[0]?.code).toBe("run.qc_report_inconsistent");
  });

  it("rejects resume when the run log is missing", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const first = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );
    expect(first.ok).toBe(true);
    await rm(first.runLogPath!);

    const resumed = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: first.state!
      },
      validation.adapter
    );

    expect(resumed.ok).toBe(false);
    expect(resumed.issues[0]?.code).toBe("run.run_log_missing");
  });

  it("retries retryable cli adapter exits", async () => {
    const validation = await validateProject("fixtures/projects/cli-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("cli-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const project = {
      ...validation.project!,
      generation: {
        adapter: validation.project!.generation!.adapter,
        requests: [
          {
            ...validation.project!.generation!.requests[0],
            params: { fail_once: true }
          }
        ]
      }
    };

    const result = await assembleLocalMediaRun(
      project,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );
    const runLog = await readFile(result.runLogPath!, "utf8");

    expect(result.ok).toBe(true);
    expect(runLog).toContain("attempts=2");
  });

  it("rejects cli generation adapters without a command", async () => {
    const validation = await validateProject("fixtures/projects/no-command-generation.yaml", {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-run-"));
    const gate1 = markGateAwaiting(createPlannedState("no-command-generation-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");

    const result = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        manifestPath: "fixtures/manifests/render-local.valid.json",
        stateDir,
        state: running
      },
      validation.adapter
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("run.adapter_command_missing");
  });
});

function silentWav(): Buffer {
  const sampleRate = 8_000;
  const sampleCount = sampleRate;
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}
