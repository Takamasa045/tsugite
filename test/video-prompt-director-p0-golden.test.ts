/**
 * P0 characterization / golden baselines for existing H3 modes.
 * Production code is not required to change for these to pass.
 * Later phases must keep these goldens byte-identical.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileH3Request,
  H3_WORKFLOW_ID,
  H3_WORKFLOW_VERSION,
  parseH3CreativeIr,
  renderH3Prompt,
  sha256Canonical,
  sha256Text,
  type H3CreativeIr
} from "../src/h3/index.js";
import type { GenerationRequest } from "../src/project/schema.js";

const FIXTURES = [
  "t2v.json",
  "first-frame.json",
  "first-last.json",
  "last-frame.json",
  "reference.json",
  "voiceover.json"
] as const;

async function loadFixture(name: string): Promise<H3CreativeIr> {
  const raw = JSON.parse(await readFile(join("test/fixtures/h3", name), "utf8"));
  return parseH3CreativeIr(raw);
}

async function loadGolden(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join("test/fixtures/h3/goldens", name), "utf8"));
}

function h3Request(id: string, ir: H3CreativeIr): GenerationRequest {
  return {
    id,
    prompt: "",
    params: {},
    h3: ir
  };
}

describe("P0 H3 characterization goldens", () => {
  it.each(FIXTURES)("fixture %s prompt/hash/lineage/validation remain stable", async (name) => {
    const ir = await loadFixture(name);
    const golden = await loadGolden(name);
    const rendered = renderH3Prompt(ir);
    const compiled = compileH3Request(h3Request(name.replace(/\.json$/, ""), ir));

    expect(H3_WORKFLOW_ID).toBe("h3-prompt-director");
    expect(H3_WORKFLOW_VERSION).toBe("2");
    expect(golden.workflow_id).toBe(H3_WORKFLOW_ID);
    expect(golden.workflow_version).toBe(H3_WORKFLOW_VERSION);

    expect(sha256Canonical(ir)).toBe(golden.creative_ir_hash);
    expect(rendered.text).toBe(golden.canonical_prompt);
    expect(sha256Text(rendered.text)).toBe(golden.canonical_prompt_hash);

    expect(compiled.ok).toBe(golden.compile_ok);
    expect(compiled.compilation).toBeDefined();
    const compilation = compiled.compilation!;
    expect(compilation.canonical_prompt).toBe(golden.canonical_prompt);
    expect(compilation.adapter_prompt).toBe(golden.canonical_prompt);
    expect(compilation.lineage).toEqual(golden.lineage);
    expect(compilation.validation.ok).toBe(golden.validation_ok);
    expect(compilation.validation.errors.map((item) => item.code).sort()).toEqual(golden.error_codes);
    expect(compilation.validation.warnings.map((item) => item.code).sort()).toEqual(golden.warning_codes);
    expect(compilation.validation.issues.map((item) => item.code).sort()).toEqual(golden.issue_codes);

    const snap = golden.execution_request_snapshot as Record<string, unknown>;
    expect(compilation.execution_request.model).toBe(snap.model);
    expect(compilation.execution_request.duration).toBe(snap.duration);
    expect(compilation.execution_request.aspect).toBe(snap.aspect);
    expect(compilation.execution_request.operation).toBe(snap.operation);
    expect(compilation.execution_request.input_mode).toBe(snap.input_mode);
    expect(compilation.execution_request.first_frame).toBe(snap.first_frame);
    expect(compilation.execution_request.last_frame).toBe(snap.last_frame);
    expect(compilation.execution_request.input_images).toEqual(snap.input_images);
    expect(compilation.execution_request.input_videos).toEqual(snap.input_videos);
    expect(compilation.execution_request.input_audios).toEqual(snap.input_audios);
    expect(compilation.execution_request.params?.quality).toBe(snap.params_quality);
    expect(compilation.execution_request.params?.audio).toBe(snap.params_audio);
  });

  it("IR version remains 1 across all mode fixtures", async () => {
    for (const name of FIXTURES) {
      const ir = await loadFixture(name);
      expect(ir.version).toBe(1);
      expect(ir.target.model).toBe("minimax-h3");
    }
  });
});
