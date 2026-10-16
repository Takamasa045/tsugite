import { describe, expect, it, vi } from "vitest";
import { useCatalogReviewClock } from "./helpers/catalogReviewClock.js";
import { loadModelPromptProfile, loadConnectionCapabilityProfile, routeFromProfiles, createEffectiveGenerationContract } from "../src/videoPromptDirector/index.js";

describe("catalog fixture clock retains the real freshness boundary", () => {
  useCatalogReviewClock();
  it.each([-1, 0, 1])("checks review_after at offset %d milliseconds", async (offset) => {
    const model = await loadModelPromptProfile("v6"), connection = await loadConnectionCapabilityProfile("pixverse");
    expect(model.ok && connection.ok).toBe(true);
    if (!model.ok || !connection.ok) throw new Error("fixture profiles missing");
    const route = routeFromProfiles({ model: "v6", mode: "text-to-video", model_profile: model.profile,
      connection_profile: connection.profile, model_profile_digest: model.digest, connection_profile_digest: connection.digest });
    if (!route.ok) throw new Error("fixture route missing");
    vi.setSystemTime(new Date(Date.parse(model.profile.source.review_after!) + offset));
    const result = createEffectiveGenerationContract({ mode: "text-to-video", route: route.route,
      model_profile: model.profile, connection_profile: connection.profile, model_profile_digest: model.digest,
      connection_profile_digest: connection.digest });
    expect(result.ok).toBe(offset < 0);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("VPD-K001");
  });
});
