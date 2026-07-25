/** Character gallery scan / aggregate types (Phase 1). */

export type CharacterPoseRef = {
  name: string;
  imageId: string;
  /** Portable path relative to the source rootDir (`/`), when resolved. */
  imagePath?: string;
  missing: boolean;
};

/** Speaker-level provenance (passthrough of manifest speaker `source`). */
export type CharacterProvenance = {
  kind: string;
  character?: string;
  run_id?: string;
  [key: string]: unknown;
};

export type CharacterSourceRef = {
  /** Deterministic identity for a concrete speaker occurrence. */
  sourceKey: string;
  kind: "project" | "template";
  label: string;
  /** Absolute path with portable `/` separators. */
  manifestPath: string;
  /** Absolute asset/containment root with portable `/` separators (parent when soft-contained). */
  rootDir: string;
  id: string;
  displayName: string;
  side: "left" | "right";
  accent: string;
  poses: CharacterPoseRef[];
  mouthFrames?: CharacterPoseRef[];
  provenance?: CharacterProvenance;
  manifestModifiedAtMs: number;
};

export type AggregatedCharacter = {
  groupKey: string;
  id: string;
  displayName: string;
  sources: CharacterSourceRef[];
  poseCount: number;
  hasMouthFrames: boolean;
  provenance?: CharacterProvenance;
};

export type ScanWarning = {
  code: string;
  message: string;
  path?: string;
};

export type ScanResult = {
  sources: CharacterSourceRef[];
  warnings: ScanWarning[];
};

export type ScanCharacterSourcesOptions = {
  /** Shelf directories that each contain project folders with `project.yaml`. */
  projectDirectories: string[];
  /** Optional templates root (`templates/`); scanned as read-only. */
  templatesDir?: string;
};
