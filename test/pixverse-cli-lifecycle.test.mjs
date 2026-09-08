import { describe, expect, it, vi } from "vitest";
const { sync } = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("cross-spawn", () => ({ default: { sync } }));
import { runPixverseMedia, findTaskIds, buildPixverseGlobalArgs } from "../adapters/pixverse/pixverseCli.mjs";

describe("PixVerse CLI media lifecycle", () => {
  it.each(["image", "audio", "video"])("recognizes %s IDs and excludes trace and unrelated metadata", (type) => {
    expect(findTaskIds({ results: [{ [`${type}_id`]: 123, id: "wrong" }, { [`${type}_id`]: 456 }], metadata: { id: "wrong" } })).toEqual(["123", "456"]);
    expect(findTaskIds({ [`${type}_ids`]: [123, 456, 123] })).toEqual(["123", "456"]);
    expect(findTaskIds({ trace_id: "wrong" })).toEqual([]);
  });

  it.each(["image", "voice", "music"])("downloads every %s result in the explicitly selected personal workspace", (operation) => {
    sync.mockReset();
    const type = operation === "image" ? "image" : "audio";
    sync.mockImplementation((executable, args) => {
      let output;
      if (args[0] === "create") output = { results: [{ [`${type}_id`]: 101 }, { [`${type}_id`]: 102 }] };
      else if (args[0] === "task") output = { status: "completed", cost_credits: 3 };
      else if (args[0] === "asset") output = {};
      else if (args[0] === "-e") output = [args[2] + (type === "image" ? "/image.png" : "/audio.mp3")];
      else throw new Error(`Unexpected command: ${executable}`);
      return { status: 0, stdout: JSON.stringify(output), stderr: "" };
    });
    const result = runPixverseMedia({ run_id: "test", run_dir: "/tmp/pixverse-lifecycle", request: { id: "media", operation, prompt: "test", params: { workspace_id: 0 } } });
    expect(result.metadata.task_ids).toEqual(["101", "102"]);
    expect(result.credits).toBe(6);
    expect(type === "image" ? result.images : result.audio).toHaveLength(2);
    const commands = sync.mock.calls.filter(([, args]) => args[0] !== "-e").map(([, args]) => args);
    expect(commands.map((args) => args.slice(0, 3))).toEqual([
      ["create", operation, operation === "voice" ? "--text" : "--prompt"],
      ["task", "wait", "101"], ["asset", "download", "101"],
      ["task", "wait", "102"], ["asset", "download", "102"]
    ]);
    for (const args of commands) expect(args.slice(-2)).toEqual(["--workspace-id", "0"]);
  });

  it("validates explicit globals without selecting a default workspace", () => {
    expect(buildPixverseGlobalArgs({})).toEqual([]);
    expect(() => buildPixverseGlobalArgs({ params: { workspace_id: -1 } })).toThrow(/workspace_id/);
    expect(() => buildPixverseGlobalArgs({ params: { trace_id: "bad" } })).toThrow(/UUIDv4/);
    const trace = "12345678-1234-4123-8123-123456789abc";
    expect(buildPixverseGlobalArgs({ params: { trace_id: trace } })).toEqual(["--trace-id", trace]);
  });
});
