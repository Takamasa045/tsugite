import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSchema } from "../src/project/schema.js";
import {
  assertEffectiveGenerationContract,
  compileProjectVideoPrompts,
  compileVideoPromptIrV2,
  createVerifiedAssetPin,
  h3GrammarProfileDigest,
  isTrustedAssetPin,
  loadAdapterDialectCapability,
  loadConnectionCapabilityProfile,
  loadModelPromptProfile,
  loadPinnedH3GrammarProfile,
  routeFromProfiles,
  type VideoPromptIrV2
} from "../src/videoPromptDirector/index.js";
import { sha256Text } from "../src/integrity/canonical.js";
import { parseH3CreativeIr } from "../src/h3/schema.js";

const ZERO = "0".repeat(64);

function standalone(model = "minimax-h3"): VideoPromptIrV2 {
  return {
    version: 2,
    program_kind: "standalone",
    target: { model_profile_id: model, mode: "text-to-video", duration_ms: 10_000, quality: model === "minimax-h3" ? "768p" : "720p", aspect: "16:9", audio: false },
    creative: { must_include: [], prohibited: [] },
    subjects: [], scenes: [], assets: [],
    shots: [{ id: "shot-1", start_ms: 0, end_ms: 10_000, cast: [], composition: "medium shot", action_beats: [{ description: "A lantern turns toward the camera." }], vocal_events: [], visible_text_events: [], constraints: { positive: [], exact_text_refs: [] } }],
    audio: { policy: "silent", reference_asset_ids: [], final_mix: "discard-generated" }
  };
}

describe("PO-4 final No-Go repairs", () => {
  it("uses one exact provider-neutral capability map entry per model/route across the adapter matrix", async () => {
    const matrix = [
      ["pixverse", "v6", "v6", "text-to-video", "plain-prompt"],
      ["minimax", "minimax-h3", "MiniMax-H3", "text-to-video", "h3-grammar"],
      ["minimax-http", "minimax-h3", "MiniMax-H3", "last-frame", "h3-grammar"],
      ["topview", "topview-default", "topview-default", "text-to-video", "plain-prompt"],
      ["kling", "video-3.0", "kling-v3", "text-to-video", "plain-prompt"]
    ] as const;
    for (const [adapter, model, providerModel, mode, renderer] of matrix) {
      const loaded = await loadAdapterDialectCapability(adapter, ["adapters"], { model_profile_id: model, provider_model: providerModel, mode });
      expect(loaded.ok, adapter).toBe(true);
      if (loaded.ok) expect(loaded.capability.renderer).toBe(renderer);
    }
    const forged = await loadAdapterDialectCapability("pixverse", ["adapters"], { model_profile_id: "v6", provider_model: "minimax-h3", mode: "text-to-video" });
    expect(forged.ok).toBe(false);
  });

  it("keeps unspecified/shadow legacy authoritative and requires active for native V2", async () => {
    const legacy = parseH3CreativeIr({
      version: 1,
      target: { model: "minimax-h3", mode: "text-to-video", duration: 10, quality: "768p", aspect: "16:9", audio: false },
      subjects: [], assets: [], shots: [{ id: "shot-1", start_ms: 0, end_ms: 10_000, visual: "a lantern" }], sound: { soundscape: "N/A", music: { enabled: false } }
    });
    const base = { slug: "legacy", name: "legacy", manifest: "manifest.json", dist_dir: "dist", edit: { backend: "remotion" }, generation: { requests: [{ id: "r1", prompt: "", params: {}, h3: legacy }] } } as never;
    const unspecified = await compileProjectVideoPrompts(base, { intent: "planning" });
    expect(unspecified.ok).toBe(true);
    if (unspecified.ok) expect(unspecified.plans).toHaveLength(0);
    const shadow = await compileProjectVideoPrompts({ ...base, orchestration: { mode: "shadow" } }, { intent: "planning" });
    expect(shadow.ok).toBe(true);
    if (shadow.ok) expect(shadow.plans).toHaveLength(0);
    const native = await compileProjectVideoPrompts({
      ...base,
      generation: { requests: [{ id: "r1", prompt: "", params: {}, video_prompt: standalone() }] }
    }, { intent: "planning" });
    expect(native.ok).toBe(false);
    expect(native.issues.map((item) => item.code)).toContain("VPD-E022");
  });

  it("rejects forged effective duration claims even when their digest is recomputed", async () => {
    const model = await loadModelPromptProfile("minimax-h3");
    const connection = await loadConnectionCapabilityProfile("minimax-direct");
    expect(model.ok && connection.ok).toBe(true);
    if (!model.ok || !connection.ok) return;
    const selected = routeFromProfiles({ model: "minimax-h3", mode: "text-to-video", model_profile: model.profile, connection_profile: connection.profile, model_profile_digest: model.digest, connection_profile_digest: connection.digest });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const adapter = await loadAdapterDialectCapability("minimax", ["adapters"], { model_profile_id: "minimax-h3", provider_model: "MiniMax-H3", mode: "text-to-video" });
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const valid = compileVideoPromptIrV2(standalone(), { route: selected.route, model_profile: model.profile, model_profile_digest: model.digest, connection_profile: connection.profile, connection_capability_digest: connection.digest, adapter_dialect_capability: adapter.capability });
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    const forged = { ...valid.compilation.effective_contract, effective: { ...valid.compilation.effective_contract.effective, durations_ms: [16_000] } };
    const withoutDigest = { ...forged } as Record<string, unknown>;
    delete withoutDigest.digest;
    const checked = assertEffectiveGenerationContract({ ...forged, digest: (await import("../src/integrity/canonical.js")).sha256Canonical(withoutDigest) }, { route: selected.route, mode: "text-to-video", model_profile_digest: model.digest, connection_digest: connection.digest, truth: { model_profile: model.profile, connection_profile: connection.profile, model_profile_digest: model.digest, connection_profile_digest: connection.digest } });
    expect(checked.ok).toBe(false);
  });

  it("does not promote a forged grammar profile and loads only the pinned repo profile", async () => {
    const pinned = await loadPinnedH3GrammarProfile();
    expect(h3GrammarProfileDigest(pinned)).toBe(pinned.digest);
    const forged = { ...pinned, source_commit: "caller", digest: h3GrammarProfileDigest({ ...pinned, source_commit: "caller" }) };
    const model = await loadModelPromptProfile("minimax-h3");
    const connection = await loadConnectionCapabilityProfile("minimax-direct");
    expect(model.ok && connection.ok).toBe(true);
    if (!model.ok || !connection.ok) return;
    const route = routeFromProfiles({ model: "minimax-h3", mode: "text-to-video", model_profile: model.profile, connection_profile: connection.profile, model_profile_digest: model.digest, connection_profile_digest: connection.digest });
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    const adapter = await loadAdapterDialectCapability("minimax", ["adapters"], { model_profile_id: "minimax-h3", provider_model: "MiniMax-H3", mode: "text-to-video" });
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const result = compileVideoPromptIrV2(standalone(), { route: route.route, model_profile: model.profile, model_profile_digest: model.digest, connection_profile: connection.profile, connection_capability_digest: connection.digest, adapter_dialect_capability: adapter.capability, grammar_profile: forged, intent: "execute" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain("VPD-K003");
  });

  it("binds a same-FD asset copy to an opaque pin and rejects self-declared pins", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-po4-pin-"));
    try {
      const realRoot = await realpath(root);
      const bytes = "asset🙂";
      await writeFile(join(realRoot, "asset.bin"), bytes);
      const pin = createVerifiedAssetPin({ asset_id: "asset-1", project_root: realRoot, project_relative_path: "asset.bin", expected_sha256: sha256Text(bytes), expected_size: Buffer.byteLength(bytes), pin_root: realRoot });
      expect(isTrustedAssetPin(pin)).toBe(true);
      expect(isTrustedAssetPin({ ...pin })).toBe(false);
      expect(pin.relative_path).not.toContain(realRoot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts strict native V2 project schema only as an active authoring surface", () => {
    const project = projectSchema.parse({ slug: "native-v2", name: "native-v2", manifest: "manifest.json", edit: { backend: "remotion" }, orchestration: { mode: "active" }, generation: { requests: [{ id: "r1", prompt: "", params: {}, video_prompt: standalone() }] } });
    expect(project.orchestration?.mode).toBe("active");
    expect(() => projectSchema.parse({ ...project, generation: { requests: [{ ...project.generation?.requests[0], video_prompt: { ...standalone(), unknown: true } }] } })).toThrow();
  });
});
