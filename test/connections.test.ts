import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  connectionSelectionPrompt,
  isConnectionAdapterCompatible,
  listConnectionOptions,
  loadConnectionCatalog,
  resolveConnectionByAdapter,
  resolveGenerationConnection
} from "../src/connections/registry.js";
import { main } from "../src/cli.js";

async function capture(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const status = await main(args);
  const stdout = log.mock.calls.map((call) => String(call[0])).join("\n");
  const stderr = error.mock.calls.map((call) => String(call[0])).join("\n");
  log.mockRestore();
  error.mockRestore();
  return { status, stdout, stderr };
}

describe("generation connection registry", () => {
  it("separates model families from authenticated execution connections", async () => {
    const catalog = await loadConnectionCatalog();
    const topview = catalog.connections.find((connection) => connection.id === "topview");
    const pixverse = catalog.connections.find((connection) => connection.id === "pixverse");
    const kling = catalog.connections.find((connection) => connection.id === "kling-direct");

    expect(topview).toMatchObject({
      provider: "topview",
      transport: "mcp",
      adapter: "topview",
      execution_mode: "pipeline-adapter",
      model_families: expect.arrayContaining(["kling", "seedance", "vidu"])
    });
    expect(topview?.automated_capabilities).toEqual(expect.arrayContaining([
      "image.generate", "video.image-to-video", "video.reference-to-video", "audio.text-to-speech", "audio.music"
    ]));
    expect(pixverse).toMatchObject({ provider: "pixverse", adapter: "pixverse", model_policy: "runtime" });
    expect(pixverse?.automated_capabilities).toEqual(expect.arrayContaining([
      "image.generate", "video.transition", "audio.text-to-speech", "audio.music"
    ]));
    expect(kling).toMatchObject({ provider: "kling", adapter: "kling", model_policy: "runtime" });
    expect(kling?.route_note).toContain("Kling CLI");
    expect(catalog.connections.find((connection) => connection.id === "pixverse")?.aliases)
      .toEqual(expect.arrayContaining(["pixvers", "pixburst"]));
  });

  it("resolves integrated connection ids to existing adapters and rejects mismatches", async () => {
    await expect(resolveGenerationConnection("pixverse")).resolves.toMatchObject({
      adapter: "pixverse",
      setup_status: expect.stringMatching(/^(ready|needs-verification|needs-setup)$/)
    });
    await expect(resolveGenerationConnection("PixBurst")).resolves.toMatchObject({
      id: "pixverse",
      adapter: "pixverse"
    });
    await expect(resolveGenerationConnection("Pix Burst")).resolves.toMatchObject({ adapter: "pixverse" });
    await expect(resolveGenerationConnection("Cling")).resolves.toMatchObject({
      id: "kling-direct",
      adapter: "kling"
    });
    await expect(resolveGenerationConnection("vidu-direct")).resolves.toBeUndefined();
    await expect(resolveGenerationConnection("topview", undefined, {
      models: ["PixVerse V6"],
      capabilities: ["video.image-to-video"]
    })).resolves.toMatchObject({ id: "topview", execution_mode: "pipeline-adapter" });
    await expect(resolveGenerationConnection("pixverse", undefined, {
      models: ["Gemini 3.1 Flash Image", "Kling O3 Pro", "Grok Imagine"],
      capabilities: ["image.generate", "video.text-to-video", "audio.music"]
    })).resolves.toMatchObject({ id: "pixverse", adapter: "pixverse" });
    await expect(isConnectionAdapterCompatible("topview", "topview")).resolves.toBe(true);
    await expect(isConnectionAdapterCompatible("topview", "pixverse")).resolves.toBe(false);
  });

  it("resolves an adapter only when exactly one integrated connection matches", async () => {
    await expect(resolveConnectionByAdapter("topview", {
      models: ["Seedance 2.0"],
      capabilities: ["video.text-to-video"]
    })).resolves.toMatchObject({
      id: "topview",
      setup_status: "needs-verification"
    });

    const root = await mkdtemp(join(tmpdir(), "tsugite-connections-"));
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
  - id: route-one
    display_name: Route one
    provider: first
    transport: cli
    auth_kind: none
    implementation_status: integrated
    adapter: shared-adapter
    capabilities: [video.text-to-video]
    automated_capabilities: [video.text-to-video]
    model_families: [shared]
    route_note: first
  - id: route-two
    display_name: Route two
    provider: second
    transport: cli
    auth_kind: none
    implementation_status: integrated
    adapter: shared-adapter
    capabilities: [video.text-to-video]
    automated_capabilities: [video.text-to-video]
    model_families: [shared]
    route_note: second
`);

    await expect(resolveConnectionByAdapter("shared-adapter", {}, catalogPath)).resolves.toBeUndefined();
  });

  it("rejects connection ids and aliases that collide after resolver normalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-connections-"));
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
  - id: pix-burst
    aliases: [first-route]
    display_name: First route
    provider: first
    transport: cli
    auth_kind: subscription
    implementation_status: integrated
    adapter: mock
    capabilities: [video.text-to-video]
    automated_capabilities: [video.text-to-video]
    model_families: [pixverse]
    route_note: first
  - id: second-route
    aliases: [pix_burst]
    display_name: Second route
    provider: second
    transport: cli
    auth_kind: subscription
    implementation_status: integrated
    adapter: mock
    capabilities: [video.text-to-video]
    automated_capabilities: [video.text-to-video]
    model_families: [pixverse]
    route_note: second
`);

    await expect(loadConnectionCatalog(catalogPath)).rejects.toThrow(
      /duplicate normalized connection id or alias/
    );
  });

  it("rejects an integrated authenticated connection without a setup check", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-connections-auth-check-"));
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
  - id: unchecked-subscription
    display_name: Unchecked subscription
    provider: unchecked
    transport: cli
    auth_kind: subscription
    implementation_status: integrated
    adapter: mock
    capabilities: [video.text-to-video]
    automated_capabilities: [video.text-to-video]
    model_families: [unchecked]
    route_note: test
`);

    await expect(loadConnectionCatalog(catalogPath)).rejects.toThrow(
      /integrated authenticated connections must declare an environment or manual authentication check/
    );
  });

  it("rejects an authenticated connection with only a command existence check", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-connections-command-only-"));
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
  - id: command-only
    display_name: Command only
    provider: unchecked
    transport: cli
    auth_kind: subscription
    implementation_status: integrated
    adapter: mock
    capabilities: [video.text-to-video]
    automated_capabilities: [video.text-to-video]
    model_families: [unchecked]
    route_note: test
    setup_checks:
      - type: command
        command: node
`);

    await expect(loadConnectionCatalog(catalogPath)).rejects.toThrow(
      /integrated authenticated connections must declare an environment or manual authentication check/
    );
  });

  it("forbids route identity pinning on credential environment variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-connections-secret-pin-"));
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
  - id: unsafe-pin
    display_name: Unsafe pin
    provider: unsafe
    transport: api
    auth_kind: api-key
    implementation_status: integrated
    adapter: mock
    capabilities: [video.text-to-video]
    automated_capabilities: [video.text-to-video]
    model_families: [unsafe]
    route_note: test
    setup_checks:
      - type: environment
        variable: UNSAFE_API_KEY
        direct_route_command: true
`);

    await expect(loadConnectionCatalog(catalogPath)).rejects.toThrow(
      /direct route commands are limited to \*_COMMAND environment variables/
    );
  });

  it("filters the same model to multiple subscription routes", async () => {
    const candidates = await listConnectionOptions({
      model: "Kling V3",
      capability: "video.image-to-video",
      commandExists: async () => true
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["pixverse", "topview", "kling-direct"]);
    expect(candidates.map((candidate) => candidate.transport)).toEqual(["cli", "mcp", "cli"]);
  });

  it.each([
    "Kling 2.6 Pro",
    "Kling V3 Standard",
    "Kling O3 Pro"
  ])("accepts delimited Kling model variant '%s' without broad prefix matching", async (model) => {
    const candidates = await listConnectionOptions({ model, capability: "video.text-to-video" });
    expect(candidates.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(["pixverse", "topview", "kling-direct"])
    );
  });

  it.each(["Seedance 2.0 Pro", "Veo 3.1 Fast"])(
    "accepts delimited model variant '%s'",
    async (model) => {
      const candidates = await listConnectionOptions({ model, capability: "video.text-to-video" });
      expect(candidates.length).toBeGreaterThan(0);
    }
  );

  it.each(["Klingon", "RunwayFake", "Seedanceful", "VeoX"])(
    "does not treat unrelated prefix model '%s' as compatible",
    async (model) => {
      const candidates = await listConnectionOptions({ model, capability: "video.text-to-video" });
      expect(candidates).toEqual([]);
    }
  );

  it("offers both configured subscription routes for Seedance", async () => {
    const candidates = await listConnectionOptions({
      model: "Seedance 2.0",
      capability: "video.image-to-video",
      commandExists: async () => true
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["pixverse", "topview"]);
  });

  it("reports setup without returning environment secret values", async () => {
    const secret = "must-never-appear-in-output";
    const candidates = await listConnectionOptions({
      environment: { PATH: "/missing", EXAMPLE_API_KEY: secret },
      commandExists: async () => false
    });
    const serialized = JSON.stringify(candidates);

    expect(candidates.find((candidate) => candidate.id === "pixverse")?.setup.status).toBe("needs-setup");
    expect(serialized).not.toContain(secret);
  });

  it("treats missing and empty credential declarations as missing without exposing values", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-connections-"));
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
  - id: protected-api
    display_name: Protected API
    provider: protected
    transport: api
    auth_kind: api-key
    implementation_status: integrated
    adapter: mock
    capabilities: [video.text-to-video]
    automated_capabilities: [video.text-to-video]
    model_families: [protected]
    route_note: test
    setup_checks:
      - type: environment
        variable: PROTECTED_API_KEY
`);
    const [missing] = await listConnectionOptions({ catalogPath, environment: {} });
    const [empty] = await listConnectionOptions({ catalogPath, environment: { PROTECTED_API_KEY: "" } });
    const [whitespace] = await listConnectionOptions({
      catalogPath,
      environment: { PROTECTED_API_KEY: "   " }
    });
    const [configured] = await listConnectionOptions({
      catalogPath,
      environment: { PROTECTED_API_KEY: "must-not-be-returned" }
    });
    expect(missing.setup.status).toBe("needs-setup");
    expect(empty.setup.status).toBe("needs-setup");
    expect(whitespace.setup.status).toBe("needs-setup");
    expect(configured.setup.status).toBe("ready");
    expect(JSON.stringify(configured)).not.toContain("must-not-be-returned");
  });

  it("returns a structured question and no-subscription choices", async () => {
    const prompt = await connectionSelectionPrompt({ model: "Seedance 2.0" });

    expect(prompt).toMatchObject({
      required_when: "connection-unspecified",
      question: expect.stringContaining("どのサービス"),
      candidates: expect.arrayContaining([expect.objectContaining({ id: "topview" })]),
      no_subscription_options: expect.arrayContaining(["use-owned-media", "connect-a-service"])
    });
  });

  it("distinguishes provider capabilities from currently automated capabilities", async () => {
    const [pixverse] = await listConnectionOptions({
      model: "PixVerse V6",
      capability: "audio.music",
      commandExists: async () => true
    });

    expect(pixverse).toMatchObject({
      id: "pixverse",
      implementation_status: "integrated",
      automation_status: "integrated"
    });
  });

  it("does not match a model family inside an unrelated token", async () => {
    const candidates = await listConnectionOptions({ model: "XRay 2", capability: "video.text-to-video" });
    expect(candidates.find((candidate) => candidate.id === "luma")).toBeUndefined();
    expect(await listConnectionOptions({ model: "Klingon", capability: "video.text-to-video" }))
      .toHaveLength(0);
    expect(await listConnectionOptions({ model: "RunwayFake", capability: "video.text-to-video" }))
      .toHaveLength(0);
    expect(await listConnectionOptions({ model: "Runway Fake", capability: "video.text-to-video" }))
      .toHaveLength(0);
    expect(await listConnectionOptions({ model: "Kling3Fake", capability: "video.text-to-video" }))
      .toHaveLength(0);
    expect((await listConnectionOptions({ model: "Kling 3 Fake", capability: "video.text-to-video" }))
      .map((candidate) => candidate.id)).toEqual(["pixverse", "topview", "kling-direct"]);
    expect(await listConnectionOptions({ model: "Acme Kling 3", capability: "video.text-to-video" }))
      .toHaveLength(0);
    expect((await listConnectionOptions({ model: "Kling3", capability: "video.text-to-video" }))
      .map((candidate) => candidate.id)).toEqual([]);
  });

  it("lists connection candidates from the read-only CLI without requiring project config", async () => {
    const result = await capture([
      "connections",
      "--model",
      "Kling V3",
      "--capability",
      "video.image-to-video",
      "--json"
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      command: "connections",
      billing_action: false,
      secret_values_exposed: false,
      selection_prompt: {
        required_when: "connection-unspecified",
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: "topview" }),
          expect.objectContaining({ id: "pixverse" }),
          expect.objectContaining({ id: "kling-direct" })
        ])
      }
    });
    expect(payload.connections).toHaveLength(3);
  });
});
