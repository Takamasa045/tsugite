import type { H3CreativeIr } from "../schema.js";
import {
  BASE_SECTION_ORDER,
  buildLabels,
  joinSections,
  renderFirstFrameAlignment,
  renderIntegratedDescription,
  renderMusicSection,
  renderSoundscapeSection,
  type H3RenderResult
} from "./shared.js";

/**
 * Base H3 renderer for text-to-video, first-frame, first-last, and last-frame.
 * Section order is fixed: integrated_multimodal_description, overall_soundscape, non_diegetic_music.
 */
export function renderH3BasePrompt(ir: H3CreativeIr): H3RenderResult {
  const labels = buildLabels(ir);
  const alignment = renderFirstFrameAlignment(ir, labels);
  const integrated = renderIntegratedDescription(ir);
  const description = alignment ? `${alignment}\n\n${integrated}` : integrated;

  const sections = {
    integrated_multimodal_description: description,
    overall_soundscape: renderSoundscapeSection(ir),
    non_diegetic_music: renderMusicSection(ir)
  };

  return {
    format: "base",
    sections,
    text: joinSections(BASE_SECTION_ORDER, sections),
    labels
  };
}
