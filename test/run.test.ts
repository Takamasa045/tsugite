import { access, appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleLocalMediaRun,
  inspectGate2RunForApproval,
  manifestDigestInput
} from "../src/orchestrator/run.js";
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

  it("keeps CLI run JSON wired to optional h3_artifacts and validation promptGuides", async () => {
    // Focused CLI contract: acceptance requires the run success payload to surface
    // LocalRunResult.h3_artifacts and to pass Gate1 validation.promptGuides into assemble.
    const source = await readFile("src/cli.ts", "utf8");
    expect(source).toMatch(/h3_artifacts:\s*runResult\.h3_artifacts/);
    expect(source).toMatch(/promptGuides:\s*validation\.promptGuides/);
    expect(source).toMatch(/\.\.\.\(runResult\.h3_artifacts \? \{ h3_artifacts: runResult\.h3_artifacts \} : \{\}\)/);
  });

  it("keeps Gate2 CLI recordGate and Viewer inspect wired to validation.promptGuides", async () => {
    // Gate2 approve/viewer must reuse the same guide set as Gate1/run (custom dirs included).
    const cli = await readFile("src/cli.ts", "utf8");
    const launcher = await readFile("src/viewer/launcher.ts", "utf8");

    // CLI gate branch forwards validation.promptGuides into recordGate.
    expect(cli).toMatch(
      /const gateResult = await recordGate\(\s*args,\s*validation\.project!,\s*validation\.manifest!,\s*gate!,\s*decision!,\s*validation\.adapter,\s*validation\.audioAdapter,\s*(?:\/\/[^\n]*\n\s*)*validation\.promptGuides\s*\)/
    );
    // recordGate accepts promptGuides and passes them into Gate2 inspect.
    expect(cli).toMatch(
      /async function recordGate\([\s\S]*?promptGuides\?: PromptGuide\[]/
    );
    expect(cli).toMatch(
      /const inspected = await inspectGate2RunForApproval\(\s*project,\s*manifest,\s*existing\.stateDir,\s*adapter,\s*approvedCompilation,\s*audioAdapter,\s*promptGuides(?:,\s*personQaDecision)?\s*\)/
    );
    // Render restores Gate 2 person-QA decision from approval binding (same payload as approve).
    expect(cli).toMatch(/loadPersonQaApprovalBinding\([\s\S]*stage:\s*"gate_2"/);
    expect(cli).toMatch(
      /const gate2Inspection = await inspectGate2RunForApproval\(\s*validation\.project!,\s*validation\.manifest!,\s*stateResult\.stateDir,\s*validation\.adapter,\s*approvedCompilation,\s*validation\.audioAdapter,\s*validation\.promptGuides,\s*gate2PersonQaDecision\s*\)/
    );
    // Gate 2 approve persists person-QA binding for later render revalidation.
    expect(cli).toMatch(
      /if \(inspected\.personQaApprovalBinding\) \{\s*const runId = project\.run_id \?\? project\.slug;\s*const written = await writePersonQaApprovalBinding/
    );
    // Viewer Gate2 evidence inspect must not fall back to default repo guides.
    expect(launcher).toMatch(
      /const inspected = await inspectGate2RunForApproval\(\s*validation\.project,\s*validation\.manifest,\s*resolve\(projectDir, project\.dist_dir\),\s*validation\.adapter,\s*validation\.project\.edit\.editorial && reviewInspection\?\.ok\s*\? reviewInspection\.compilation\s*: undefined,\s*validation\.audioAdapter,\s*(?:\/\/[^\n]*\n\s*)*validation\.promptGuides\s*\)/
    );
  });

  it("writes H3 run artifacts, provenance, and adapter payload for T2V H3", async () => {
    const { createHash } = await import("node:crypto");
    const YAML = await import("yaml");
    const ir = JSON.parse(await readFile("test/fixtures/h3/t2v.json", "utf8"));
    const root = await mkdtemp(join(tmpdir(), "tsugite-h3-t2v-run-"));
    await mkdir(join(root, "projects"), { recursive: true });
    await mkdir(join(root, "manifests"), { recursive: true });
    await mkdir(join(root, "media"), { recursive: true });
    await writeFile(join(root, "media/clip.mp4"), "fixture video");
    await writeFile(
      join(root, "manifests/manifest.json"),
      `${JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 5, slug: "h3-t2v" },
        clips: [{
          id: "clip-1",
          src: "../media/clip.mp4",
          in: 0,
          out: 1,
          duration: 1,
          fps: 30,
          resolution: { width: 320, height: 180 },
          audio: false
        }],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        chapters: [],
        provenance: []
      }, null, 2)}\n`
    );
    const projectDoc = {
      slug: "h3-t2v",
      name: "H3 T2V",
      run_id: "h3-t2v-run",
      manifest: "../manifests/manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "mock-cli",
        requests: [{
          id: "h3-shot",
          prompt: "",
          params: {},
          h3: ir,
          prompt_guide: { catalog: "pixverse", model: "minimax-h3" }
        }]
      }
    };
    const configPath = join(root, "projects/project.yaml");
    await writeFile(configPath, YAML.stringify(projectDoc));

    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(true);
    expect(validation.h3_compilations?.[0]?.lineage.prompt_guide_hash).toMatch(/^[a-f0-9]{64}$/);

    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-h3-t2v-state-"));
    const gate1 = markGateAwaiting(createPlannedState("h3-t2v-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const adapter = {
      ...validation.adapter!,
      command: {
        ...validation.adapter!.command!,
        args: ["fixtures/adapters/mock-cli/capture-request.mjs"]
      }
    };

    const result = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        configPath,
        manifestPath: join(root, "manifests/manifest.json"),
        stateDir,
        state: running
      },
      adapter
    );

    expect(result.ok).toBe(true);
    expect(result.h3_artifacts).toHaveLength(1);
    expect(result.h3_artifacts![0]!.relative_dir).toBe("h3/h3-shot");
    const artifactDir = join(stateDir, "h3-t2v-run", "h3", "h3-shot");
    for (const name of [
      "creative-ir.json",
      "prompt.canonical.txt",
      "prompt.mock-cli.txt",
      "validation.json",
      "lineage.json"
    ]) {
      await expect(access(join(artifactDir, name))).resolves.toBeUndefined();
    }

    const lineage = JSON.parse(await readFile(join(artifactDir, "lineage.json"), "utf8"));
    expect(lineage.workflow_id).toBe("h3-prompt-director");
    expect(lineage.workflow_version).toBe("2");
    expect(lineage.creative_ir_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(lineage.canonical_prompt_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(lineage.adapter_prompt_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(lineage.prompt_guide_identity).toBe("pixverse/minimax-h3");
    expect(lineage.prompt_guide_hash).toBe(validation.h3_compilations![0]!.lineage.prompt_guide_hash);

    const canonicalPrompt = await readFile(join(artifactDir, "prompt.canonical.txt"), "utf8");
    const adapterPrompt = await readFile(join(artifactDir, "prompt.mock-cli.txt"), "utf8");
    expect(canonicalPrompt.endsWith("\n")).toBe(true);
    expect(adapterPrompt.endsWith("\n")).toBe(true);
    expect(createHash("sha256").update(canonicalPrompt.slice(0, -1), "utf8").digest("hex"))
      .toBe(lineage.canonical_prompt_hash);
    expect(createHash("sha256").update(adapterPrompt.slice(0, -1), "utf8").digest("hex"))
      .toBe(lineage.adapter_prompt_hash);

    const captured = JSON.parse(
      await readFile(join(stateDir, "h3-t2v-run", ".mock-adapter-request-h3-shot.json"), "utf8")
    );
    expect(captured.request.prompt).toBe(adapterPrompt.slice(0, -1));
    expect(captured.request.operation).toBe("video");
    expect(captured.request.input_mode).toBe("text-to-video");
    expect(captured.request.model).toBe("minimax-h3");
    expect(captured.request).not.toHaveProperty("h3");
    expect(captured.request).not.toHaveProperty("prompt_guide");

    const manifest = JSON.parse(await readFile(result.manifestPath!, "utf8"));
    expect(manifest.provenance[0].h3).toEqual({
      workflow_version: "2",
      creative_ir_hash: lineage.creative_ir_hash,
      adapter_prompt_hash: lineage.adapter_prompt_hash,
      artifacts_dir: "h3/h3-shot"
    });
    expect(manifest.provenance[0].h3).not.toHaveProperty("creative_ir");
  });

  it("pins first-frame H3 assets, records asset hashes, and fails closed before adapter on invalid H3", async () => {
    const { createHash } = await import("node:crypto");
    const YAML = await import("yaml");
    const ir = JSON.parse(await readFile("test/fixtures/h3/first-frame.json", "utf8"));
    const root = await mkdtemp(join(tmpdir(), "tsugite-h3-ff-run-"));
    await mkdir(join(root, "projects/assets"), { recursive: true });
    await mkdir(join(root, "manifests"), { recursive: true });
    await mkdir(join(root, "media"), { recursive: true });
    await writeFile(join(root, "media/clip.mp4"), "fixture video");
    await writeFile(join(root, "projects/assets/start.png"), "image-bytes-for-hash");
    await writeFile(
      join(root, "manifests/manifest.json"),
      `${JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 5, slug: "h3-ff" },
        clips: [{
          id: "clip-1",
          src: "../media/clip.mp4",
          in: 0,
          out: 1,
          duration: 1,
          fps: 30,
          resolution: { width: 320, height: 180 },
          audio: false
        }],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        chapters: [],
        provenance: []
      }, null, 2)}\n`
    );
    const configPath = join(root, "projects/project.yaml");
    await writeFile(configPath, YAML.stringify({
      slug: "h3-ff",
      name: "H3 first frame",
      run_id: "h3-ff-run",
      manifest: "../manifests/manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "mock-cli",
        requests: [{
          id: "h3-ff",
          prompt: "",
          params: {},
          h3: ir
        }]
      }
    }));

    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(true);

    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-h3-ff-state-"));
    const gate1 = markGateAwaiting(createPlannedState("h3-ff-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const adapter = {
      ...validation.adapter!,
      command: {
        ...validation.adapter!.command!,
        args: ["fixtures/adapters/mock-cli/capture-request.mjs"]
      }
    };

    const result = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        configPath,
        manifestPath: join(root, "manifests/manifest.json"),
        stateDir,
        state: running
      },
      adapter
    );
    expect(result.ok).toBe(true);
    const lineage = JSON.parse(
      await readFile(join(stateDir, "h3-ff-run", "h3", "h3-ff", "lineage.json"), "utf8")
    );
    const expectedHash = createHash("sha256").update("image-bytes-for-hash").digest("hex");
    expect(lineage.asset_hashes).toEqual({ start_image: expectedHash });

    const captured = JSON.parse(
      await readFile(join(stateDir, "h3-ff-run", ".mock-adapter-request-h3-ff.json"), "utf8")
    );
    expect(captured.request.first_frame).toContain("generation-inputs");
    expect(captured.request.input_mode).toBe("image-to-video");
    expect(captured.request.operation).toBe("video");

    // Invalid H3 must fail closed before the mock adapter runs.
    const badRoot = await mkdtemp(join(tmpdir(), "tsugite-h3-bad-run-"));
    await mkdir(join(badRoot, "projects"), { recursive: true });
    await mkdir(join(badRoot, "manifests"), { recursive: true });
    await mkdir(join(badRoot, "media"), { recursive: true });
    await writeFile(join(badRoot, "media/clip.mp4"), "fixture video");
    await writeFile(
      join(badRoot, "manifests/manifest.json"),
      `${JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 5, slug: "h3-bad" },
        clips: [{
          id: "clip-1",
          src: "../media/clip.mp4",
          in: 0,
          out: 1,
          duration: 1,
          fps: 30,
          resolution: { width: 320, height: 180 },
          audio: false
        }],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        chapters: [],
        provenance: []
      }, null, 2)}\n`
    );
    const badConfig = join(badRoot, "projects/project.yaml");
    await writeFile(badConfig, YAML.stringify({
      slug: "h3-bad",
      name: "H3 bad",
      run_id: "h3-bad-run",
      manifest: "../manifests/manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "mock-cli",
        requests: [{
          id: "h3-bad",
          prompt: "manual conflict prompt",
          params: {},
          h3: JSON.parse(await readFile("test/fixtures/h3/t2v.json", "utf8"))
        }]
      }
    }));
    // Bypass validate (which would fail) and assemble with the raw invalid project.
    const { loadProject } = await import("../src/project/loadProject.js");
    const badProject = await loadProject(badConfig);
    const badStateDir = await mkdtemp(join(tmpdir(), "tsugite-h3-bad-state-"));
    const badGate1 = markGateAwaiting(createPlannedState("h3-bad-run"), "gate_1");
    const badRunning = recordGateDecision(badGate1, "gate_1", "approved");
    const badResult = await assembleLocalMediaRun(
      badProject,
      validation.manifest!,
      {
        configPath: badConfig,
        manifestPath: join(badRoot, "manifests/manifest.json"),
        stateDir: badStateDir,
        state: badRunning
      },
      adapter
    );
    expect(badResult.ok).toBe(false);
    expect(badResult.issues.some((issue) => issue.code === "H3-C002")).toBe(true);
    await expect(access(join(badStateDir, "h3-bad-run", ".mock-adapter-request-h3-bad.json"))).rejects.toThrow();
    await expect(access(join(badStateDir, "h3-bad-run", "generated"))).rejects.toThrow();
    await expect(access(join(badStateDir, "h3-bad-run", "h3"))).rejects.toThrow();
  });

  it("keeps Gate1/run/Gate2 prompt_guide_hash aligned for custom guide dirs", async () => {
    const YAML = await import("yaml");
    const ir = JSON.parse(await readFile("test/fixtures/h3/t2v.json", "utf8"));
    const root = await mkdtemp(join(tmpdir(), "tsugite-h3-guide-lineage-"));
    const guideRootA = join(root, "guides-a");
    const guideRootB = join(root, "guides-b");
    await mkdir(join(guideRootA, "pixverse"), { recursive: true });
    await mkdir(join(guideRootB, "pixverse"), { recursive: true });
    const originalGuide = await readFile("knowledge/video-models/pixverse/prompt-guide.yaml", "utf8");
    await writeFile(join(guideRootA, "pixverse/prompt-guide.yaml"), originalGuide);
    await writeFile(join(guideRootB, "pixverse/prompt-guide.yaml"), originalGuide);

    await mkdir(join(root, "projects"), { recursive: true });
    await mkdir(join(root, "manifests"), { recursive: true });
    await mkdir(join(root, "media"), { recursive: true });
    await writeFile(join(root, "media/clip.mp4"), "fixture video");
    // Match mock adapter clip duration so Gate 2 requireQcPass can succeed.
    await writeFile(
      join(root, "manifests/manifest.json"),
      `${JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 1, slug: "h3-guide" },
        clips: [{
          id: "clip-1",
          src: "../media/clip.mp4",
          in: 0,
          out: 1,
          duration: 1,
          fps: 30,
          resolution: { width: 320, height: 180 },
          audio: false
        }],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        chapters: [],
        provenance: []
      }, null, 2)}\n`
    );
    const configPath = join(root, "projects/project.yaml");
    await writeFile(configPath, YAML.stringify({
      slug: "h3-guide",
      name: "H3 guide lineage",
      run_id: "h3-guide-run",
      manifest: "../manifests/manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "mock-cli",
        requests: [{
          id: "h3-shot",
          prompt: "",
          params: {},
          h3: ir,
          prompt_guide: { catalog: "pixverse", model: "minimax-h3" }
        }]
      }
    }));

    const validationA = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"],
      promptGuideDirs: [guideRootA]
    });
    const validationB = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"],
      promptGuideDirs: [guideRootB]
    });
    expect(validationA.ok).toBe(true);
    expect(validationB.ok).toBe(true);
    const hashA = validationA.h3_compilations![0]!.lineage.prompt_guide_hash;
    const hashB = validationB.h3_compilations![0]!.lineage.prompt_guide_hash;
    expect(hashA).toMatch(/^[a-f0-9]{64}$/);
    expect(hashA).toBe(hashB);

    const mutatedGuide = originalGuide.replace(/revision:\s*.+/, "revision: custom-mutated");
    await writeFile(join(guideRootB, "pixverse/prompt-guide.yaml"), mutatedGuide);
    const validationMutated = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"],
      promptGuideDirs: [guideRootB]
    });
    expect(validationMutated.ok).toBe(true);
    const hashMutated = validationMutated.h3_compilations![0]!.lineage.prompt_guide_hash;
    expect(hashMutated).not.toBe(hashA);

    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-h3-guide-state-"));
    const gate1 = markGateAwaiting(createPlannedState("h3-guide-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const adapter = {
      ...validationMutated.adapter!,
      command: {
        ...validationMutated.adapter!.command!,
        args: ["fixtures/adapters/mock-cli/capture-request.mjs"]
      }
    };
    const result = await assembleLocalMediaRun(
      validationMutated.project!,
      validationMutated.manifest!,
      {
        configPath,
        manifestPath: join(root, "manifests/manifest.json"),
        stateDir,
        state: running,
        promptGuides: validationMutated.promptGuides
      },
      adapter
    );
    expect(result.ok).toBe(true);
    const lineage = JSON.parse(
      await readFile(join(stateDir, "h3-guide-run", "h3", "h3-shot", "lineage.json"), "utf8")
    );
    expect(lineage.prompt_guide_hash).toBe(hashMutated);
    expect(lineage.prompt_guide_hash).toBe(
      validationMutated.h3_compilations![0]!.lineage.prompt_guide_hash
    );

    // Gate2 with the same custom promptGuides must accept the run artifacts.
    const gate2Custom = await inspectGate2RunForApproval(
      validationMutated.project!,
      validationMutated.manifest!,
      stateDir,
      adapter,
      undefined,
      undefined,
      validationMutated.promptGuides
    );
    expect(gate2Custom.ok).toBe(true);

    // Default repo guides recompile a different prompt_guide_hash and fail closed.
    const gate2Default = await inspectGate2RunForApproval(
      validationMutated.project!,
      validationMutated.manifest!,
      stateDir,
      adapter,
      undefined,
      undefined
    );
    expect(gate2Default.ok).toBe(false);
    expect(gate2Default.issues[0]?.code).toBe("H3-C000");
    expect(gate2Default.issues[0]?.message).toMatch(/prompt_guide_hash/);
  });

  it("refuses to write H3 artifacts through a symlinked h3 directory before the adapter", async () => {
    const YAML = await import("yaml");
    const ir = JSON.parse(await readFile("test/fixtures/h3/t2v.json", "utf8"));
    const root = await mkdtemp(join(tmpdir(), "tsugite-h3-symlink-run-"));
    const outside = await mkdtemp(join(tmpdir(), "tsugite-h3-outside-"));
    await mkdir(join(root, "projects"), { recursive: true });
    await mkdir(join(root, "manifests"), { recursive: true });
    await mkdir(join(root, "media"), { recursive: true });
    await writeFile(join(root, "media/clip.mp4"), "fixture video");
    await writeFile(
      join(root, "manifests/manifest.json"),
      `${JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 5, slug: "h3-symlink" },
        clips: [{
          id: "clip-1",
          src: "../media/clip.mp4",
          in: 0,
          out: 1,
          duration: 1,
          fps: 30,
          resolution: { width: 320, height: 180 },
          audio: false
        }],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        chapters: [],
        provenance: []
      }, null, 2)}\n`
    );
    const configPath = join(root, "projects/project.yaml");
    await writeFile(configPath, YAML.stringify({
      slug: "h3-symlink",
      name: "H3 symlink",
      run_id: "h3-symlink-run",
      manifest: "../manifests/manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "mock-cli",
        requests: [{
          id: "h3-shot",
          prompt: "",
          params: {},
          h3: ir
        }]
      }
    }));
    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(true);

    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-h3-symlink-state-"));
    const runDir = join(stateDir, "h3-symlink-run");
    await mkdir(runDir, { recursive: true });
    await symlink(outside, join(runDir, "h3"));

    const gate1 = markGateAwaiting(createPlannedState("h3-symlink-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const adapter = {
      ...validation.adapter!,
      command: {
        ...validation.adapter!.command!,
        args: ["fixtures/adapters/mock-cli/capture-request.mjs"]
      }
    };
    const result = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        configPath,
        manifestPath: join(root, "manifests/manifest.json"),
        stateDir,
        state: running,
        promptGuides: validation.promptGuides
      },
      adapter
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("H3-C000");
    await expect(access(join(outside, "h3-shot"))).rejects.toThrow();
    await expect(access(join(runDir, ".mock-adapter-request-h3-shot.json"))).rejects.toThrow();
    await expect(access(join(runDir, "generated"))).rejects.toThrow();
  });

  it("rejects resume and Gate2 inspection when H3 artifacts are missing or tampered", async () => {
    const YAML = await import("yaml");
    const ir = JSON.parse(await readFile("test/fixtures/h3/t2v.json", "utf8"));
    const root = await mkdtemp(join(tmpdir(), "tsugite-h3-resume-"));
    await mkdir(join(root, "projects"), { recursive: true });
    await mkdir(join(root, "manifests"), { recursive: true });
    await mkdir(join(root, "media"), { recursive: true });
    await writeFile(join(root, "media/clip.mp4"), "fixture video");
    // Match mock adapter clip duration so Gate 2 requireQcPass can succeed when artifacts are intact.
    await writeFile(
      join(root, "manifests/manifest.json"),
      `${JSON.stringify({
        meta: { aspect: "16:9", fps: 30, target_duration_seconds: 1, slug: "h3-resume" },
        clips: [{
          id: "clip-1",
          src: "../media/clip.mp4",
          in: 0,
          out: 1,
          duration: 1,
          fps: 30,
          resolution: { width: 320, height: 180 },
          audio: false
        }],
        audio: { bgm: [], narration: [], sfx: [] },
        captions: [],
        chapters: [],
        provenance: []
      }, null, 2)}\n`
    );
    const configPath = join(root, "projects/project.yaml");
    await writeFile(configPath, YAML.stringify({
      slug: "h3-resume",
      name: "H3 resume",
      run_id: "h3-resume-run",
      manifest: "../manifests/manifest.json",
      dist_dir: "dist",
      edit: { backend: "remotion" },
      generation: {
        adapter: "mock-cli",
        requests: [{
          id: "h3-shot",
          prompt: "",
          params: {},
          h3: ir,
          prompt_guide: { catalog: "pixverse", model: "minimax-h3" }
        }]
      }
    }));
    const validation = await validateProject(configPath, {
      adapterDirs: ["fixtures/adapters", "adapters"]
    });
    expect(validation.ok).toBe(true);

    const stateDir = await mkdtemp(join(tmpdir(), "tsugite-h3-resume-state-"));
    const gate1 = markGateAwaiting(createPlannedState("h3-resume-run"), "gate_1");
    const running = recordGateDecision(gate1, "gate_1", "approved");
    const adapter = {
      ...validation.adapter!,
      command: {
        ...validation.adapter!.command!,
        args: ["fixtures/adapters/mock-cli/capture-request.mjs"]
      }
    };
    const first = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        configPath,
        manifestPath: join(root, "manifests/manifest.json"),
        stateDir,
        state: running,
        promptGuides: validation.promptGuides
      },
      adapter
    );
    expect(first.ok).toBe(true);
    expect(first.h3_artifacts).toHaveLength(1);
    expect(first.h3_artifacts![0]!.relative_dir).toBe("h3/h3-shot");
    expect(first.h3_artifacts![0]!.absolute_paths.lineage).toContain("lineage.json");

    const awaiting = first.state!;
    const artifactDir = join(stateDir, "h3-resume-run", "h3", "h3-shot");

    // Normal resume returns the same H3 artifact paths.
    const resumedOk = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        configPath,
        manifestPath: join(root, "manifests/manifest.json"),
        stateDir,
        state: awaiting,
        promptGuides: validation.promptGuides
      },
      adapter
    );
    expect(resumedOk.ok).toBe(true);
    expect(resumedOk.alreadyAssembled).toBe(true);
    expect(resumedOk.h3_artifacts).toHaveLength(1);
    expect(resumedOk.h3_artifacts![0]!.relative_dir).toBe("h3/h3-shot");
    expect(resumedOk.h3_artifacts![0]!.absolute_paths.creative_ir).toBe(
      first.h3_artifacts![0]!.absolute_paths.creative_ir
    );

    const gate2Ok = await inspectGate2RunForApproval(
      validation.project!,
      validation.manifest!,
      stateDir,
      adapter,
      undefined,
      undefined,
      validation.promptGuides
    );
    expect(gate2Ok.ok).toBe(true);

    const originalCanonical = await readFile(join(artifactDir, "prompt.canonical.txt"), "utf8");
    const originalLineage = await readFile(join(artifactDir, "lineage.json"), "utf8");

    // Tamper a durable prompt artifact.
    await writeFile(join(artifactDir, "prompt.canonical.txt"), "tampered prompt\n");
    const resumedTampered = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        configPath,
        manifestPath: join(root, "manifests/manifest.json"),
        stateDir,
        state: awaiting,
        promptGuides: validation.promptGuides
      },
      adapter
    );
    expect(resumedTampered.ok).toBe(false);
    expect(resumedTampered.issues[0]?.code).toBe("H3-C000");

    const gate2Tampered = await inspectGate2RunForApproval(
      validation.project!,
      validation.manifest!,
      stateDir,
      adapter,
      undefined,
      undefined,
      validation.promptGuides
    );
    expect(gate2Tampered.ok).toBe(false);
    expect(gate2Tampered.issues[0]?.code).toBe("H3-C000");

    // Restore prompt, then drop lineage — missing artifact must also fail closed.
    await writeFile(join(artifactDir, "prompt.canonical.txt"), originalCanonical);
    await rm(join(artifactDir, "lineage.json"));

    const resumedMissing = await assembleLocalMediaRun(
      validation.project!,
      validation.manifest!,
      {
        configPath,
        manifestPath: join(root, "manifests/manifest.json"),
        stateDir,
        state: awaiting,
        promptGuides: validation.promptGuides
      },
      adapter
    );
    expect(resumedMissing.ok).toBe(false);
    expect(resumedMissing.issues[0]?.code).toBe("H3-C000");

    const gate2Missing = await inspectGate2RunForApproval(
      validation.project!,
      validation.manifest!,
      stateDir,
      adapter,
      undefined,
      undefined,
      validation.promptGuides
    );
    expect(gate2Missing.ok).toBe(false);
    expect(gate2Missing.issues[0]?.code).toBe("H3-C000");

    // Keep the original lineage text referenced so the fixture remains inspectable in failures.
    expect(originalLineage).toContain("h3-prompt-director");
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
