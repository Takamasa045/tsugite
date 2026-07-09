import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { audioTrackTiming } from "../backends/remotion/timing.mjs";

describe("remotion backend helpers", () => {
  it("places audio tracks on the timeline and honors end timing", () => {
    const manifest = {
      meta: { target_duration_seconds: 3 },
      clips: [{ duration: 3 }]
    };

    expect(audioTrackTiming({ start: 1, end: 2 }, manifest, 30)).toEqual({
      from: 30,
      durationInFrames: 30
    });
    expect(audioTrackTiming({}, manifest, 30)).toEqual({
      from: 0,
      durationInFrames: 90
    });
  });

  it("rejects backend payload paths outside the run directory contract", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tsugite-remotion-payload-"));
    const script = resolve("backends/remotion/render.mjs");
    const result = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      input: JSON.stringify({
        runDir,
        manifestPath: join(runDir, "manifest.json"),
        outputPath: join(runDir, "..", "escaped.mp4"),
        reportPath: join(runDir, "render-report.json")
      }),
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outputPath must equal");
  });
});
