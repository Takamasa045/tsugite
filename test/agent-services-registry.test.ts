import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertResolvedAddressesPublic,
  buildEndpointAllowlist,
  createAllowlistedFetch,
  isPublicIpAddress,
  listAgentServices,
  loadAgentServiceRegistry,
  looksWriteLikeToolName,
  resolveAgentService,
  validateRegistryEndpoint
} from "../src/agentServices/index.js";
import { PipelineError } from "../src/types.js";

async function writeRegistry(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tsugite-agent-registry-"));
  const path = join(root, "registry.yaml");
  await writeFile(path, body, "utf8");
  return path;
}

describe("agent service registry schema", () => {
  it("loads the bundled public read-only registry", async () => {
    const registry = await loadAgentServiceRegistry();
    expect(registry.schema_version).toBe(1);
    expect(registry.services.map((service) => service.id)).toEqual([
      "itopan-search",
      "azumimusuhi-search",
      "lab-search",
      "azumi-experience"
    ]);

    const itopan = registry.services[0];
    expect(itopan).toMatchObject({
      type: "mcp-remote",
      transport: "streamable-http",
      auth_kind: "none",
      endpoint: "https://724d49cd-2eaf-48d8-8363-20218c1ca177.search.ai.cloudflare.com/mcp",
      tools: [{ name: "search", policy: { action: "read_public_data", approval: "none" } }]
    });

    const experience = registry.services.find((service) => service.id === "azumi-experience");
    expect(experience?.tools.map((tool) => tool.name).sort()).toEqual([
      "get_experience",
      "plan_experience",
      "search_experiences"
    ]);
    expect(experience?.tools.every((tool) => tool.policy.approval === "none")).toBe(true);
    expect(experience?.tools.every((tool) => tool.policy.action === "read_public_data")).toBe(true);

    const list = await listAgentServices();
    expect(list).toHaveLength(4);
    expect(list.every((service) => service.billing_action === false)).toBe(true);
    expect(list.every((service) => service.provider_usage_possible === true)).toBe(true);
    expect(list.every((service) => service.mvp_executable === true)).toBe(true);
    expect(list.every((service) => service.schema_requires_human_gate === false)).toBe(true);
    expect(list[0].endpoint_host).toBe("724d49cd-2eaf-48d8-8363-20218c1ca177.search.ai.cloudflare.com");
    expect(list[0].endpoint_canonical).toContain("/mcp");
  });

  it("rejects fixed schema version mismatches and duplicate ids", async () => {
    const wrongVersion = await writeRegistry(`
schema_version: 2
services:
  - id: demo
    display_name: Demo
    type: mcp-remote
    transport: streamable-http
    endpoint: https://example.com/mcp
    auth_kind: none
    capabilities: [search.public]
    tools:
      - name: search
        policy: { action: read_public_data, approval: none }
`);
    await expect(loadAgentServiceRegistry(wrongVersion)).rejects.toBeInstanceOf(PipelineError);

    const duplicate = await writeRegistry(`
schema_version: 1
services:
  - id: demo
    display_name: Demo
    type: mcp-remote
    transport: streamable-http
    endpoint: https://example.com/mcp
    auth_kind: none
    capabilities: [search.public]
    tools:
      - name: search
        policy: { action: read_public_data, approval: none }
  - id: demo
    display_name: Demo 2
    type: mcp-remote
    transport: streamable-http
    endpoint: https://example.org/mcp
    auth_kind: none
    capabilities: [search.public]
    tools:
      - name: search
        policy: { action: read_public_data, approval: none }
`);
    await expect(loadAgentServiceRegistry(duplicate)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.duplicate_id" })]
    });
  });

  it("rejects unsafe tool ids and policy mismatches", async () => {
    const unsafeTool = await writeRegistry(`
schema_version: 1
services:
  - id: demo
    display_name: Demo
    type: mcp-remote
    transport: streamable-http
    endpoint: https://example.com/mcp
    auth_kind: none
    capabilities: [search.public]
    tools:
      - name: "bad tool"
        policy: { action: read_public_data, approval: none }
`);
    await expect(loadAgentServiceRegistry(unsafeTool)).rejects.toBeInstanceOf(PipelineError);

    const sideEffectWithoutApproval = await writeRegistry(`
schema_version: 1
services:
  - id: demo
    display_name: Demo
    type: mcp-remote
    transport: streamable-http
    endpoint: https://example.com/mcp
    auth_kind: none
    capabilities: [search.public]
    tools:
      - name: submit_inquiry
        policy: { action: side_effect, approval: none }
`);
    await expect(loadAgentServiceRegistry(sideEffectWithoutApproval)).rejects.toBeInstanceOf(PipelineError);

    const writeLikeRead = await writeRegistry(`
schema_version: 1
services:
  - id: demo
    display_name: Demo
    type: mcp-remote
    transport: streamable-http
    endpoint: https://example.com/mcp
    auth_kind: none
    capabilities: [search.public]
    tools:
      - name: send_message
        policy: { action: read_public_data, approval: none }
`);
    await expect(loadAgentServiceRegistry(writeLikeRead)).rejects.toBeInstanceOf(PipelineError);
  });

  it("allows future side_effect tools with approval=required in schema only", async () => {
    const path = await writeRegistry(`
schema_version: 1
services:
  - id: future-write
    display_name: Future Write
    type: mcp-remote
    transport: streamable-http
    endpoint: https://example.com/mcp
    auth_kind: none
    capabilities: [inquiry.submit]
    tools:
      - name: submit_inquiry
        policy: { action: side_effect, approval: required }
`);
    const registry = await loadAgentServiceRegistry(path);
    expect(registry.services[0].tools[0].policy).toEqual({
      action: "side_effect",
      approval: "required"
    });
    const summary = (await listAgentServices(path))[0];
    expect(summary.side_effect).toBe(true);
    expect(summary.schema_requires_human_gate).toBe(true);
    expect(summary.mvp_executable).toBe(false);
  });

  it("resolves services only by registry id", async () => {
    await expect(resolveAgentService("itopan-search")).resolves.toMatchObject({
      id: "itopan-search",
      endpoint_validated: {
        hostname: "724d49cd-2eaf-48d8-8363-20218c1ca177.search.ai.cloudflare.com"
      }
    });
    await expect(resolveAgentService("missing-service")).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.not_found" })]
    });
  });
});

describe("agent service endpoint policy", () => {
  it("accepts public https endpoints without credentials, query, or hash", () => {
    const validated = validateRegistryEndpoint(
      "https://724d49cd-2eaf-48d8-8363-20218c1ca177.search.ai.cloudflare.com/mcp"
    );
    expect(validated.hostname).toBe(
      "724d49cd-2eaf-48d8-8363-20218c1ca177.search.ai.cloudflare.com"
    );
    expect(validated.canonical).toBe(
      "https://724d49cd-2eaf-48d8-8363-20218c1ca177.search.ai.cloudflare.com/mcp"
    );
  });

  it("rejects http, credentials, query, hash, localhost, private, and IP literals", () => {
    const rejected = [
      "http://example.com/mcp",
      "https://user:pass@example.com/mcp",
      "https://example.com/mcp?x=1",
      "https://example.com/mcp#frag",
      "https://localhost/mcp",
      "https://127.0.0.1/mcp",
      "https://[::1]/mcp",
      "https://192.168.0.1/mcp",
      "https://10.0.0.5/mcp",
      "https://169.254.169.254/mcp",
      "https://metadata.google.internal/mcp",
      "https://service.local/mcp"
    ];
    for (const endpoint of rejected) {
      expect(() => validateRegistryEndpoint(endpoint)).toThrow(PipelineError);
    }
  });

  it("binds exact endpoints and blocks different path/port, redirects, and off-allowlist hosts", async () => {
    const allowlist = buildEndpointAllowlist([
      "https://724d49cd-2eaf-48d8-8363-20218c1ca177.search.ai.cloudflare.com/mcp",
      "https://azumi-experience-mcp.tkms045.workers.dev/mcp"
    ]);
    expect(allowlist.has("https://azumi-experience-mcp.tkms045.workers.dev/mcp")).toBe(true);
    expect(allowlist.has("https://azumi-experience-mcp.tkms045.workers.dev/other")).toBe(false);

    const publicResolver = async () => ["1.1.1.1"] as const;

    const redirectFetch = createAllowlistedFetch(
      allowlist,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/mcp" }
        }),
      { dnsResolver: publicResolver }
    );
    await expect(
      redirectFetch("https://azumi-experience-mcp.tkms045.workers.dev/mcp")
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.endpoint_redirect_blocked" })]
    });

    const offlistFetch = createAllowlistedFetch(
      allowlist,
      async () => new Response("ok"),
      { dnsResolver: publicResolver }
    );
    await expect(offlistFetch("https://evil.example/mcp")).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.endpoint_forbidden" })]
    });
    await expect(
      offlistFetch("https://azumi-experience-mcp.tkms045.workers.dev/other")
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.endpoint_forbidden" })]
    });
    await expect(
      offlistFetch("https://azumi-experience-mcp.tkms045.workers.dev:8443/mcp")
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.endpoint_forbidden" })]
    });

    let called = false;
    const okFetch = createAllowlistedFetch(
      allowlist,
      async (input) => {
        called = true;
        expect(String(input)).toBe("https://azumi-experience-mcp.tkms045.workers.dev/mcp");
        return new Response("ok", { status: 200 });
      },
      { dnsResolver: publicResolver }
    );
    const response = await okFetch("https://azumi-experience-mcp.tkms045.workers.dev/mcp");
    expect(called).toBe(true);
    expect(response.status).toBe(200);
  });

  it("rejects private DNS resolutions and classifies public IPs", async () => {
    expect(isPublicIpAddress("1.1.1.1")).toBe(true);
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("10.0.0.1")).toBe(false);
    expect(isPublicIpAddress("127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("169.254.169.254")).toBe(false);
    expect(isPublicIpAddress("100.64.0.1")).toBe(false);
    expect(isPublicIpAddress("192.0.2.1")).toBe(false);
    expect(isPublicIpAddress("192.88.99.1")).toBe(false); // 6to4 relay anycast
    expect(isPublicIpAddress("::1")).toBe(false);
    expect(isPublicIpAddress("::")).toBe(false);
    expect(isPublicIpAddress("fc00::1")).toBe(false);
    expect(isPublicIpAddress("fe80::1")).toBe(false);
    expect(isPublicIpAddress("2001:db8::1")).toBe(false);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true); // Cloudflare public

    // --- prefix mask boundaries (in-range false / just-outside true) ---

    // 2001:db8::/32 documentation
    expect(isPublicIpAddress("2001:db8:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(false);
    expect(isPublicIpAddress("2001:db9::1")).toBe(true);

    // 2001:2::/48 benchmarking (RFC 5180) — third hextet must be 0
    expect(isPublicIpAddress("2001:2::1")).toBe(false);
    expect(isPublicIpAddress("2001:2:0::1")).toBe(false);
    expect(isPublicIpAddress("2001:2:1::1")).toBe(true);

    // 3fff::/20 documentation (RFC 9637) — not the overly broad 3ff0::/12
    expect(isPublicIpAddress("3fff::1")).toBe(false);
    expect(isPublicIpAddress("3fff:0fff::1")).toBe(false);
    expect(isPublicIpAddress("3fff:1000::1")).toBe(true);
    expect(isPublicIpAddress("3ff0::1")).toBe(true);
    expect(isPublicIpAddress("3ffe::1")).toBe(true);

    // 2001:10::/28 ORCHID v1 and 2001:20::/28 ORCHIDv2
    expect(isPublicIpAddress("2001:10::1")).toBe(false);
    expect(isPublicIpAddress("2001:1f::1")).toBe(false);
    expect(isPublicIpAddress("2001:0f::1")).toBe(true); // just before v1
    expect(isPublicIpAddress("2001:20::1")).toBe(false);
    expect(isPublicIpAddress("2001:2f::1")).toBe(false);
    expect(isPublicIpAddress("2001:30::1")).toBe(true); // just after v2

    // 100::/64 discard-only
    expect(isPublicIpAddress("100::1")).toBe(false);
    expect(isPublicIpAddress("100:0:0:1::1")).toBe(true); // just outside /64

    // fe80::/10 link-local / fec0::/10 site-local / fc00::/7 ULA / ff00::/8 multicast
    expect(isPublicIpAddress("fe80::1")).toBe(false);
    expect(isPublicIpAddress("febf:ffff::1")).toBe(false);
    expect(isPublicIpAddress("fec0::1")).toBe(false);
    expect(isPublicIpAddress("feff::1")).toBe(false);
    expect(isPublicIpAddress("fc00::1")).toBe(false);
    expect(isPublicIpAddress("fdff::1")).toBe(false);
    expect(isPublicIpAddress("fe00::1")).toBe(true); // just outside ULA (not link-local either)
    expect(isPublicIpAddress("ff00::1")).toBe(false);
    expect(isPublicIpAddress("ffff::1")).toBe(false);

    // NAT64 well-known 64:ff9b::/96 — evaluate embedded IPv4
    expect(isPublicIpAddress("64:ff9b::7f00:1")).toBe(false); // 127.0.0.1
    expect(isPublicIpAddress("64:ff9b::a00:1")).toBe(false); // 10.0.0.1
    expect(isPublicIpAddress("64:ff9b::101:101")).toBe(true); // 1.1.1.1 public embed
    // just outside well-known /96 (but not local-use /48)
    expect(isPublicIpAddress("64:ff9b:0:0:0:1::1")).toBe(true);

    // NAT64 local-use 64:ff9b:1::/48 — reject whole prefix (fail-closed)
    expect(isPublicIpAddress("64:ff9b:1::1")).toBe(false);
    expect(isPublicIpAddress("64:ff9b:1:ffff:ffff:ffff:ffff:ffff")).toBe(false);
    expect(isPublicIpAddress("64:ff9b:2::1")).toBe(true); // just outside /48

    // 6to4 2002::/16 — evaluate embedded IPv4
    expect(isPublicIpAddress("2002:c0a8:1::1")).toBe(false); // 192.168.0.1
    expect(isPublicIpAddress("2002:0a00:0001::1")).toBe(false); // 10.0.0.1
    expect(isPublicIpAddress("2002:0101:0101::1")).toBe(true); // 1.1.1.1 public embed
    expect(isPublicIpAddress("2003::1")).toBe(true); // just outside 2002::/16

    // IPv4-mapped ::ffff:0:0/96 — evaluate embedded IPv4 (mixed + hex)
    expect(isPublicIpAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicIpAddress("::ffff:0a00:0001")).toBe(false); // mapped 10.0.0.1 hex
    expect(isPublicIpAddress("::ffff:1.1.1.1")).toBe(true);
    expect(isPublicIpAddress("::ffff:0101:0101")).toBe(true); // mapped 1.1.1.1 hex

    // Deprecated IPv4-compatible ::/96 (non-mapped) — private/loopback embeds rejected
    expect(isPublicIpAddress("::10.0.0.1")).toBe(false);
    expect(isPublicIpAddress("::127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("::192.168.0.1")).toBe(false);
    expect(isPublicIpAddress("::0a00:0001")).toBe(false); // hex form 10.0.0.1
    expect(isPublicIpAddress("::7f00:0001")).toBe(false); // hex form 127.0.0.1
    expect(isPublicIpAddress("::1.1.1.1")).toBe(true); // public embed still public
    expect(isPublicIpAddress("::0101:0101")).toBe(true); // hex form 1.1.1.1

    await expect(
      assertResolvedAddressesPublic("example.com", async () => ["10.0.0.5"])
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.endpoint_dns_private" })]
    });

    await expect(
      assertResolvedAddressesPublic("example.com", async () => ["64:ff9b::7f00:1"])
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.endpoint_dns_private" })]
    });

    await expect(
      assertResolvedAddressesPublic("example.com", async () => ["64:ff9b:1::1"])
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent_service.endpoint_dns_private" })]
    });

    await expect(
      assertResolvedAddressesPublic("example.com", async () => ["1.1.1.1"])
    ).resolves.toBeUndefined();
  });

  it("classifies write-like tool names", () => {
    expect(looksWriteLikeToolName("search")).toBe(false);
    expect(looksWriteLikeToolName("get_experience")).toBe(false);
    expect(looksWriteLikeToolName("plan_experience")).toBe(false);
    expect(looksWriteLikeToolName("send_message")).toBe(true);
    expect(looksWriteLikeToolName("submit_inquiry")).toBe(true);
    expect(looksWriteLikeToolName("purchase_item")).toBe(true);
    expect(looksWriteLikeToolName("edit_record")).toBe(true);
    expect(looksWriteLikeToolName("approve_change")).toBe(true);
  });
});
