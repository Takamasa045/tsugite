import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hypitMissingMessage } from "../adapters/hypit/runtimeAdapter.mjs";
import {
  HYPIT_MIN_NODE_VERSION,
  LOCAL_RUNTIME_TIMEOUT_MS,
  LOCAL_STARTER_ENDPOINT_NAMES,
  PRODUCTION_WORKSPACE_NAME,
  inspectTrustedLocalStarterEndpoints,
  isHypitSupportedNodeVersion,
  localRuntimeInitArgv,
  localRuntimeUpArgv,
  prepareLocalRuntime
} from "../adapters/hypit/runtimeSetup.mjs";
import { writePinnedRuntimeFixture } from "./helpers/hypitPinnedRuntimeFixture.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const OFFICIAL_STARTER = {
  format: "hypit.runtime-local@1",
  dataRoot: ".hypit/runtimes/local",
  credentials: {
    os: { use: "@hypit/credential-store-os" }
  },
  endpoints: {
    "hypihub.default": {
      use: "@hypit/provider-hypihub",
      config: {
        baseUrl: "https://hypit.ai",
        apiKey: { store: "os", key: "hypihub.oauth" }
      }
    },
    "media.local": { use: "@hypit/provider-media-local" },
    "hyperframes.local": { use: "@hypit/provider-hyperframes-local" }
  }
};

function tempWorkspace(label = "runtime-setup") {
  const root = mkdtempSync(join(tmpdir(), `tsugite-${label}-`));
  roots.push(root);
  return root;
}

function writePointer(workspace, profile = OFFICIAL_STARTER) {
  mkdirSync(join(workspace, ".hypit"), { recursive: true });
  writeFileSync(join(workspace, ".hypit", "runtime"), "hypit.runtime.json\n");
  writeFileSync(join(workspace, "hypit.runtime.json"), `${JSON.stringify(profile, null, 2)}\n`);
}

function tempProduction() {
  const productionRoot = tempWorkspace("prod");
  const workspace = join(productionRoot, PRODUCTION_WORKSPACE_NAME);
  mkdirSync(workspace);
  return { productionRoot, workspace };
}

function fixtureAdapter() {
  const adapterRoot = tempWorkspace("adapter-pin");
  writePinnedRuntimeFixture(adapterRoot);
  return adapterRoot;
}

function prepare(options) {
  const adapterRoot = Object.hasOwn(options, "adapterRoot")
    ? options.adapterRoot
    : fixtureAdapter();
  return prepareLocalRuntime({ ...options, adapterRoot });
}

function upJson(overrides = {}) {
  return JSON.stringify({
    format: "hypit.cli-runtime-up@1",
    ready: true,
    worker: "running",
    preparedPackages: 1,
    programs: { total: 2, ready: 2, items: [] },
    ...overrides
  });
}

describe("prepareLocalRuntime argv contract", () => {
  it("pins official local endpoint names and never omits --endpoint", () => {
    expect(LOCAL_STARTER_ENDPOINT_NAMES).toEqual(["media.local", "hyperframes.local"]);
    const argv = localRuntimeUpArgv("/tmp/ws");
    expect(argv).toEqual([
      "runtime", "up", "--workspace", "/tmp/ws",
      "--endpoint", "media.local", "--endpoint", "hyperframes.local",
      "--json", "--no-color"
    ]);
    expect(argv).not.toContain("hypihub.default");
    expect(argv.filter((item) => item === "--endpoint")).toHaveLength(2);
    expect(localRuntimeInitArgv("/tmp/ws")).toEqual([
      "runtime", "init", "--workspace", "/tmp/ws", "--json", "--no-color"
    ]);
    expect(LOCAL_RUNTIME_TIMEOUT_MS).toBe(1_200_000);
    expect(PRODUCTION_WORKSPACE_NAME).toBe("hypit-workspace");
  });
});

describe("prepareLocalRuntime trust and isolation", () => {
  it("discovers no-profile via native runtime init then local-only up (standalone host state)", () => {
    const workspace = tempWorkspace("fresh");
    const calls = [];
    const result = prepare({
      workspace,
      spawnCli: (argv, options) => {
        calls.push({ argv, options });
        if (argv[1] === "init") {
          writePointer(workspace);
          return {
            status: 0,
            stdout: JSON.stringify({
              format: "hypit.cli-runtime-init@1",
              profile: join(workspace, "hypit.runtime.json"),
              project: workspace,
              selected: true
            }),
            stderr: ""
          };
        }
        return { status: 0, stdout: upJson(), stderr: "" };
      }
    });
    const realWorkspace = realpathSync(workspace);
    expect(calls).toHaveLength(2);
    expect(calls[0].argv).toEqual(localRuntimeInitArgv(realWorkspace));
    expect(calls[1].argv).toEqual(localRuntimeUpArgv(realWorkspace));
    expect(calls[1].argv).not.toContain("hypihub.default");
    expect(calls[0].options.childEnv.HYPIT_STATE_HOME).toBe(join(realWorkspace, ".tsugite", "hypit-host-state"));
    expect(calls[0].options.childEnv.HOME).toBe(join(realWorkspace, ".tsugite", "hypit-host-state", "home"));
    expect(calls[0].options.timeoutMs).toBe(LOCAL_RUNTIME_TIMEOUT_MS);
    expect(calls[0].options.cwd).toBe(realWorkspace);
    expect(result.ok).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.init_ran).toBe(true);
    expect(result.up_ran).toBe(true);
    expect(result.trusted_local).toBe(true);
    expect(result.up.ready).toBe(true);
    expect(result.up.worker).toBe("running");
    expect(result.pinned_runtime.package).toBe("@hypit/hypit");
    expect(result.pinned_runtime.version).toBe("0.1.8");
    expect(result.host_state_mode).toBe("standalone-workspace");
    expect(result.production_root).toBeNull();
  });

  it("skips init for an existing trusted pointer and does not rewrite hypihub", () => {
    const workspace = tempWorkspace("existing");
    writePointer(workspace);
    const before = readFileSync(join(workspace, "hypit.runtime.json"));
    const calls = [];
    const result = prepare({
      workspace,
      spawnCli: (argv) => {
        calls.push(argv);
        return { status: 0, stdout: upJson(), stderr: "" };
      }
    });
    expect(calls).toEqual([localRuntimeUpArgv(realpathSync(workspace))]);
    expect(result.init_ran).toBe(false);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "hypit.runtime.json")).equals(before)).toBe(true);
    expect(JSON.parse(before).endpoints["hypihub.default"].use).toBe("@hypit/provider-hypihub");
  });

  it("is idempotent: a second trusted call still skips init", () => {
    const workspace = tempWorkspace("idempotent");
    writePointer(workspace);
    const spawn = (argv) => {
      if (argv[1] === "init") throw new Error("init must not run when a pointer exists");
      return { status: 0, stdout: upJson(), stderr: "" };
    };
    const first = prepare({ workspace, spawnCli: spawn });
    const second = prepare({ workspace, spawnCli: spawn });
    expect(first.init_ran).toBe(false);
    expect(second.init_ran).toBe(false);
    expect(second.up_ran).toBe(true);
    expect(second.ready).toBe(true);
  });

  it("leaves a remote-redefined media.local unchanged and does not spawn", () => {
    const workspace = tempWorkspace("remote-name");
    const profile = {
      ...OFFICIAL_STARTER,
      endpoints: {
        ...OFFICIAL_STARTER.endpoints,
        "media.local": {
          use: "@hypit/provider-hypihub",
          config: { baseUrl: "https://example.invalid", apiKey: { store: "os", key: "x" } }
        }
      }
    };
    writePointer(workspace, profile);
    const before = readFileSync(join(workspace, "hypit.runtime.json"));
    let spawns = 0;
    const result = prepare({
      workspace,
      spawnCli: () => {
        spawns += 1;
        return { status: 0, stdout: upJson(), stderr: "" };
      }
    });
    expect(spawns).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.up_ran).toBe(false);
    expect(result.code).toBe("HYPIT_UNTRUSTED_SOURCE");
    expect(result.reason).toMatch(/media\.local/);
    expect(readFileSync(join(workspace, "hypit.runtime.json")).equals(before)).toBe(true);
  });

  it("refuses custom executable paths on hyperframes.local without rewriting", () => {
    const workspace = tempWorkspace("custom-bin");
    const profile = {
      ...OFFICIAL_STARTER,
      endpoints: {
        ...OFFICIAL_STARTER.endpoints,
        "hyperframes.local": {
          use: "@hypit/provider-hyperframes-local",
          config: { hyperframesCliPath: "/tmp/evil-cli" }
        }
      }
    };
    writePointer(workspace, profile);
    const before = readFileSync(join(workspace, "hypit.runtime.json"));
    let spawns = 0;
    const result = prepare({
      workspace,
      spawnCli: () => {
        spawns += 1;
        return { status: 0, stdout: upJson(), stderr: "" };
      }
    });
    expect(spawns).toBe(0);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/hyperframesCliPath|official local starter/);
    expect(readFileSync(join(workspace, "hypit.runtime.json")).equals(before)).toBe(true);
  });

  it("allows official local concurrency config and still scopes up", () => {
    const workspace = tempWorkspace("concurrency");
    writePointer(workspace, {
      format: "hypit.runtime-local@1",
      dataRoot: ".hypit/runtimes/local",
      endpoints: {
        "media.local": { use: "@hypit/provider-media-local", config: { defaultConcurrency: 2 } },
        "hyperframes.local": {
          use: "@hypit/provider-hyperframes-local",
          config: { workers: 2, defaultConcurrency: 1 }
        }
      }
    });
    const result = prepare({
      workspace,
      spawnCli: (argv) => {
        expect(argv[1]).toBe("up");
        expect(argv).toContain("media.local");
        expect(argv).toContain("hyperframes.local");
        expect(argv).not.toContain("hypihub.default");
        return { status: 0, stdout: upJson(), stderr: "" };
      }
    });
    expect(result.ok).toBe(true);
  });

  it("does not invent readiness when up exits 0 without ready=true", () => {
    const workspace = tempWorkspace("no-ready");
    writePointer(workspace);
    const result = prepare({
      workspace,
      spawnCli: () => ({
        status: 0,
        stdout: JSON.stringify({ format: "hypit.cli-runtime-up@1", worker: "running" }),
        stderr: ""
      })
    });
    expect(result.ok).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.up.ready).toBe(false);
    expect(result.up.worker).toBe("running");
    expect(result.code).toBe("HYPIT_RUNTIME_NOT_READY");
  });

  it("does not rewrite when native init reports the profile already exists", () => {
    const workspace = tempWorkspace("init-exists");
    writeFileSync(join(workspace, "hypit.runtime.json"), `${JSON.stringify(OFFICIAL_STARTER, null, 2)}\n`);
    const before = readFileSync(join(workspace, "hypit.runtime.json"));
    const result = prepare({
      workspace,
      spawnCli: (argv) => {
        expect(argv[1]).toBe("init");
        return {
          status: 1,
          stdout: "",
          stderr: `Runtime Profile already exists: ${join(workspace, "hypit.runtime.json")}; select it with hypit runtime use or choose another path\n`
        };
      }
    });
    expect(result.ok).toBe(false);
    expect(result.init_ran).toBe(true);
    expect(result.up_ran).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/already exists|exited 1/);
    expect(readFileSync(join(workspace, "hypit.runtime.json")).equals(before)).toBe(true);
    expect(existsSync(join(workspace, ".hypit", "runtime"))).toBe(false);
  });

  it("returns CLI failure facts when up exits non-zero", () => {
    const workspace = tempWorkspace("up-fail");
    writePointer(workspace);
    const result = prepare({
      workspace,
      spawnCli: () => ({ status: 1, stdout: "", stderr: "programs need attention\n" })
    });
    expect(result.ok).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.up.status).toBe(1);
    expect(result.reason).toMatch(/exited 1/);
  });

  it("returns timeout as not-ready without claiming prepared", () => {
    const workspace = tempWorkspace("timeout");
    writePointer(workspace);
    const result = prepare({
      workspace,
      spawnCli: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
      })
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/timed out/);
  });

  it("refuses caller-supplied commands and endpoints before spawn", () => {
    const workspace = tempWorkspace("caller-argv");
    writePointer(workspace);
    let spawns = 0;
    const spawnCli = () => {
      spawns += 1;
      return { status: 0, stdout: upJson(), stderr: "" };
    };
    expect(() => prepare({
      workspace,
      endpoints: ["hypihub.default"],
      spawnCli
    })).toThrow(/endpoints/);
    expect(() => prepare({
      workspace,
      argv: ["runtime", "up"],
      spawnCli
    })).toThrow(/argv/);
    expect(() => prepare({
      workspace,
      command: "runtime up --endpoint whisperx.local",
      spawnCli
    })).toThrow(/command/);
    expect(() => prepare({
      workspace,
      stateHome: "/tmp/evil-state",
      spawnCli
    })).toThrow(/stateHome/);
    expect(spawns).toBe(0);
  });

  it("rejects a symlink workspace and an unsafe root", () => {
    const real = tempWorkspace("real-ws");
    const parent = tempWorkspace("link-parent");
    const linked = join(parent, "linked-ws");
    symlinkSync(real, linked);
    expect(() => prepare({
      workspace: linked,
      spawnCli: () => ({ status: 0, stdout: upJson(), stderr: "" })
    })).toThrow(/symlink/);
    expect(() => prepare({
      workspace: "/",
      spawnCli: () => ({ status: 0, stdout: upJson(), stderr: "" })
    })).toThrow(/unsafe filesystem root|symlink/);
  });

  it("rejects a missing pinned runtime before spawn", () => {
    const workspace = tempWorkspace("missing-pin");
    const adapterRoot = tempWorkspace("adapter");
    writeFileSync(join(adapterRoot, "pin.json"), JSON.stringify({
      distribution: { package: "@hypit/hypit", version: "0.1.8" }
    }));
    let spawns = 0;
    expect(() => prepare({
      workspace,
      adapterRoot,
      spawnCli: () => {
        spawns += 1;
        return { status: 0, stdout: "", stderr: "" };
      }
    })).toThrow(hypitMissingMessage());
    expect(spawns).toBe(0);
  });

  it("rejects a .hypit directory symlink to an external tree before any init spawn", () => {
    const workspace = tempWorkspace("hypit-dir-link");
    const outside = tempWorkspace("hypit-dir-outside");
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "untouched");
    symlinkSync(outside, join(workspace, ".hypit"));
    let spawns = 0;
    expect(() => prepare({
      workspace,
      spawnCli: () => {
        spawns += 1;
        return { status: 0, stdout: upJson(), stderr: "" };
      }
    })).toThrow(/symlink/);
    expect(spawns).toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
  });

  it("rejects a dangling .hypit link and a dangling default profile link before spawn", () => {
    const workspace = tempWorkspace("dangling-hypit");
    const outside = tempWorkspace("dangling-outside");
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "keep");
    symlinkSync(join(outside, "missing-hypit"), join(workspace, ".hypit"));
    let spawns = 0;
    expect(() => prepare({
      workspace,
      spawnCli: () => {
        spawns += 1;
        return { status: 0, stdout: "", stderr: "" };
      }
    })).toThrow(/symlink/);
    expect(spawns).toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");

    const workspace2 = tempWorkspace("dangling-profile");
    symlinkSync(join(outside, "missing-profile.json"), join(workspace2, "hypit.runtime.json"));
    expect(() => prepare({
      workspace: workspace2,
      spawnCli: () => {
        spawns += 1;
        return { status: 0, stdout: "", stderr: "" };
      }
    })).toThrow(/symlink/);
    expect(spawns).toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
  });

  it("rejects hypit.runtime.json symlink to an external file before init", () => {
    const workspace = tempWorkspace("profile-link");
    const outside = tempWorkspace("profile-outside");
    const sentinel = join(outside, "profile.json");
    writeFileSync(sentinel, "external-profile");
    symlinkSync(sentinel, join(workspace, "hypit.runtime.json"));
    let spawns = 0;
    expect(() => prepare({
      workspace,
      spawnCli: () => {
        spawns += 1;
        return { status: 0, stdout: "", stderr: "" };
      }
    })).toThrow(/symlink/);
    expect(spawns).toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("external-profile");
  });

  it("reuses productionRoot/.tsugite/hypit-host-state with the canonical hypit-workspace", () => {
    const { productionRoot, workspace } = tempProduction();
    writePointer(workspace);
    const productionReal = realpathSync(productionRoot);
    const workspaceReal = realpathSync(workspace);
    const stateHome = join(productionReal, ".tsugite", "hypit-host-state");
    mkdirSync(join(stateHome, "home"), { recursive: true });
    writeFileSync(join(stateHome, "reuse-marker"), "keep-installed-runtime");
    const calls = [];
    const result = prepare({
      workspace,
      productionRoot,
      spawnCli: (argv, options) => {
        calls.push({ argv, options });
        return { status: 0, stdout: upJson(), stderr: "" };
      }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(localRuntimeUpArgv(workspaceReal));
    expect(calls[0].options.childEnv.HYPIT_STATE_HOME).toBe(stateHome);
    expect(calls[0].options.childEnv.HOME).toBe(join(stateHome, "home"));
    expect(calls[0].options.childEnv.TMPDIR).toBe(join(stateHome, "tmp"));
    expect(result.host_state_mode).toBe("production");
    expect(result.production_root).toBe(productionReal);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(stateHome, "reuse-marker"), "utf8")).toBe("keep-installed-runtime");
  });

  it("rejects a workspace that is not productionRoot/hypit-workspace", () => {
    const { productionRoot } = tempProduction();
    const other = tempWorkspace("other-ws");
    writePointer(other);
    let spawns = 0;
    expect(() => prepare({
      workspace: other,
      productionRoot,
      spawnCli: () => {
        spawns += 1;
        return { status: 0, stdout: upJson(), stderr: "" };
      }
    })).toThrow(/hypit-workspace/);
    expect(spawns).toBe(0);
  });

  it("rejects a nested directory that is not the canonical hypit-workspace name", () => {
    const productionRoot = tempWorkspace("prod-nested");
    const nested = join(productionRoot, "not-the-workspace");
    mkdirSync(nested);
    writePointer(nested);
    let spawns = 0;
    expect(() => prepare({
      workspace: nested,
      productionRoot,
      spawnCli: () => {
        spawns += 1;
        return { status: 0, stdout: "", stderr: "" };
      }
    })).toThrow(/hypit-workspace/);
    expect(spawns).toBe(0);
  });

  it("rejects a symlink runtime pointer via existing selection trust", () => {
    const workspace = tempWorkspace("ptr-link");
    const outside = tempWorkspace("outside");
    writeFileSync(join(outside, "hypit.runtime.json"), `${JSON.stringify(OFFICIAL_STARTER, null, 2)}\n`);
    mkdirSync(join(workspace, ".hypit"), { recursive: true });
    symlinkSync(join(outside, "hypit.runtime.json"), join(workspace, "hypit.runtime.json"));
    writeFileSync(join(workspace, ".hypit", "runtime"), "hypit.runtime.json\n");
    expect(() => prepare({
      workspace,
      spawnCli: () => ({ status: 0, stdout: upJson(), stderr: "" })
    })).toThrow(/symlink/);
  });
});

describe("inspectTrustedLocalStarterEndpoints", () => {
  it("accepts the official video Distribution starter local entries", () => {
    const workspace = tempWorkspace("inspect");
    expect(inspectTrustedLocalStarterEndpoints(OFFICIAL_STARTER, workspace).ok).toBe(true);
  });

  it("rejects a missing local starter endpoint", () => {
    const workspace = tempWorkspace("inspect-missing");
    const result = inspectTrustedLocalStarterEndpoints({
      format: "hypit.runtime-local@1",
      dataRoot: ".hypit/runtimes/local",
      endpoints: {
        "media.local": { use: "@hypit/provider-media-local" }
      }
    }, workspace);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/hyperframes\.local/);
  });
});

describe("Hypit Node >=22.15 diagnostic", () => {
  it("keeps the additional 22.15 floor without lowering core 22.12", () => {
    expect(HYPIT_MIN_NODE_VERSION).toBe("22.15.0");
    expect(isHypitSupportedNodeVersion("v22.14.0")).toBe(false);
    expect(isHypitSupportedNodeVersion("v22.14.9")).toBe(false);
    expect(isHypitSupportedNodeVersion("v22.15.0")).toBe(true);
    expect(isHypitSupportedNodeVersion("v22.15.1")).toBe(true);
    expect(isHypitSupportedNodeVersion("v23.0.0")).toBe(false);
  });

  it("rejects Node 22.14 before spawn and does not mutate an existing profile", () => {
    const workspace = tempWorkspace("node-22-14");
    writePointer(workspace);
    const before = readFileSync(join(workspace, "hypit.runtime.json"));
    let spawns = 0;
    try {
      prepare({
        workspace,
        nodeVersion: "v22.14.0",
        spawnCli: () => {
          spawns += 1;
          return { status: 0, stdout: upJson(), stderr: "" };
        }
      });
      throw new Error("expected HYPIT_NODE_UNSUPPORTED");
    } catch (error) {
      expect(error.code).toBe("HYPIT_NODE_UNSUPPORTED");
      expect(error.message).toMatch(/22\.15/);
      expect(error.message).toMatch(/22\.12/);
    }
    expect(spawns).toBe(0);
    expect(readFileSync(join(workspace, "hypit.runtime.json")).equals(before)).toBe(true);
  });

  it("allows Node 22.15, spawns up, and does not rewrite the trusted profile", () => {
    const workspace = tempWorkspace("node-22-15");
    writePointer(workspace);
    const before = readFileSync(join(workspace, "hypit.runtime.json"));
    const calls = [];
    const result = prepare({
      workspace,
      nodeVersion: "v22.15.0",
      spawnCli: (argv) => {
        calls.push(argv);
        return { status: 0, stdout: upJson(), stderr: "" };
      }
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([localRuntimeUpArgv(realpathSync(workspace))]);
    expect(readFileSync(join(workspace, "hypit.runtime.json")).equals(before)).toBe(true);
  });
});
