import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIntakeCliOptions } from "../adapters/hypit/productionCliMain.mjs";
import { intakeReference, loadProductionState, saveProductionState } from "../adapters/hypit/orchestrator.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production CLI intake option omission", () => {
  it("omits production_id, brief, and instruction when flags are absent", () => {
    const omitted = buildIntakeCliOptions([
      "intake",
      "--from",
      "/tmp/ref.mp4",
      "--production",
      "/tmp/draft-named"
    ]);
    expect(Object.hasOwn(omitted, "production_id")).toBe(false);
    expect(Object.hasOwn(omitted, "brief")).toBe(false);
    expect(Object.hasOwn(omitted, "instruction")).toBe(false);
    expect(omitted).toEqual({});
  });

  it("includes only the flags that were specified", () => {
    expect(buildIntakeCliOptions(["intake", "--production-id", "lab"])).toEqual({ production_id: "lab" });
    expect(buildIntakeCliOptions(["intake", "--brief", "b", "--instruction", "i"])).toEqual({
      brief: "b",
      instruction: "i"
    });
  });

  it("keeps an existing production_id when CLI omits --production-id and refuses a mismatch", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tsugite-cli-intake-"));
    roots.push(tmp);
    const productionRoot = join(tmp, "draft-named");
    mkdirSync(productionRoot, { recursive: true });
    saveProductionState(productionRoot, {
      productionRoot,
      workspace: join(productionRoot, "hypit-workspace"),
      brief: "keep brief",
      instruction: "keep instruction",
      run: { production_id: "draft-named", adapter_id: "authoring-adapter" },
      ui: { progress: "draft", fake: false }
    });
    const omitted = buildIntakeCliOptions(["intake", "--from", join(tmp, "missing.mp4"), "--production", productionRoot]);
    expect(Object.hasOwn(omitted, "production_id")).toBe(false);
    await expect(intakeReference(productionRoot, join(tmp, "missing.mp4"), omitted))
      .rejects.toThrow();
    expect(loadProductionState(productionRoot).run.production_id).toBe("draft-named");
    expect(loadProductionState(productionRoot).brief).toBe("keep brief");

    const mismatched = buildIntakeCliOptions([
      "intake",
      "--from",
      join(tmp, "missing.mp4"),
      "--production",
      productionRoot,
      "--production-id",
      "lab"
    ]);
    expect(mismatched).toEqual({ production_id: "lab" });
    await expect(intakeReference(productionRoot, join(tmp, "missing.mp4"), mismatched))
      .rejects.toMatchObject({ code: "PC_IDENTITY_MISMATCH" });
    expect(loadProductionState(productionRoot).run.production_id).toBe("draft-named");
    expect(loadProductionState(productionRoot).brief).toBe("keep brief");
    expect(loadProductionState(productionRoot).instruction).toBe("keep instruction");
  });
});
