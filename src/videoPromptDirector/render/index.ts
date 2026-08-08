/**
 * Renderer facade.
 * H3 grammar is isolated in h3Grammar.ts; plain-prompt does not import it.
 * renderVideoPrompt requires an explicit model profile — no default-H3 fallback.
 */

import type { ModelPromptProfile } from "../modelProfile.js";
import type { H3CreativeIr } from "../schema.js";
import { renderH3Prompt } from "./h3Grammar.js";
import { renderPlainPrompt } from "./plain.js";
import type { H3RenderResult } from "./shared.js";

export {
  BASE_SECTION_ORDER,
  REFERENCE_SECTION_ORDER,
  formatCutTimestamp,
  renderCameraSentence,
  renderDialogueBlock,
  type H3BaseSection,
  type H3ReferenceSection,
  type H3RenderResult
} from "./shared.js";
export { renderH3BasePrompt } from "./base.js";
export { renderH3ReferencePrompt } from "./reference.js";
export { renderH3Prompt } from "./h3Grammar.js";
export { renderPlainPrompt } from "./plain.js";

export const RENDER_PROFILE_REQUIRED_CODE = "VPD-E040";

/**
 * Profile-selected renderer.
 * Profile is required. h3-grammar is used only when the model profile declares it.
 * Omitting profile never falls back to H3 grammar (fail closed with explicit error).
 */
export function renderVideoPrompt(
  ir: H3CreativeIr,
  profile: Pick<ModelPromptProfile, "renderer" | "id">
): H3RenderResult {
  if (!profile || !profile.renderer) {
    throw new Error(
      `${RENDER_PROFILE_REQUIRED_CODE}: renderVideoPrompt requires an explicit model profile; `
      + "default H3 grammar fallback is forbidden"
    );
  }
  if (profile.renderer === "h3-grammar") {
    return renderH3Prompt(ir);
  }
  return renderPlainPrompt(ir);
}
