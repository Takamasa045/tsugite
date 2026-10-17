import { afterEach, beforeEach, vi } from "vitest";
import { CATALOG_REVIEW_CLOCK } from "./catalogReviewInstant.mjs";

/**
 * knowledge/video-models/minimax-h3/prompt-guide.yaml uses review_after: 2026-09-07.
 * PixVerse V6 / C1 and Kling 3.0 profiles use 2026-10-10. Pin wall-clock Date only
 * (not setTimeout) to a UTC instant before those catalog deadlines so fixture
 * contracts stay fresh. Freshness comparison itself is unchanged.
 */
export { CATALOG_REVIEW_CLOCK };

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

export function catalogReviewClockPreloadHref(): string {
  return new URL("./catalogReviewClockPreload.mjs", import.meta.url).href;
}
