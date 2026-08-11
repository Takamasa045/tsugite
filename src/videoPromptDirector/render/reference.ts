import { appendSubjectDefinitionLocks } from "../lockedBlocks.js";
import type { H3CreativeIr } from "../schema.js";
import {
  REFERENCE_SECTION_ORDER,
  buildLabels,
  joinSections,
  renderIntegratedDescription,
  renderMusicSection,
  renderSoundscapeSection,
  type H3RenderResult
} from "./shared.js";

/**
 * Full-reference H3 renderer.
 * Section order is fixed:
 * subject_definitions, summary, retention_analysis, detailed_description,
 * overall_soundscape, non_diegetic_music.
 */
export function renderH3ReferencePrompt(ir: H3CreativeIr): H3RenderResult {
  const labels = buildLabels(ir);
  // Numbered H3/adapter labels and subject_definitions are derived only from asset ids / input order.
  // Authors cannot supply manual full-section overrides with <Picture N> / @imageN.
  const sections = {
    subject_definitions: defaultSubjectDefinitions(ir, labels),
    summary: defaultSummary(ir),
    retention_analysis: defaultRetentionAnalysis(ir, labels),
    detailed_description: renderIntegratedDescription(ir),
    overall_soundscape: renderSoundscapeSection(ir),
    non_diegetic_music: renderMusicSection(ir)
  };

  return {
    format: "reference",
    sections,
    text: joinSections(REFERENCE_SECTION_ORDER, sections),
    labels
  };
}

function defaultSubjectDefinitions(
  ir: H3CreativeIr,
  labels: ReturnType<typeof buildLabels>
): string {
  const lines: string[] = [];
  for (const subject of ir.subjects) {
    const subjectLabel = labels.subjects[subject.id]?.h3 ?? subject.id;
    const assetLabel = subject.source_asset
      ? labels.assets[subject.source_asset]
      : undefined;
    if (assetLabel) {
      lines.push(
        appendSubjectDefinitionLocks(
          `${subjectLabel} is the ${subject.description} shown in ${assetLabel.h3} (${assetLabel.adapter}).`,
          subject
        )
      );
    } else {
      lines.push(
        appendSubjectDefinitionLocks(
          `${subjectLabel} is the ${subject.description}.`,
          subject
        )
      );
    }
    if (subject.voice?.source_asset) {
      const audio = labels.assets[subject.voice.source_asset];
      if (audio) {
        lines.push(
          `${audio.h3} is ${audio.adapter} and provides the voice timbre reference for ${subjectLabel}.`
        );
      }
    }
    if (subject.locked_blocks?.voice) {
      lines.push(`VOICE:\n${subject.locked_blocks.voice.text}`);
    }
  }

  for (const asset of ir.assets) {
    if (asset.role === "motion_reference") {
      const label = labels.assets[asset.id];
      if (label) {
        lines.push(
          `${label.h3} is ${label.adapter} and provides the target body movement and camera rhythm.`
        );
      }
    }
  }

  if (lines.length === 0) {
    for (const label of labels.orderedAssets) {
      lines.push(`${label.h3} is ${label.adapter}.`);
    }
  }
  return lines.join("\n");
}

function defaultSummary(ir: H3CreativeIr): string {
  if (ir.creative?.intent) return ir.creative.intent.trim();
  return `A ${ir.target.duration}-second ${ir.target.mode} sequence with ${ir.shots.length} shot(s).`;
}

function defaultRetentionAnalysis(
  ir: H3CreativeIr,
  labels: ReturnType<typeof buildLabels>
): string {
  const parts: string[] = [];
  for (const subject of ir.subjects) {
    const subjectLabel = labels.subjects[subject.id]?.h3 ?? subject.id;
    const retention = subject.preservation
      ? [
        subject.preservation.identity ? `identity=${subject.preservation.identity}` : undefined,
        subject.preservation.clothing ? `clothing=${subject.preservation.clothing}` : undefined,
        subject.preservation.hairstyle ? `hairstyle=${subject.preservation.hairstyle}` : undefined
      ].filter(Boolean).join(", ")
      : "identity and clothing remain consistent";
    parts.push(`Retain ${subjectLabel} (${retention}).`);
  }
  if (parts.length === 0) {
    parts.push("Retain referenced subject appearance, clothing, and spatial relationships across the clip.");
  }
  return parts.join(" ");
}
