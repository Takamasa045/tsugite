/**
 * Phase E: iteration multi_block + retry_saturation pure lint.
 */
import { describe, expect, it } from "vitest";
import {
  ITERATION_MULTI_BLOCK_CHANGE_CODE,
  ITERATION_RETRY_SATURATION_CODE,
  iterationFindingsToWarningMessages,
  lintIterationDiscipline,
  type IterationLineageSnapshot
} from "../src/orchestrator/iterationDiscipline.js";
import {
  collectPromptBlockDigests,
  countChangedBlocks
} from "../src/videoPromptDirector/blockDigests.js";
import { parseH3CreativeIr } from "../src/h3/index.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compileH3Request } from "../src/h3/index.js";

function snap(
  requestId: string,
  ordinal: number,
  digests: Record<string, string>
): IterationLineageSnapshot {
  return {
    request_id: requestId,
    generation_ordinal: ordinal,
    block_digests: digests
  };
}

describe("Phase E iteration discipline", () => {
  it("no multi_block when only one block changes", () => {
    const prev = snap("shot-a", 3, { visual: "aaa", camera: "bbb", audio: "ccc" });
    const curr = snap("shot-a", 4, { visual: "ddd", camera: "bbb", audio: "ccc" });
    const findings = lintIterationDiscipline(curr, prev);
    expect(
      findings.filter((item) => item.code === ITERATION_MULTI_BLOCK_CHANGE_CODE)
    ).toEqual([]);
  });

  it("multi_block when two or more blocks change", () => {
    const prev = snap("shot-a", 3, { visual: "aaa", camera: "bbb", audio: "ccc" });
    const curr = snap("shot-a", 4, { visual: "ddd", camera: "eee", audio: "ccc" });
    const findings = lintIterationDiscipline(curr, prev);
    expect(findings.some((item) => item.code === ITERATION_MULTI_BLOCK_CHANGE_CODE)).toBe(
      true
    );
    expect(countChangedBlocks(prev.block_digests, curr.block_digests)).toBe(2);
  });

  it("identical digests skip multi_block", () => {
    const digests = { visual: "aaa", camera: "bbb" };
    const findings = lintIterationDiscipline(snap("shot-a", 5, digests), snap("shot-a", 4, digests));
    expect(
      findings.filter((item) => item.code === ITERATION_MULTI_BLOCK_CHANGE_CODE)
    ).toEqual([]);
  });

  it("retry_saturation at ordinal 10", () => {
    const digests = { visual: "aaa" };
    expect(
      lintIterationDiscipline(snap("shot-a", 9, digests), undefined).some(
        (item) => item.code === ITERATION_RETRY_SATURATION_CODE
      )
    ).toBe(false);
    const saturated = lintIterationDiscipline(snap("shot-a", 10, digests), undefined);
    expect(saturated.some((item) => item.code === ITERATION_RETRY_SATURATION_CODE)).toBe(
      true
    );
    expect(saturated[0]?.message).toMatch(/split|simplif/i);
  });

  it("history length 0–1 skips multi_block", () => {
    const findings = lintIterationDiscipline(
      snap("shot-a", 1, { visual: "aaa", camera: "bbb" }),
      undefined
    );
    expect(
      findings.filter((item) => item.code === ITERATION_MULTI_BLOCK_CHANGE_CODE)
    ).toEqual([]);
  });

  it("new block key counts as a change", () => {
    const prev = snap("shot-a", 1, { visual: "aaa" });
    const curr = snap("shot-a", 2, { visual: "aaa", camera: "bbb" });
    expect(countChangedBlocks(prev.block_digests, curr.block_digests)).toBe(1);
  });

  it("deterministic sort of findings", () => {
    const prev = snap("shot-a", 9, { a: "1", b: "2" });
    const curr = snap("shot-a", 10, { a: "x", b: "y" });
    const once = lintIterationDiscipline(curr, prev).map((item) => item.code);
    const twice = lintIterationDiscipline(curr, prev).map((item) => item.code);
    expect(once).toEqual(twice);
    expect(once).toEqual([
      ITERATION_MULTI_BLOCK_CHANGE_CODE,
      ITERATION_RETRY_SATURATION_CODE
    ].sort((a, b) => a.localeCompare(b)));
  });

  it("messages flatten for review warnings", () => {
    const findings = lintIterationDiscipline(
      snap("shot-a", 10, { a: "1", b: "2" }),
      snap("shot-a", 9, { a: "x", b: "y" })
    );
    const messages = iterationFindingsToWarningMessages(findings);
    expect(messages.every((message) => message.startsWith("[イテレーション]"))).toBe(true);
  });

  it("compile lineage includes block_digests", async () => {
    const ir = parseH3CreativeIr(
      JSON.parse(await readFile(join("test/fixtures/h3/t2v.json"), "utf8"))
    );
    const compiled = compileH3Request({ id: "t2v", prompt: "", params: {}, h3: ir });
    expect(compiled.ok).toBe(true);
    expect(compiled.compilation!.lineage.block_digests).toBeDefined();
    expect(
      Object.keys(compiled.compilation!.lineage.block_digests!).length
    ).toBeGreaterThan(0);
    expect(collectPromptBlockDigests(ir)).toEqual(
      compiled.compilation!.lineage.block_digests
    );
  });
});
