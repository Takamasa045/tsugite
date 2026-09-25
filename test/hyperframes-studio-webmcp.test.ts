import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  PATCH_ROOT, PINNED_HYPERFRAMES_PATCHES, PINNED_HYPERFRAMES_VERSION,
  applyPinnedHyperframesPatches, sha256Text
} from "../backends/hyperframes/apply-pinned-patches.mjs";

describe("hyperframes 0.8.75 integration", () => {
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

  it("patches only the reviewed CLI zip imports", async () => {
    expect(PINNED_HYPERFRAMES_PATCHES.map((patch) => patch.id)).toEqual([
      "cli-adm-zip-static-import", "cli-adm-zip-lottie-import"
    ]);
    const cli = await readFile(join(PATCH_ROOT, PINNED_HYPERFRAMES_PATCHES[0].relative), "utf8");
    for (const patch of PINNED_HYPERFRAMES_PATCHES) {
      expect(cli).toContain(patch.to);
      expect(cli).not.toContain(patch.from);
    }
    expect((await applyPinnedHyperframesPatches()).already).toEqual(
      PINNED_HYPERFRAMES_PATCHES.map((patch) => patch.id)
    );
  });

  it("documents handle-targeted Studio writes", async () => {
    const guide = await readFile(join(PATCH_ROOT, "docs/hyperframes-studio-webmcp.md"), "utf8");
    expect(guide).toContain("0.8.75");
    expect(guide).toContain('studio_set_text", { handle, text:');
    expect(guide).toContain('studio_set_style", { handle, styles:');
  });

  it("rejects version, hash, and occurrence drift on an isolated fixture", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "tsugite-hf-patch-"));
    const selected = PINNED_HYPERFRAMES_PATCHES[0];
    const original = `prefix${selected.from}suffix`;
    const patch = { ...selected, sha256: sha256Text(original) };
    try {
      await mkdir(join(fixture, dirname(patch.relative)), { recursive: true });
      const manifest = join(fixture, "node_modules/hyperframes/package.json");
      const source = join(fixture, patch.relative);
      await writeFile(manifest, JSON.stringify({ name: "hyperframes", version: "0.8.74" }));
      await writeFile(source, original);
      await expect(applyPinnedHyperframesPatches(fixture, { patches: [patch] }))
        .rejects.toThrow(/not the pinned 0.8.75/);
      await writeFile(manifest, JSON.stringify({ name: "hyperframes", version: PINNED_HYPERFRAMES_VERSION }));
      await writeFile(source, `tampered${selected.from}`);
      await expect(applyPinnedHyperframesPatches(fixture, { patches: [patch] }))
        .rejects.toThrow(/sha256/);
      await writeFile(source, `${selected.from}${selected.from}`);
      await expect(applyPinnedHyperframesPatches(fixture, { patches: [patch] }))
        .rejects.toThrow(/neither the pinned/);
      await writeFile(source, original);
      expect((await applyPinnedHyperframesPatches(fixture, { patches: [patch] })).applied).toEqual([patch.id]);
      expect((await applyPinnedHyperframesPatches(fixture, { patches: [patch] })).already).toEqual([patch.id]);
      expect(await readFile(source, "utf8")).toBe(`prefix${selected.to}suffix`);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
