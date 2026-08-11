/**
 * Phase C: subject variants, cast, locked flag + plan warning.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileH3Request,
  parseH3CreativeIr,
  validateH3CreativeIr,
  validateH3Warnings,
  type H3CreativeIr
} from "../src/h3/index.js";
import { resolveSubjectSourceAsset } from "../src/videoPromptDirector/subjectResolve.js";
import type { GenerationRequest } from "../src/project/schema.js";

async function loadReference(): Promise<H3CreativeIr> {
  return parseH3CreativeIr(
    JSON.parse(await readFile(join("test/fixtures/h3/reference.json"), "utf8"))
  );
}

function h3Request(id: string, ir: H3CreativeIr): GenerationRequest {
  return { id, prompt: "", params: {}, h3: ir };
}

describe("Phase C variants and locked", () => {
  it("omitted locked is treated as unlocked warning", async () => {
    const ir = await loadReference();
    const warnings = validateH3Warnings(ir).warnings;
    expect(warnings.some((item) => item.code === "identity.subject_unlocked")).toBe(true);
  });

  it("locked:true suppresses identity.subject_unlocked for that subject", async () => {
    const base = await loadReference();
    const ir = parseH3CreativeIr({
      ...base,
      subjects: base.subjects.map((subject) => ({ ...subject, locked: true }))
    });
    expect(
      validateH3Warnings(ir).warnings.filter((item) => item.code === "identity.subject_unlocked")
    ).toEqual([]);
  });

  it("accepts variants and resolves default/named source_asset", async () => {
    const base = await loadReference();
    const hero = base.subjects[0]!;
    const ir = parseH3CreativeIr({
      ...base,
      subjects: [
        {
          ...hero,
          locked: true,
          source_asset: hero.source_asset,
          variants: [
            { id: "clean", source_asset: hero.source_asset! },
            { id: "wet", source_asset: hero.source_asset! }
          ]
        }
      ],
      shots: base.shots.map((shot, index) =>
        index === 0
          ? {
              ...shot,
              cast: [{ subject: hero.id, variant: "wet" }]
            }
          : shot
      )
    });
    const subject = ir.subjects[0]!;
    expect(resolveSubjectSourceAsset(subject)).toBe(hero.source_asset);
    expect(resolveSubjectSourceAsset(subject, "wet")).toBe(hero.source_asset);
    expect(resolveSubjectSourceAsset(subject, "missing")).toBeUndefined();
    const compiled = compileH3Request(h3Request("variants", ir));
    expect(compiled.ok).toBe(true);
  });

  it("rejects unknown cast variant", async () => {
    const base = await loadReference();
    const hero = base.subjects[0]!;
    const bad = {
      ...base,
      subjects: [
        {
          ...hero,
          variants: [{ id: "clean", source_asset: hero.source_asset! }]
        }
      ],
      shots: [
        {
          ...base.shots[0],
          cast: [{ subject: hero.id, variant: "ghost" }]
        },
        ...base.shots.slice(1)
      ]
    };
    expect(() => parseH3CreativeIr(bad)).toThrow(/variant/i);
  });

  it("rejects duplicate variant ids", async () => {
    const base = await loadReference();
    const hero = base.subjects[0]!;
    const bad = {
      ...base,
      subjects: [
        {
          ...hero,
          variants: [
            { id: "clean", source_asset: hero.source_asset! },
            { id: "clean", source_asset: hero.source_asset! }
          ]
        }
      ]
    };
    expect(() => parseH3CreativeIr(bad)).toThrow(/unique/i);
  });

  it("rejects variant source_asset not in assets", async () => {
    const base = await loadReference();
    const hero = base.subjects[0]!;
    const bad = {
      ...base,
      subjects: [
        {
          ...hero,
          variants: [{ id: "clean", source_asset: "no_such_asset" }]
        }
      ]
    };
    expect(() => parseH3CreativeIr(bad)).toThrow(/source_asset/i);
  });

  it("compile with unlocked subject remains ok (warning only)", async () => {
    const ir = await loadReference();
    const compiled = compileH3Request(h3Request("unlocked", ir));
    expect(compiled.ok).toBe(true);
    expect(
      compiled.compilation!.validation.warnings.some(
        (item) => item.code === "identity.subject_unlocked"
      )
    ).toBe(true);
    // No automatic stress test / credit burn
    expect(compiled.compilation!.execution_request.prompt.length).toBeGreaterThan(0);
  });
});
