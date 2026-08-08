/**
 * Deterministic contact-sheet layout from frames-manifest order only.
 * Timestamps are never recomputed when building the layout.
 */
import { sha256Canonical } from "../../integrity/canonical.js";
import type { ContactSheetLayoutV1, FramesManifestV1 } from "./schema.js";
import { CONTACT_SHEET_LAYOUT_SCHEMA_VERSION } from "./schema.js";
import { contactSheetCellLabel } from "./framePlan.js";

export const CONTACT_SHEET_LAYOUT_VERSION = "grid-v1" as const;

export type ContactSheetGenerator = {
  tool: string;
  version: string;
  argv: string[];
};

/**
 * Fixed ImageMagick-style montage argv (array only). Callers may mock the tool.
 */
export function buildFixedContactSheetArgv(options: {
  framePaths: readonly string[];
  outputPath: string;
  columns: number;
}): string[] {
  return [
    "montage",
    ...options.framePaths,
    "-tile",
    `${options.columns}x`,
    "-geometry",
    "+2+2",
    options.outputPath
  ];
}

/**
 * Build layout using frames manifest declaration order only.
 */
export function buildContactSheetLayout(options: {
  framesManifest: FramesManifestV1;
  columns: number;
  generator: ContactSheetGenerator;
  outputRelativePath: string;
  outputSha256: string;
  layoutVersion?: string;
}): ContactSheetLayoutV1 {
  const columns = Math.max(1, Math.floor(options.columns));
  const frameCount = options.framesManifest.frames.length;
  const rows = Math.max(1, Math.ceil(frameCount / columns));
  const cells = options.framesManifest.frames.map((frame, frame_index) => ({
    frame_index,
    order: frame_index,
    label: contactSheetCellLabel(frame)
  }));

  return {
    schema_version: CONTACT_SHEET_LAYOUT_SCHEMA_VERSION,
    layout_version: options.layoutVersion ?? CONTACT_SHEET_LAYOUT_VERSION,
    rows,
    columns,
    cells,
    frame_digests_in_order: options.framesManifest.frames.map((frame) => frame.sha256),
    generator: {
      tool: options.generator.tool,
      version: options.generator.version,
      argv: [...options.generator.argv]
    },
    output: {
      relative_path: options.outputRelativePath,
      sha256: options.outputSha256
    }
  };
}

export function computeContactSheetLayoutDigest(layout: ContactSheetLayoutV1): string {
  return sha256Canonical(layout);
}

export function computeFramesManifestDigest(manifest: FramesManifestV1): string {
  return sha256Canonical(manifest);
}

/**
 * P5 media evidence bundle digest (canonical key order).
 * Phase A/B person-consistency report digests stay on their own schema paths.
 */
export function computeMediaEvidenceBundleDigest(payload: {
  frames_manifest_digest: string;
  source_video_sha256: string;
  extractor: FramesManifestV1["extractor"];
  contact_sheet_sha256: string | null;
}): string {
  return sha256Canonical({
    contact_sheet_sha256: payload.contact_sheet_sha256,
    extractor: payload.extractor,
    frames_manifest_digest: payload.frames_manifest_digest,
    source_video_sha256: payload.source_video_sha256
  });
}
