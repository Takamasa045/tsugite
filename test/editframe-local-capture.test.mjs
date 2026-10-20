import { it, expect } from "vitest";
import { assertLocalCaptureUrl } from "../backends/editframe/renderLocal.mjs";
import { inspectCliArgs } from "../backends/editframe/cli.mjs";
import { childEnv } from "../backends/editframe/processGroup.mjs";
import { renderTimeoutMs } from "../backends/editframe/renderTimeout.mjs";

it("confines local SDK capture requests to loopback without credentials", () => {
  for (const input of ["https://example.com/", "http://127.0.0.1.example.com/", "file:///tmp/private", "http://user:password@127.0.0.1/"]) {
    expect(() => assertLocalCaptureUrl(input)).toThrow();
  }
  expect(assertLocalCaptureUrl("http://127.0.0.1:1234/index.html")).toBe("http://127.0.0.1:1234/index.html");
});

it("rejects new hosted selectors before forwarding any allowed CLI command", () => {
  for (const flags of [["--endpoint", "https://example.com/v2/agent"], ["--endpoint=https://example.com/v2/agent"], ["--project-id", "hosted"], ["--input", "request.json"]]) {
    expect(inspectCliArgs(["render", ...flags]).ok).toBe(false);
  }
  expect(childEnv({ EDITFRAME_TOKEN: "fixture-secret", PATH: "/bin" }).EDITFRAME_TOKEN).toBeUndefined();
});

it("scales the serial local capture timeout with frame count and caps it", () => {
  expect(renderTimeoutMs({ meta: { fps: 30, target_duration_seconds: 2 } })).toBe(90_000);
  expect(renderTimeoutMs({ meta: { fps: 30, target_duration_seconds: 60 } })).toBe(60_000 + 1800 * 400);
  expect(renderTimeoutMs({ meta: { fps: 60, target_duration_seconds: 3600 } })).toBe(30 * 60_000);
  expect(renderTimeoutMs({ meta: { fps: 30 } })).toBe(90_000);
});
