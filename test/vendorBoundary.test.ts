import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVendorBoundary } from "../src/vendorBoundary.js";

describe("vendor boundary", () => {
  it("keeps core files free of adapter-specific vendor names", async () => {
    const result = await checkVendorBoundary(["src", "manifest", "SKILL.md"]);

    expect(result.ok).toBe(true);
  });

  it("reports adapter-specific terms when present", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-vendor-"));
    const path = join(root, "bad.md");
    await writeFile(path, ["pix", "verse"].join(""));

    const result = await checkVendorBoundary([path]);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("vendor_boundary.term");
  });

  it("reports backend-specific terms when present", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-vendor-"));
    const path = join(root, "bad.md");
    await writeFile(path, "remotion");

    const result = await checkVendorBoundary([path]);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain("remotion");
  });
});
