import { afterEach, beforeEach, vi } from "vitest";

/**
 * knowledge/video-models/minimax-h3/prompt-guide.yaml uses review_after: 2026-09-07.
 * Pin wall-clock Date only (not setTimeout) to a UTC instant before that catalog
 * deadline so fixture contracts stay fresh. Freshness comparison itself is unchanged.
 */
export const CATALOG_REVIEW_CLOCK = "2026-09-01T00:00:00.000Z";

export function pinCatalogReviewClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CATALOG_REVIEW_CLOCK));
}

export function restoreCatalogReviewClock(): void {
  vi.useRealTimers();
}

export function useCatalogReviewClock(): void {
  beforeEach(() => {
    pinCatalogReviewClock();
  });
  afterEach(() => {
    restoreCatalogReviewClock();
  });
}
