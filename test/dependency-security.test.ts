import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const ROOT = resolve(import.meta.dirname, "..");

type Workflow = {
  jobs: Record<string, { steps: Array<{ run?: string }> }>;
};

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve(ROOT, path), "utf8"));
}

describe("dependency security contracts", () => {
  it("pins the reviewed transitive security fixes in the manifest and lockfile", async () => {
    const [manifest, lockfile, ciWorkflow, desktopWorkflow] = await Promise.all([
      readJson("package.json"),
      readJson("package-lock.json"),
      readFile(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(ROOT, ".github/workflows/desktop.yml"), "utf8")
    ]);

    expect(manifest.overrides).toMatchObject({
      "@hono/node-server": "2.0.11",
      "adm-zip": "npm:fflate@0.8.3",
      "fast-uri": "3.1.7",
      hono: "4.13.7",
      "ip-address": "10.4.0",
      postcss: "8.5.25",
      qs: "6.16.0",
      sharp: "0.35.4"
    });
    expect(manifest.scripts.postinstall).toBe("node backends/hyperframes/apply-pinned-patches.mjs");
    expect(manifest.devDependencies["@tsugite/hyperframes-in-memory-zip"]).toBe(
      "file:backends/hyperframes/in-memory-zip"
    );
    expect(manifest.devDependencies.hyperframes).toBe("0.8.24");
    expect(lockfile.packages["node_modules/hyperframes"]?.version).toBe("0.8.24");
    expect(lockfile.packages["node_modules/hyperframes"]?.dependencies?.["adm-zip"]).toBe("^0.6.0");
    expect(lockfile.packages["node_modules/fflate"]?.version).toBe("0.8.3");
    const aliased = Object.entries(lockfile.packages).filter(([path]) => path.endsWith("node_modules/adm-zip"));
    expect(aliased.length).toBeGreaterThan(0);
    for (const [, entry] of aliased) {
      expect(entry.name ?? "fflate").not.toBe("adm-zip");
      expect(entry.version).toBe("0.8.3");
      expect(String(entry.resolved ?? "")).toMatch(/fflate/);
    }
    expect(lockfile.packages["node_modules/@hono/node-server"].version).toBe("2.0.11");
    expect(lockfile.packages["node_modules/fast-uri"].version).toBe("3.1.7");
    expect(lockfile.packages["node_modules/qs"].version).toBe("6.16.0");
    expect(lockfile.packages["node_modules/hono"].version).toBe("4.13.7");
    expect(lockfile.packages["node_modules/ip-address"].version).toBe("10.4.0");
    expect(lockfile.packages["node_modules/postcss"].version).toBe("8.5.25");
    expect(lockfile.packages["node_modules/sharp"].version).toBe("0.35.4");
    expect(manifest.scripts["security:audit"]).toBe(
      "npm audit --omit=dev --audit-level=moderate && npm audit --audit-level=moderate"
    );
    const ci = YAML.parse(ciWorkflow) as Workflow;
    const desktop = YAML.parse(desktopWorkflow) as Workflow;
    expect(ci.jobs.check.steps).toContainEqual(
      expect.objectContaining({ run: "npm run security:audit" })
    );
    expect(ci.jobs["windows-smoke"].steps).toContainEqual(
      expect.objectContaining({ run: "npm run security:audit" })
    );
    expect(ci.jobs["download-site"].steps).toContainEqual(
      expect.objectContaining({
        run: "npm --prefix apps/download-site run security:audit"
      })
    );
    expect(desktop.jobs["package-smoke"].steps).toContainEqual(
      expect.objectContaining({ run: "npm run security:audit" })
    );
  });

  it("rejects a literal backslash authority before it can disagree with WHATWG URL", async () => {
    const { default: fastUri } = await import("fast-uri");
    const input = "http://evil.example\\@allowed.example";

    expect(new URL(input).hostname).toBe("evil.example");
    expect(fastUri.parse(input).error).toMatch(/literal backslash/i);
  });

  it("keeps the Hono API used by the MCP streamable HTTP transport", async () => {
    const [{ getRequestListener }, { StreamableHTTPServerTransport }] = await Promise.all([
      import("@hono/node-server"),
      import("@modelcontextprotocol/sdk/server/streamableHttp.js")
    ]);

    expect(getRequestListener).toBeTypeOf("function");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await transport.start();
    await transport.close();
  });

  it("keeps the Sharp operations used by HyperFrames contact sheets", async () => {
    const { default: sharp } = await import("sharp");
    const source = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).png().toBuffer();
    const overlay = Buffer.from(
      '<svg width="1" height="1"><rect width="1" height="1" fill="#fff"/></svg>'
    );
    const result = await sharp(source)
      .resize(4, 4, { fit: "contain", background: { r: 26, g: 26, b: 26, alpha: 1 } })
      .flatten({ background: { r: 26, g: 26, b: 26 } })
      .composite([{ input: overlay, left: 0, top: 0 }])
      .jpeg({ quality: 88 })
      .toBuffer({ resolveWithObject: true });

    expect(result.info).toMatchObject({ width: 4, height: 4, format: "jpeg" });
  });

  it("keeps the installed HyperFrames CLI loadable", () => {
    const result = spawnSync(
      process.execPath,
      [resolve(ROOT, "node_modules/hyperframes/bin/hyperframes.mjs"), "--help"],
      { cwd: ROOT, encoding: "utf8", timeout: 15_000 }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("hyperframes v");
    expect(result.stdout).toContain("render");
  });

  it("aliases adm-zip to fflate instead of the vulnerable implementation", async () => {
    const installed = JSON.parse(
      await readFile(resolve(ROOT, "node_modules/adm-zip/package.json"), "utf8")
    );
    expect(installed.name).toBe("fflate");
    expect(installed.version).toBe("0.8.3");
    const published = JSON.parse(
      await readFile(resolve(ROOT, "node_modules/hyperframes/package.json"), "utf8")
    );
    expect(published.dependencies["adm-zip"]).toBe("^0.6.0");
  });
});
