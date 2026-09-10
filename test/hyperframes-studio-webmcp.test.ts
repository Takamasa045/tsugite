import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  PATCH_ROOT,
  PINNED_HYPERFRAMES_PATCHES,
  PINNED_HYPERFRAMES_VERSION,
  applyPinnedHyperframesPatches,
  sha256Text
} from "../backends/hyperframes/apply-pinned-patches.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SERVED = PINNED_HYPERFRAMES_PATCHES.find((patch) => patch.id === "served-studio-html-guard");

function loadZd(source) {
  return new Function(`${source}; return ZD;`)();
}

function nodeLike(overrides) {
  return {
    nodeType: 1,
    isConnected: true,
    namespaceURI: HTML_NS,
    ...overrides
  };
}

describe("hyperframes studio webmcp patches", () => {
  it("keeps PATCH_ROOT independent of process cwd", () => {
    expect(PATCH_ROOT.replace(/\/$/, "")).toBe(join(import.meta.dirname, ".."));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { pathToFileURL } from "node:url";
      const href = pathToFileURL(${JSON.stringify(join(PATCH_ROOT, "backends/hyperframes/apply-pinned-patches.mjs"))}).href;
      const { PATCH_ROOT } = await import(href);
      process.stdout.write(PATCH_ROOT);
    `], { cwd: tmpdir(), encoding: "utf8", timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.replace(/\/$/, "")).toBe(join(import.meta.dirname, ".."));
  });

  it("covers the synthetic served ZD guard contract for constructor mismatch, SVG, and detached nodes", () => {
    function RealmA() {}
    function RealmB() {}
    const original = loadZd(SERVED.from);
    const patched = loadZd(SERVED.to);
    const doc = { defaultView: { HTMLElement: RealmA } };
    const adopted = nodeLike({ ownerDocument: doc });
    Object.setPrototypeOf(adopted, RealmB.prototype);

    expect(adopted instanceof RealmA).toBe(false);
    expect(original(doc, adopted)).toBeNull();
    expect(patched(doc, adopted)).toBe(adopted);

    const sameRealm = nodeLike({ ownerDocument: doc });
    Object.setPrototypeOf(sameRealm, RealmA.prototype);
    expect(original(doc, sameRealm)).toBe(sameRealm);
    expect(patched(doc, sameRealm)).toBe(sameRealm);

    const svg = nodeLike({ ownerDocument: doc, namespaceURI: "http://www.w3.org/2000/svg" });
    Object.setPrototypeOf(svg, RealmA.prototype);
    expect(original(doc, svg)).toBe(svg);
    expect(patched(doc, svg)).toBeNull();

    const detached = nodeLike({ ownerDocument: doc, isConnected: false });
    Object.setPrototypeOf(detached, RealmA.prototype);
    expect(original(doc, detached)).toBe(detached);
    expect(patched(doc, detached)).toBeNull();

    const otherDoc = nodeLike({ ownerDocument: { defaultView: doc.defaultView } });
    Object.setPrototypeOf(otherDoc, RealmA.prototype);
    expect(patched(doc, otherDoc)).toBeNull();
  });

  it("patches the served Studio bundle referenced by index.html without needing a helper module", async () => {
    const html = await readFile(join(PATCH_ROOT, "node_modules/hyperframes/dist/studio/index.html"), "utf8");
    expect(html).toContain('src="/assets/index-Bq3M0sjr.js"');
    expect(SERVED.relative).toBe("node_modules/hyperframes/dist/studio/assets/index-Bq3M0sjr.js");
    const served = await readFile(join(PATCH_ROOT, SERVED.relative), "utf8");
    expect(served).toContain(SERVED.to);
    expect(served).not.toContain(SERVED.from);
    expect(served).toContain(`namespaceURI!=="${HTML_NS}"`);
  });

  it("documents the served-bundle patch boundary and 0.8.33 write incompatibility", async () => {
    const [guide, report] = await Promise.all([
      readFile(join(PATCH_ROOT, "docs/hyperframes-studio-webmcp.md"), "utf8"),
      readFile(join(PATCH_ROOT, "docs/reports/hyperframes-studio-webmcp-2026-09-10.md"), "utf8")
    ]);
    expect(guide).toContain("/assets/index-Bq3M0sjr.js");
    expect(guide).toContain("apply-pinned-patches.mjs");
    expect(guide).toContain("execute:(e,{signal:n})");
    expect(report).toContain("no element matches handle");
    expect(report).toContain("index-Bq3M0sjr.js");
  });

  it("rejects version, hash, and occurrence drift on an isolated fixture", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "tsugite-hf-patch-"));
    try {
      const relative = "node_modules/hyperframes/dist/studio/assets/index-Bq3M0sjr.js";
      const original = `prefix${SERVED.from}suffix`;
      const patch = {
        id: "fixture-guard",
        relative,
        sha256: sha256Text(original),
        from: SERVED.from,
        to: SERVED.to
      };
      await mkdir(join(fixture, dirname(relative)), { recursive: true });
      await writeFile(
        join(fixture, "node_modules/hyperframes/package.json"),
        JSON.stringify({ name: "hyperframes", version: "0.8.33" })
      );
      await writeFile(join(fixture, relative), original);
      await expect(applyPinnedHyperframesPatches(fixture, { patches: [patch] }))
        .rejects.toThrow(/not the pinned 0.8.24/);

      await writeFile(
        join(fixture, "node_modules/hyperframes/package.json"),
        JSON.stringify({ name: "hyperframes", version: PINNED_HYPERFRAMES_VERSION })
      );
      await writeFile(join(fixture, relative), `tampered${SERVED.from}`);
      await expect(applyPinnedHyperframesPatches(fixture, { patches: [patch] }))
        .rejects.toThrow(/sha256/);

      await writeFile(join(fixture, relative), `${SERVED.from}${SERVED.from}`);
      await expect(applyPinnedHyperframesPatches(fixture, { patches: [patch] }))
        .rejects.toThrow(/neither the pinned/);

      await writeFile(join(fixture, relative), original);
      const first = await applyPinnedHyperframesPatches(fixture, { patches: [patch] });
      expect(first.applied).toEqual(["fixture-guard"]);
      const second = await applyPinnedHyperframesPatches(fixture, { patches: [patch] });
      expect(second.applied).toEqual([]);
      expect(second.already).toEqual(["fixture-guard"]);
      expect(await readFile(join(fixture, relative), "utf8")).toBe(`prefix${SERVED.to}suffix`);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
