/**
 * H3-only grammar surface (Picture / FL2VA / L2VA / section layout).
 * Non-H3 renderers must not import this module.
 * Public H3 API continues to re-export via render/index and h3Compat.
 */

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

import type { H3CreativeIr } from "../schema.js";
import { renderH3BasePrompt } from "./base.js";
import { renderH3ReferencePrompt } from "./reference.js";
import type { H3RenderResult } from "./shared.js";

/** Deterministic H3 prompt renderer. Mode selects base vs reference section layout. */
export function renderH3Prompt(ir: H3CreativeIr): H3RenderResult {
  if (ir.target.mode === "reference") {
    return renderH3ReferencePrompt(ir);
  }
  return renderH3BasePrompt(ir);
}
