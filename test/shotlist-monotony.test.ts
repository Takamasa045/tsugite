import { describe, expect, it } from "vitest";
import {
  lintShotlistMonotony,
  monotonyFindingsToWarningMessages
} from "../src/orchestrator/shotlistMonotony.js";

describe("lintShotlistMonotony", () => {
  it("flags near-even durations", () => {
    const findings = lintShotlistMonotony([
      { start: 0, duration: 3, camera: "push" },
      { start: 3, duration: 3, camera: "pull" },
      { start: 6, duration: 3.1, camera: "static" },
      { start: 9.1, duration: 2.9, camera: "push" }
    ]);
    expect(findings.some((item) => item.code === "shotlist.duration_low_variance")).toBe(true);
  });

  it("flags the same camera three times in a row", () => {
    const findings = lintShotlistMonotony([
      { start: 0, duration: 1, camera: "push-in", role: "hook" },
      { start: 1, duration: 2, camera: "push-in" },
      { start: 3, duration: 4, camera: "push-in" },
      { start: 7, duration: 1, camera: "static" }
    ]);
    expect(findings.some((item) => item.code === "shotlist.camera_repeat")).toBe(true);
  });

  it("treats zoom/push family as the same camera system", () => {
    const findings = lintShotlistMonotony([
      { start: 0, duration: 1, camera: "zoom-in", role: "hook" },
      { start: 1, duration: 2, camera: "push" },
      { start: 3, duration: 2, camera: "dolly-in" },
      { start: 5, duration: 1, camera: "pan-left" }
    ]);
    expect(findings.some((item) => item.code === "shotlist.camera_repeat")).toBe(true);
  });

  it("flags three consecutive explicit static cameras (not unspecified)", () => {
    const findings = lintShotlistMonotony([
      { start: 0, duration: 1, camera: "static", role: "hook" },
      { start: 1, duration: 2, camera: "none" },
      { start: 3, duration: 3, camera: "fixed" },
      { start: 6, duration: 1, camera: "pan-left" }
    ]);
    expect(findings.some((item) => item.code === "shotlist.static_run")).toBe(true);

    const unspecified = lintShotlistMonotony([
      { start: 0, duration: 1, role: "hook" },
      { start: 1, duration: 2 },
      { start: 3, duration: 3 },
      { start: 6, duration: 1, camera: "pan-left" }
    ]);
    expect(unspecified.some((item) => item.code === "shotlist.static_run")).toBe(false);
  });

  it("flags missing early hook when first shot is long and unmarked", () => {
    const findings = lintShotlistMonotony([
      { start: 0, duration: 5, camera: "static", title: "長い導入" },
      { start: 5, duration: 2, camera: "push", title: "本題" },
      { start: 7, duration: 3, camera: "pull", title: "締め" }
    ]);
    expect(findings.some((item) => item.code === "shotlist.missing_early_hook")).toBe(true);
  });

  it("does not flag varied pacing with an early short shot", () => {
    const findings = lintShotlistMonotony([
      { start: 0, duration: 0.8, camera: "snap", role: "hook", title: "フック" },
      { start: 0.8, duration: 1.2, camera: "push" },
      { start: 2, duration: 4, camera: "static" },
      { start: 6, duration: 1.5, camera: "pull" }
    ]);
    expect(findings).toEqual([]);
  });

  it("formats warning messages for review", () => {
    const messages = monotonyFindingsToWarningMessages(
      lintShotlistMonotony([
        { start: 0, duration: 4, camera: "zoom", title: "A" },
        { start: 4, duration: 4, camera: "zoom", title: "B" },
        { start: 8, duration: 4, camera: "zoom", title: "C" }
      ])
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((message) => message.startsWith("[単調さ]"))).toBe(true);
  });
});
