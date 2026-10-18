import { describe, expect, it } from "vitest";
import {
  KOBO_LAUNCH_PRESET,
  KOBO_SCENES,
  koboDesignFrame,
  resolveKoboCopy,
  shapePoints
} from "../backends/remotion/koboLaunch.js";

describe("kobo launch preset", () => {
  it("covers a contiguous 30-second timeline in 30 fps design frames", () => {
    expect(KOBO_LAUNCH_PRESET).toBe("kobo-launch-16x9");
    expect(KOBO_SCENES[0].start).toBe(0);
    expect(KOBO_SCENES.at(-1).end).toBe(900);
    for (let i = 1; i < KOBO_SCENES.length; i += 1) {
      expect(KOBO_SCENES[i].start).toBe(KOBO_SCENES[i - 1].end);
    }
    // Every cut lands on a 120 BPM beat (15 design frames).
    for (const scene of KOBO_SCENES) expect(scene.start % 15).toBe(0);
  });

  it("maps review-preview frames through the shot offset", () => {
    expect(koboDesignFrame(0, 30, undefined)).toBe(0);
    expect(koboDesignFrame(12, 12, { timeline_offset_seconds: 25 })).toBe(780);
    expect(koboDesignFrame(30, 30, { timeline_offset_seconds: "bad" })).toBe(30);
  });

  it("accepts typed copy overrides and clamps the seat counts", () => {
    expect(resolveKoboCopy(undefined)).toMatchObject({ price: "2,480", seats_total: 30, seats_taken: 20 });
    const copy = resolveKoboCopy({ price: "1,980", deadline: 105, seats_total: 99, seats_taken: 120 });
    expect(copy.price).toBe("1,980");
    expect(copy.deadline).toBe("10.5");
    expect(copy.seats_total).toBe(48);
    expect(copy.seats_taken).toBe(48);
  });

  it("morphs circle, square, and triangle with one shared point count", () => {
    const circle = shapePoints({ kind: "circle", R: 100, cx: 0, cy: 0 });
    const square = shapePoints({ kind: "square", R: 100, cx: 0, cy: 0 });
    const triangle = shapePoints({ kind: "triangle", R: 100, cx: 0, cy: 0 });
    expect(circle).toHaveLength(96);
    expect(square).toHaveLength(96);
    expect(triangle).toHaveLength(96);
    for (const [x, y] of circle) expect(Math.hypot(x, y)).toBeCloseTo(100, 6);
    // The first sample points straight up, so the triangle apex is exact.
    expect(triangle[0][0]).toBeCloseTo(0, 6);
    expect(triangle[0][1]).toBeCloseTo(-124, 6);
    expect(Math.max(...square.map(([x]) => x))).toBeCloseTo(84, 6);
    const halfway = shapePoints({ kind: "square", to: "circle", t: 0.5, R: 100, cx: 0, cy: 0 });
    expect(Math.hypot(...halfway[12])).toBeCloseTo((Math.hypot(...square[12]) + 100) / 2, 6);
  });
});
