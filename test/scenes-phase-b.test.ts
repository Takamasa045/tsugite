/**
 * Phase B: scenes layer — optional IR, LOCATION/LIGHTING prepend, Auditor checks.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileH3Request,
  parseH3CreativeIr,
  renderH3Prompt,
  SCENE_LOCATION_MAP_MISMATCH_CODE,
  SCENE_UNDECLARED_SUBJECT_CODE,
  validateH3CreativeIr,
  validateScenes,
  type H3CreativeIr
} from "../src/h3/index.js";
import {
  extractLocationMapBlock,
  formatSceneLocationBlock
} from "../src/videoPromptDirector/scenes.js";
import { renderShotBody } from "../src/videoPromptDirector/render/shared.js";
import { renderPlainPrompt } from "../src/videoPromptDirector/render/plain.js";
import type { GenerationRequest } from "../src/project/schema.js";

const LOCATION =
  "Anchor: lake shore. Dock left of the pine cluster. Mist hugs water surface.";
const PALETTE = "cool blue hour, soft side key from east, low warm practical on dock.";

async function loadT2v(): Promise<H3CreativeIr> {
  const raw = JSON.parse(await readFile(join("test/fixtures/h3/t2v.json"), "utf8"));
  return parseH3CreativeIr(raw);
}

function withScenes(base: H3CreativeIr): H3CreativeIr {
  return {
    ...base,
    scenes: [
      {
        id: "lake_dawn",
        location_map: LOCATION,
        palette: PALETTE,
        active_subjects: ["hero"]
      }
    ],
    shots: base.shots.map((shot) => ({
      ...shot,
      scene: "lake_dawn"
    }))
  };
}

function h3Request(id: string, ir: H3CreativeIr): GenerationRequest {
  return { id, prompt: "", params: {}, h3: ir };
}

describe("Phase B scenes", () => {
  it("accepts optional scenes and shot.scene refs", async () => {
    const ir = withScenes(await loadT2v());
    const parsed = parseH3CreativeIr(ir);
    expect(parsed.scenes?.[0]?.id).toBe("lake_dawn");
    expect(parsed.shots.every((shot) => shot.scene === "lake_dawn")).toBe(true);
  });

  it("rejects unknown shot.scene id", async () => {
    const base = await loadT2v();
    const bad = {
      ...base,
      shots: base.shots.map((shot, index) =>
        index === 0 ? { ...shot, scene: "missing_scene" } : shot
      )
    };
    expect(() => parseH3CreativeIr(bad)).toThrow(/scene/i);
  });

  it("rejects duplicate scene ids", async () => {
    const base = await loadT2v();
    const bad = {
      ...base,
      scenes: [
        { id: "dup", location_map: "A", active_subjects: [] },
        { id: "dup", location_map: "B", active_subjects: [] }
      ]
    };
    expect(() => parseH3CreativeIr(bad)).toThrow(/unique/i);
  });

  it("rejects active_subjects that are not defined subjects", async () => {
    const base = await loadT2v();
    const bad = {
      ...base,
      scenes: [
        {
          id: "lake_dawn",
          location_map: LOCATION,
          active_subjects: ["ghost"]
        }
      ]
    };
    expect(() => parseH3CreativeIr(bad)).toThrow(/active_subjects/i);
  });

  it("prepends LOCATION MAP and LIGHTING verbatim on H3 and plain", async () => {
    const ir = withScenes(await loadT2v());
    const h3Text = renderH3Prompt(ir).text;
    const plainText = renderPlainPrompt(ir).text;
    const expectedLocation = formatSceneLocationBlock(LOCATION);
    const expectedLight = `LIGHTING:\n${PALETTE}`;
    for (const text of [h3Text, plainText]) {
      expect(text).toContain(expectedLocation);
      expect(text).toContain(expectedLight);
      // Appear once per shot (2 shots in t2v)
      expect(text.split(expectedLocation).length - 1).toBe(2);
    }
  });

  it("no scenes keeps t2v golden prompt byte-identical", async () => {
    const ir = await loadT2v();
    const golden = JSON.parse(
      await readFile(join("test/fixtures/h3/goldens/t2v.json"), "utf8")
    ) as { canonical_prompt: string };
    expect(renderH3Prompt(ir).text).toBe(golden.canonical_prompt);
    const validation = validateH3CreativeIr(ir, {
      renderedText: renderH3Prompt(ir).text
    });
    expect(
      validation.issues.filter((item) => item.code.startsWith("scene."))
    ).toEqual([]);
  });

  it("scene.undeclared_subject when dialogue speaker outside active_subjects", async () => {
    const base = await loadT2v();
    const ir: H3CreativeIr = parseH3CreativeIr({
      ...base,
      subjects: [
        ...base.subjects,
        {
          id: "stranger",
          description: "unknown sailor",
          speaker_id: "S2"
        }
      ],
      scenes: [
        {
          id: "lake_dawn",
          location_map: LOCATION,
          active_subjects: ["hero"]
        }
      ],
      shots: base.shots.map((shot, index) => {
        if (index !== 1) return { ...shot, scene: "lake_dawn" };
        return {
          ...shot,
          scene: "lake_dawn",
          dialogue: {
            speaker: "stranger",
            language: "Japanese",
            text: "誰だ？",
            lock_text: true,
            voiceover: false
          }
        };
      })
    });

    const issues = validateScenes(ir);
    expect(issues.some((item) => item.code === SCENE_UNDECLARED_SUBJECT_CODE)).toBe(true);
    const full = validateH3CreativeIr(ir, { renderedText: renderH3Prompt(ir).text });
    // warning only — does not fail compile
    expect(full.warnings.some((item) => item.code === SCENE_UNDECLARED_SUBJECT_CODE)).toBe(
      true
    );
    const compiled = compileH3Request(h3Request("undeclared", ir));
    expect(compiled.ok).toBe(true);
  });

  it("empty active_subjects skips undeclared check", async () => {
    const base = await loadT2v();
    const ir = parseH3CreativeIr({
      ...base,
      scenes: [
        {
          id: "lake_dawn",
          location_map: LOCATION,
          active_subjects: []
        }
      ],
      shots: base.shots.map((shot) => ({ ...shot, scene: "lake_dawn" }))
    });
    expect(
      validateScenes(ir).filter((item) => item.code === SCENE_UNDECLARED_SUBJECT_CODE)
    ).toEqual([]);
  });

  it("scene.location_map_mismatch when LOCATION MAP missing from body", async () => {
    const ir = withScenes(await loadT2v());
    const bodies = ir.shots.map((shot) => renderShotBody(shot, ir));
    // Corrupt second shot body to drop location prefix
    bodies[1] = "close-up only, no location map";
    const issues = validateScenes(ir, { shotBodies: bodies });
    expect(
      issues.some((item) => item.code === SCENE_LOCATION_MAP_MISMATCH_CODE)
    ).toBe(true);
  });

  it("scene.location_map_mismatch when LOCATION MAP differs across shots", async () => {
    const ir = withScenes(await loadT2v());
    const expected = formatSceneLocationBlock(LOCATION);
    const bodies = [
      `${expected} LIGHTING:\n${PALETTE} shot one visual`,
      `LOCATION MAP:\nDIFFERENT ANCHOR ENTIRELY LIGHTING:\n${PALETTE} shot two visual`
    ];
    const issues = validateScenes(ir, { shotBodies: bodies });
    expect(
      issues.some((item) => item.code === SCENE_LOCATION_MAP_MISMATCH_CODE)
    ).toBe(true);
    // Extractor stops before LIGHTING when present
    expect(extractLocationMapBlock(bodies[0]!)).toBe(expected);
  });

  it("happy path compile records no scene errors", async () => {
    const ir = withScenes(await loadT2v());
    const compiled = compileH3Request(h3Request("scene-ok", ir));
    expect(compiled.ok).toBe(true);
    expect(
      compiled.compilation!.validation.errors.filter((item) =>
        item.code.startsWith("scene.")
      )
    ).toEqual([]);
    expect(compiled.compilation!.canonical_prompt).toContain(LOCATION);
  });
});
