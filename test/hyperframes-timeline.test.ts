import { describe, expect, it } from "vitest";
// @ts-expect-error backend modules are plain ESM without type declarations
import { buildTimelineProgram, sampleTween } from "../backends/hyperframes/timeline.mjs";

type Caption = { id: string; start: number; end: number; speaker?: string; visual?: Record<string, unknown> };

function captions(): Caption[] {
  return [
    { id: "s01", start: 0, end: 4, speaker: "neru", visual: { headline: "A", detail: "d" } },
    { id: "s02", start: 4, end: 10, speaker: "shiba", visual: { headline: "B", steps: ["one", "two", "three"] } },
    { id: "s03", start: 10, end: 12, speaker: "neru" }
  ];
}

describe("timeline sampling", () => {
  const tween = { selector: "#a", at: 2, duration: 0.5, from: { opacity: 0, y: 24 }, to: { opacity: 1, y: 0 } };

  it("holds the from-state before the tween starts", () => {
    expect(sampleTween(tween, 0)).toEqual({ opacity: 0, y: 24 });
    expect(sampleTween(tween, 1.99)).toEqual({ opacity: 0, y: 24 });
  });

  it("holds the to-state after the tween ends, so seeking backwards is still correct", () => {
    expect(sampleTween(tween, 2.5)).toEqual({ opacity: 1, y: 0 });
    expect(sampleTween(tween, 99)).toEqual({ opacity: 1, y: 0 });
  });

  it("interpolates in between with an eased curve that starts fast and settles", () => {
    const mid = sampleTween(tween, 2.25) as { opacity: number; y: number };
    expect(mid.opacity).toBeGreaterThan(0.5);
    expect(mid.opacity).toBeLessThan(1);
    expect(mid.y).toBeLessThan(12);
    expect(mid.y).toBeGreaterThan(0);
  });

  it("is deterministic: the same time always yields the same values", () => {
    expect(sampleTween(tween, 2.3)).toEqual(sampleTween(tween, 2.3));
  });
});

describe("timeline program", () => {
  it("gives every visual card an entrance anchored to its own line", () => {
    const program = buildTimelineProgram({ captions: captions(), speakers: [] });
    const card = program.find((t: { selector: string }) => t.selector === "#s01-visual");

    expect(card).toBeDefined();
    expect(card.at).toBe(0);
    expect(card.from.opacity).toBe(0);
    expect(card.to.opacity).toBe(1);
  });

  it("staggers steps so a list reveals one line at a time", () => {
    const program = buildTimelineProgram({ captions: captions(), speakers: [] });
    const steps = program
      .filter((t: { selector: string }) => t.selector.startsWith("#s02-visual [data-step-index="))
      .sort((a: { at: number }, b: { at: number }) => a.at - b.at);

    expect(steps).toHaveLength(3);
    expect(steps[0].at).toBeGreaterThanOrEqual(4);
    expect(steps[1].at).toBeGreaterThan(steps[0].at);
    expect(steps[2].at).toBeGreaterThan(steps[1].at);
    // All reveals must land inside the line they belong to.
    expect(steps[2].at + steps[2].duration).toBeLessThanOrEqual(10);
  });

  it("lifts whoever is speaking so the exchange reads as a conversation", () => {
    const program = buildTimelineProgram({
      captions: captions(),
      speakers: [{ id: "shiba" }, { id: "neru" }]
    });
    const lift = program.find(
      (t: { selector: string; at: number }) => t.selector === '#s02-cast [data-speaker="shiba"]' && t.at === 4
    );

    expect(lift).toBeDefined();
    expect(lift.to.y).toBe(0);
    expect(lift.from.y).toBeGreaterThan(0);
  });

  it("skips captions that carry no visual so a bare line does not animate an empty card", () => {
    const program = buildTimelineProgram({ captions: captions(), speakers: [] });
    expect(program.some((t: { selector: string }) => t.selector === "#s03-visual")).toBe(false);
  });
});
