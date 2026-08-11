/**
 * Resolve subject source assets across default source_asset and state variants.
 */

import type { H3Subject } from "./schema.js";

export type SubjectVariant = {
  id: string;
  source_asset: string;
};

/**
 * Resolve the image/reference asset id for a subject.
 * - variantId provided → that variants[].source_asset
 * - variantId omitted + variants → first variant (default)
 * - no variants → subject.source_asset
 */
export function resolveSubjectSourceAsset(
  subject: H3Subject,
  variantId?: string
): string | undefined {
  const variants = subject.variants ?? [];
  if (variants.length === 0) {
    return subject.source_asset;
  }
  if (variantId) {
    return variants.find((variant) => variant.id === variantId)?.source_asset;
  }
  return variants[0]?.source_asset ?? subject.source_asset;
}

export function isSubjectLocked(subject: H3Subject): boolean {
  return subject.locked === true;
}
