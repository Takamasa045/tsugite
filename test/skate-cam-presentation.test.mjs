import { describe, expect, it } from "vitest";
import {
  resolveSkateCamPresentation
} from "../backends/remotion/skateCamPresentation.mjs";

const manifest = {
  meta: { target_duration_seconds: 10 },
  clips: [{ duration: 10 }],
  presentation: {
    rider_name: "シバスケ",
    afterimage_effects: [
      {
        id: "landing",
        asset_id: "landing-alpha",
        start: 1,
        end: 3,
        delays_frames: [3, 6]
      },
      {
        id: "invalid",
        start: 4,
        end: 4
      }
    ],
    rotoscope_effects: [
      {
        id: "jump-roto",
        kind: "jump",
        cream_asset_id: "jump-cream",
        red_asset_id: "jump-red",
        start: 1,
        end: 3,
        impact_time: 2.4
      },
      {
        id: "bad-roto",
        kind: "jump",
        cream_asset_id: "jump-cream",
        start: 1,
        end: 3,
        impact_time: 2.4
      }
    ],
    action_text_effects: [
      {
        id: "jump-label",
        kind: "jump",
        label: "POP!",
        start: 2,
        end: 3,
        x_percent: 35.2,
        y_percent: 20.8
      },
      {
        id: "empty-label",
        kind: "jump",
        label: "",
        start: 2,
        end: 3
      },
      {
        id: "bad-position",
        kind: "rail",
        label: "SLIDE!",
        start: 4,
        end: 5,
        x_percent: 120
      }
    ],
    doodle_effects: [
      {
        id: "jump-lines",
        kind: "jump",
        phase: "trick",
        start: 2,
        end: 4
      },
      {
        id: "bad-phase",
        kind: "jump",
        phase: "unknown",
        start: 4,
        end: 5
      },
      {
        id: "unknown-lines",
        kind: "unknown",
        start: 4,
        end: 5
      }
    ]
  }
};

describe("skate-cam presentation", () => {
  it("keeps only complete, time-bounded afterimage effects", () => {
    expect(resolveSkateCamPresentation(manifest).afterimageEffects.map((effect) => effect.id)).toEqual(["landing"]);
  });

  it("preserves the global timeline offset for selected-shot previews", () => {
    const previewManifest = {
      ...manifest,
      presentation: {
        ...manifest.presentation,
        timeline_offset_seconds: 1
      }
    };
    expect(resolveSkateCamPresentation(previewManifest).timelineOffsetSeconds).toBe(1);
  });

  it("keeps only complete rotoscope effects with a bounded impact time", () => {
    expect(resolveSkateCamPresentation(manifest).rotoscopeEffects.map((effect) => effect.id)).toEqual(["jump-roto"]);
  });

  it("keeps the rider name and only valid action text effects", () => {
    const presentation = resolveSkateCamPresentation(manifest);
    expect(presentation.riderName).toBe("シバスケ");
    expect(presentation.actionTextEffects.map((effect) => effect.id)).toEqual(["jump-label"]);
  });

  it("keeps only supported, time-bounded hand-drawn effects", () => {
    expect(resolveSkateCamPresentation(manifest).doodleEffects.map((effect) => effect.id)).toEqual(["jump-lines"]);
  });
});
