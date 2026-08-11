/**
 * Phase D: prompt skeleton catalog + opt-in plain render.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseH3CreativeIr, renderH3Prompt, type H3CreativeIr } from "../src/h3/index.js";
import {
  DEFAULT_SKELETON_BLOCKS,
  renderPlainPrompt,
  renderSkeletonPrompt,
  renderVideoPrompt
} from "../src/videoPromptDirector/render/index.js";
import type { ModelPromptProfile } from "../src/videoPromptDirector/modelProfile.js";

async function loadT2v(): Promise<H3CreativeIr> {
  return parseH3CreativeIr(
    JSON.parse(await readFile(join("test/fixtures/h3/t2v.json"), "utf8"))
  );
}

function plainProfile(skeleton?: { id: string; blocks?: string[] }): Pick<
  ModelPromptProfile,
  "id" | "renderer" | "prompt_skeleton"
> {
  return {
    id: "v6",
    renderer: "plain-prompt",
    ...(skeleton ? { prompt_skeleton: skeleton } : {})
  };
}

describe("Phase D prompt skeleton", () => {
  it("without prompt_skeleton plain output matches legacy plain renderer", async () => {
    const ir = await loadT2v();
    const viaFacade = renderVideoPrompt(ir, plainProfile());
    const direct = renderPlainPrompt(ir);
    expect(viaFacade.text).toBe(direct.text);
    expect(viaFacade.text).toContain("model:");
    expect(viaFacade.text).toContain("shots:");
    expect(viaFacade.text).not.toContain("skeleton:");
  });

  it("with prompt_skeleton emits skeleton block order", async () => {
    const ir = await loadT2v();
    const rendered = renderVideoPrompt(
      ir,
      plainProfile({ id: "longform-story-v1" })
    );
    expect(rendered.text).toContain("skeleton: longform-story-v1");
    for (const block of DEFAULT_SKELETON_BLOCKS) {
      expect(rendered.text).toContain(`${block}:`);
      expect(rendered.sections[block]).toBeDefined();
    }
    // Block order: first skeleton header after meta is SCENE_CONTEXT
    const idxScene = rendered.text.indexOf("SCENE_CONTEXT:");
    const idxAction = rendered.text.indexOf("ACTION_TIMING:");
    const idxQuality = rendered.text.indexOf("QUALITY:");
    expect(idxScene).toBeGreaterThan(0);
    expect(idxAction).toBeGreaterThan(idxScene);
    expect(idxQuality).toBeGreaterThan(idxAction);
  });

  it("H3 grammar ignores skeleton and stays golden-stable for no-scene IR", async () => {
    const ir = await loadT2v();
    const h3 = renderH3Prompt(ir);
    const viaFacade = renderVideoPrompt(ir, {
      id: "minimax-h3",
      renderer: "h3-grammar",
      prompt_skeleton: { id: "longform-story-v1" }
    });
    expect(viaFacade.text).toBe(h3.text);
    expect(viaFacade.text).not.toContain("skeleton:");
  });

  it("catalog file exists with disclaimer fields", async () => {
    const raw = await readFile(
      "knowledge/prompt-skeletons/longform-story-v1.yaml",
      "utf8"
    );
    expect(raw).toContain("prompt-guidance-only");
    expect(raw).toContain("not-evaluated");
    expect(raw).toContain("SCENE_CONTEXT");
    const readme = await readFile("knowledge/prompt-skeletons/README.md", "utf8");
    expect(readme).toMatch(/advisory|not-evaluated/i);
  });

  it("custom blocks override default order", async () => {
    const ir = await loadT2v();
    const rendered = renderSkeletonPrompt(ir, {
      id: "v6",
      renderer: "plain-prompt",
      prompt_skeleton: {
        id: "custom",
        blocks: ["QUALITY", "ACTION_TIMING"]
      }
    });
    const q = rendered.text.indexOf("QUALITY:");
    const a = rendered.text.indexOf("ACTION_TIMING:");
    expect(q).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(q);
  });
});
