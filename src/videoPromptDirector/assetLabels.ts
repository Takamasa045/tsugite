import type { H3Asset, H3CreativeIr, H3Subject } from "./schema.js";

export type H3AssetLabel = {
  assetId: string;
  type: H3Asset["type"];
  h3: string;
  /** Adapter/media-ref dialect (`@imageN` / `@videoN` / `@audioN`). */
  adapter: string;
  index: number;
};

export type H3SubjectLabel = {
  subjectId: string;
  h3: string;
  index: number;
};

export type H3LabelMap = {
  assets: Record<string, H3AssetLabel>;
  subjects: Record<string, H3SubjectLabel>;
  byType: {
    image: H3AssetLabel[];
    video: H3AssetLabel[];
    audio: H3AssetLabel[];
  };
  orderedAssets: H3AssetLabel[];
  orderedSubjects: H3SubjectLabel[];
};

/**
 * Deterministic type-specific numbering. Callers never supply Picture/Video/Audio indices.
 * Image assets become <Picture N> / @imageN in declaration order (within type).
 * Video assets become <Video N> / @videoN; audio becomes <Audio N> / @audioN.
 * Subjects become <Subject N> in declaration order.
 */
export function mapH3AssetLabels(ir: Pick<H3CreativeIr, "assets" | "subjects">): H3LabelMap {
  const counters = { image: 0, video: 0, audio: 0 };
  const byType: H3LabelMap["byType"] = { image: [], video: [], audio: [] };
  const assets: Record<string, H3AssetLabel> = {};
  const orderedAssets: H3AssetLabel[] = [];

  for (const asset of ir.assets) {
    counters[asset.type] += 1;
    const index = counters[asset.type];
    const label = labelForAsset(asset, index);
    assets[asset.id] = label;
    byType[asset.type].push(label);
    orderedAssets.push(label);
  }

  const subjects: Record<string, H3SubjectLabel> = {};
  const orderedSubjects: H3SubjectLabel[] = [];
  for (const [index, subject] of ir.subjects.entries()) {
    const label = labelForSubject(subject, index + 1);
    subjects[subject.id] = label;
    orderedSubjects.push(label);
  }

  return { assets, subjects, byType, orderedAssets, orderedSubjects };
}

function labelForAsset(asset: H3Asset, index: number): H3AssetLabel {
  if (asset.type === "image") {
    return {
      assetId: asset.id,
      type: "image",
      index,
      h3: `<Picture ${index}>`,
      adapter: `@image${index}`
    };
  }
  if (asset.type === "video") {
    return {
      assetId: asset.id,
      type: "video",
      index,
      h3: `<Video ${index}>`,
      adapter: `@video${index}`
    };
  }
  return {
    assetId: asset.id,
    type: "audio",
    index,
    h3: `<Audio ${index}>`,
    adapter: `@audio${index}`
  };
}

function labelForSubject(subject: H3Subject, index: number): H3SubjectLabel {
  return {
    subjectId: subject.id,
    index,
    h3: `<Subject ${index}>`
  };
}

export function h3LabelForAsset(ir: Pick<H3CreativeIr, "assets" | "subjects">, assetId: string): string | undefined {
  return mapH3AssetLabels(ir).assets[assetId]?.h3;
}

export function adapterLabelForAsset(
  ir: Pick<H3CreativeIr, "assets" | "subjects">,
  assetId: string
): string | undefined {
  return mapH3AssetLabels(ir).assets[assetId]?.adapter;
}
