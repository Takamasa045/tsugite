import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertExactWorkdir,
  assertInsideWorkdir,
  assertTmpWorkdir,
  buildAddTitleJsx,
  buildInspectJsx,
  detectInstalls,
  finalizeCommand,
  jsxStringEscape,
  parseAeProcessList,
  parseArgs,
  readResultFile,
  runHelper,
  runningAsMain,
  sameFsPath,
  titleKeyPlan,
  verifyAddTitleIdentity,
  writeExclusive
} from "../.agents/skills/after-effects-editing/scripts/ae-local-helper.mjs";

function existsWithAe2026(path) {
  if (path.includes("Adobe After Effects") && path.endsWith(".app")) {
    return path.includes("2026");
  }
  return existsSync(path);
}

function mockExec({
  selected = "Adobe After Effects 2026",
  others = selected,
  result,
  exit = 0,
  stdout = '{"ok":true,"from":"stdout"}',
  error
} = {}) {
  return (_cmd, args) => {
    const blob = String(args);
    if (blob.includes("POSIX path of application file")) {
      if (!selected) {
        if (!others) return { status: 0, stdout: "", stderr: "" };
        const otherPath = others.includes("2024")
          ? "/Applications/Adobe After Effects 2024/Adobe After Effects 2024.app"
          : "";
        return { status: 0, stdout: `${others}\t${otherPath}`, stderr: "" };
      }
      return {
        status: 0,
        stdout: `${selected}\t/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app`,
        stderr: ""
      };
    }
    const match = blob.match(/POSIX file "([^"]+)"/);
    if (match && result) {
      const jsx = readFileSync(match[1], "utf8");
      const requestId = /var REQUEST_ID = "([^"]*)"/.exec(jsx)?.[1];
      const payload = typeof result === "function" ? result({ jsxPath: match[1], requestId }) : { request_id: requestId, ...result };
      writeFileSync(join(dirname(match[1]), "result.json"), JSON.stringify(payload));
    }
    return { status: exit, stdout, stderr: "ae-stderr", error };
  };
}

describe("after-effects local helper", () => {
  it("accepts allowlisted commands and rejects raw eval, retry, extra prefixes, and non-2026 apps", () => {
    expect(parseArgs(["probe", "--json"]).command).toBe("probe");
    expect(() => parseArgs(["eval"])).toThrow(/unsupported command/);
    expect(() => parseArgs(["inspect", "--eval", "app.quit()"])).toThrow(/not accepted/);
    expect(() => parseArgs(["inspect", "--retry"])).toThrow(/not allowed/);
    expect(() => parseArgs(["inspect", "--allowed-prefix", "/Users"])).toThrow(/not allowed/);
    expect(() => parseArgs(["inspect", "--app", "Adobe After Effects 2024"])).toThrow(/only Adobe After Effects 2026/);
    expect(() => parseArgs(["fixture"])).toThrow(/workdir/);
    expect(() => parseArgs(["add-title", "--expected-project", "/tmp/a.aep", "--output", "/tmp/b.aep"])).toThrow(
      /workdir/
    );
  });

  it("keeps fixture in /tmp isolation and add-title on an explicit workdir", () => {
    expect(assertTmpWorkdir("/tmp/tsugite-ae-fixture/demo")).toContain("tsugite-ae-fixture");
    expect(() => assertTmpWorkdir("/Users/takamasa/Documents/job")).toThrow(/tmp/);
    const work = mkdtempSync(join(tmpdir(), "ae-job-"));
    expect(assertExactWorkdir(work)).toBe(resolve(work));
    const expected = join(work, "source.aep");
    writeFileSync(expected, "aep");
    expect(assertInsideWorkdir(expected, work, { mustExist: true })).toBe(resolve(expected));
    expect(() => assertInsideWorkdir("/tmp/other.aep", work)).toThrow(/outside/);
  });

  it("rejects output that already exists or is a symlink", () => {
    const work = mkdtempSync(join(tmpdir(), "ae-job-"));
    const out = join(work, "out.aep");
    writeFileSync(out, "x");
    expect(() => assertInsideWorkdir(out, work, { mustNotExist: true })).toThrow(/exists/);
    const link = join(work, "link.aep");
    symlinkSync(out, link);
    expect(() => assertInsideWorkdir(link, work)).toThrow(/symlink/);
  });

  it("escapes control characters, quotes, and U+2028/U+2029 without deleting them", () => {
    const escaped = jsxStringEscape(`say "hi"\n\u2028\u2029\u0001`);
    expect(escaped).toContain('\\"');
    expect(escaped).toContain("\\n");
    expect(escaped).toContain("\\u2028");
    expect(escaped).toContain("\\u2029");
    expect(escaped).toContain("\\u0001");
    expect(escaped).not.toContain("\n");
  });

  it("builds add-title JSX against comp size/duration and TextDocument.value.text", () => {
    const jsx = buildAddTitleJsx(
      "/tmp/tsugite-ae-helper/req/result.json",
      "/job/source.aep",
      "/job/out.aep",
      "Main",
      "タイトル"
    );
    expect(jsx).toContain("doc.value.text");
    expect(jsx).toContain("expectedFile.fsName");
    expect(jsx).toContain("outputFile.exists");
    expect(jsx).toContain("dest.width / 2");
    expect(jsx).toContain("dest.height * 0.18");
    expect(jsx).toContain("dest.duration");
    expect(jsx).not.toContain("[960, 200]");
    expect(jsx).toContain("writeResult");
    expect(buildInspectJsx("/tmp/r.json")).toContain("writeResult(inspectJson())");
  });

  it("does not treat stdout JSON as a result payload", () => {
    const parsed = readResultFile(join(mkdtempSync(join(tmpdir(), "ae-res-")), "missing.json"));
    expect(parsed).toMatchObject({ ok: false, code: "result_missing", retry: false });
  });

  it("finalizeCommand keeps a failing exit even when parsed JSON says ok", () => {
    const finalized = finalizeCommand(
      { ok: true, op: "inspect" },
      { status: 1, stderr: "fail" },
      false,
      { connected: true }
    );
    expect(finalized.ok).toBe(false);
    expect(finalized.code).toBe("osascript_failed");
    expect(finalized.exit).toBe(1);
  });

  it("probe is never a live connection and fails when the selected app is missing", () => {
    const missing = runHelper(
      { ...parseArgs(["probe", "--json"]) },
      { exists: () => false, exec: mockExec({ selected: "", others: "" }) }
    );
    expect(missing.ok).toBe(false);
    expect(missing.connected).toBe(false);
    expect(missing.live_verified).toBe(false);
    const found = detectInstalls((path) => path.endsWith("Adobe After Effects 2026.app"));
    expect(found.find((item) => item.appName.includes("2026"))?.installed).toBe(true);
  });

  it("treats a process named After Effects as 2026 when its app path is the 2026 bundle", () => {
    const parsed = parseAeProcessList(
      "After Effects\t/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
    );
    expect(parsed.selectedRunning).toBe(true);
    expect(
      parseAeProcessList("After Effects\t/Applications/Adobe After Effects 2024/Adobe After Effects 2024.app")
        .selectedRunning
    ).toBe(false);
  });

  it("does not send DoScript to 2026 when only another AE process is running", () => {
    const result = runHelper(
      { ...parseArgs(["inspect", "--json"]) },
      {
        exists: existsWithAe2026,
        exec: mockExec({ selected: "", others: "Adobe After Effects 2024" })
      }
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("selected_ae_not_running");
  });

  it("treats osascript success without result.json as result_missing, ignoring stdout JSON", () => {
    const result = runHelper(
      { ...parseArgs(["inspect", "--json"]) },
      {
        exists: existsWithAe2026,
        exec: mockExec({ result: null, exit: 0, stdout: '{"ok":true,"op":"inspect"}' })
      }
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("result_missing");
    expect(result.hint).toMatch(/scripting file access|did not finish/);
    expect(result.stdout_ignored).toBe(true);
    expect(result.connected).toBe(false);
  });

  it("does not mark success when exit is non-zero even if result.json is ok", () => {
    const result = runHelper(
      { ...parseArgs(["inspect", "--json"]) },
      {
        exists: existsWithAe2026,
        exec: mockExec({
          result: { ok: true, op: "inspect", comps: [] },
          exit: 1
        })
      }
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("osascript_failed");
    expect(result.connected).toBe(false);
    expect(existsSync(result.jsx)).toBe(true);
  });

  it("reads AE-side failure codes from result.json for dirty, unrelated, and duplicate comps", () => {
    const cases = ["dirty_project", "unrelated_project", "comp_not_unique"];
    for (const code of cases) {
      const result = runHelper(
        { ...parseArgs(["inspect", "--json"]) },
        {
          exists: existsWithAe2026,
          exec: mockExec({ result: { ok: false, code }, exit: 0 })
        }
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe(code);
    }
  });

  it("keeps the request jsx after a successful inspect mock and does not use stdout", () => {
    const result = runHelper(
      { ...parseArgs(["inspect", "--json"]) },
      {
        exists: existsWithAe2026,
        exec: mockExec({
          result: { ok: true, op: "inspect", file: "", comps: [] },
          stdout: '{"ok":false}'
        })
      }
    );
    expect(result.ok).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.live_verified).toBe(false);
    expect(existsSync(result.jsx)).toBe(true);
    expect(readFileSync(result.jsx, "utf8")).toContain("writeResult");
  });

  it("runs add-title only inside the explicit workdir and refuses a pre-existing output", () => {
    const work = mkdtempSync(join(tmpdir(), "ae-job-"));
    const expected = join(work, "source.aep");
    const output = join(work, "titled.aep");
    writeFileSync(expected, "aep");
    writeFileSync(output, "old");
    const result = runHelper(
      parseArgs([
        "add-title",
        "--workdir",
        work,
        "--expected-project",
        expected,
        "--output",
        output,
        "--comp",
        "Main",
        "--title",
        "タイトル"
      ]),
      {
        exists: existsWithAe2026,
        exec: mockExec()
      }
    );
    expect(result.code).toBe("output_exists");
  });

  it("refuses to clobber an existing jsx path", () => {
    const root = mkdtempSync(join("/tmp", "tsugite-ae-"));
    const jsx = join(root, "locked.jsx");
    writeExclusive(jsx, "first");
    expect(() => writeExclusive(jsx, "second")).toThrow();
  });

  it("rejects / and the home directory as add-title --workdir but allows a project after-effects folder", () => {
    expect(() => assertExactWorkdir("/")).toThrow(/after-effects folder/);
    expect(() => assertExactWorkdir(homedir())).toThrow(/after-effects folder/);
    const root = mkdtempSync(join(tmpdir(), "ae-job-"));
    const work = join(root, "after-effects");
    mkdirSync(work);
    expect(assertExactWorkdir(work)).toBe(resolve(work));
  });

  it("accepts AE 3D position arrays and Japanese title text in identity readback", () => {
    const dest = { name: "tsugite-ae-fixture", width: 1920, height: 1080, duration: 5 };
    const plan = titleKeyPlan(dest);
    const parsed = {
      request_id: "req-live",
      file: "/tmp/tsugite-ae-live/titled.aep",
      saved: "/private/tmp/tsugite-ae-live/titled.aep",
      comps: [
        {
          ...dest,
          layers: [
            {
              name: "tsugite-title",
              text: "継手のテスト",
              position_keys: plan.position.map((key) => ({ time: key.time, value: [...key.value, 0] })),
              opacity_keys: plan.opacity
            }
          ]
        }
      ]
    };
    expect(
      verifyAddTitleIdentity(parsed, {
        outputPath: "/tmp/tsugite-ae-live/titled.aep",
        requestId: "req-live",
        comp: "tsugite-ae-fixture",
        title: "継手のテスト"
      }).ok
    ).toBe(true);
  });

  it("treats /tmp and /private/tmp as the same filesystem path", () => {
    expect(sameFsPath("/tmp/tsugite-ae-fixture/a.aep", "/private/tmp/tsugite-ae-fixture/a.aep")).toBe(true);
    expect(sameFsPath("/tmp/tsugite-ae-fixture/a.aep", "/tmp/tsugite-ae-other/a.aep")).toBe(false);
  });

  it("does not succeed after timeout even if result.json appears late", () => {
    const result = runHelper(
      { ...parseArgs(["inspect", "--json"]) },
      {
        exists: existsWithAe2026,
        exec: mockExec({
          result: { ok: true, op: "inspect", comps: [] },
          error: { code: "ETIMEDOUT" }
        })
      }
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("timeout");
    expect(result.retry).toBe(false);
    expect(result.connected).toBe(false);
  });

  it("fails fixture when the aep was not created", () => {
    const work = mkdtempSync(join("/tmp", "tsugite-ae-"));
    const aep = join(work, "tsugite-ae-fixture.aep");
    const result = runHelper(
      parseArgs(["fixture", "--workdir", work, "--json"]),
      {
        exists: existsWithAe2026,
        exec: mockExec({
          result: ({ requestId }) => ({
            ok: true,
            request_id: requestId,
            file: aep,
            saved: aep,
            comps: [{ name: "tsugite-ae-fixture", layers: [{ name: "layer" }] }]
          })
        })
      }
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("aep_missing");
  });

  it("accepts add-title only when result.json matches output, title layer, and keys", () => {
    const root = mkdtempSync(join(tmpdir(), "ae-job-"));
    const work = join(root, "after-effects");
    mkdirSync(work);
    const expected = join(work, "source.aep");
    const output = join(work, "titled.aep");
    writeFileSync(expected, "aep");
    const dest = { name: "Main", width: 1920, height: 1080, duration: 5 };
    const plan = titleKeyPlan(dest);
    const result = runHelper(
      parseArgs([
        "add-title",
        "--workdir",
        work,
        "--expected-project",
        join(work, "./source.aep"),
        "--output",
        output,
        "--comp",
        "Main",
        "--title",
        "タイトル"
      ]),
      {
        exists: existsWithAe2026,
        exec: mockExec({
          result: ({ requestId }) => {
            writeFileSync(output, "aep");
            return {
              ok: true,
              request_id: requestId,
              file: output,
              saved: output,
              comps: [
                {
                  ...dest,
                  layers: [
                    {
                      name: "tsugite-title",
                      text: "タイトル",
                      position_keys: plan.position,
                      opacity_keys: plan.opacity
                    }
                  ]
                }
              ]
            };
          }
        })
      }
    );
    expect(result.ok).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.live_verified).toBe(false);
  });

  it("rejects add-title when comps are empty or the file does not match output", () => {
    const root = mkdtempSync(join(tmpdir(), "ae-job-"));
    const work = join(root, "after-effects");
    mkdirSync(work);
    const expected = join(work, "source.aep");
    const output = join(work, "titled.aep");
    writeFileSync(expected, "aep");
    const result = runHelper(
      parseArgs([
        "add-title",
        "--workdir",
        work,
        "--expected-project",
        expected,
        "--output",
        output,
        "--comp",
        "Main",
        "--title",
        "タイトル"
      ]),
      {
        exists: existsWithAe2026,
        exec: mockExec({
          result: ({ requestId }) => {
            writeFileSync(output, "aep");
            return { ok: true, request_id: requestId, file: output, saved: output, comps: [] };
          }
        })
      }
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("identity_mismatch");
  });

  it("runningAsMain uses fileURLToPath and does not throw on encoded paths", () => {
    const encoded = new URL("file:///Users/takamasa/Projects/%2A%E9%96%8B%E7%99%BA/helper.mjs");
    expect(runningAsMain("/tmp/other.mjs", encoded)).toBe(false);
    const local = pathToFileURL(resolve(".agents/skills/after-effects-editing/scripts/ae-local-helper.mjs")).href;
    expect(typeof runningAsMain(undefined, local)).toBe("boolean");
  });
});
