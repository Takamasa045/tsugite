import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { authorProjectPrompt, AUTHOR_STOPS_BEFORE } from "../adapters/hypit/agentBridge.mjs";
import { assertCostNotInvented, readHypitCost } from "../adapters/hypit/cost.mjs";
import { observePlanFingerprint, sha256Bytes, sha256Text } from "../adapters/hypit/digest.mjs";
import { assertAllowed, classifyHypitArgv } from "../adapters/hypit/permissions.mjs";
import {
  HYPIT_PACKAGE,
  HYPIT_VERSION,
  buildObserveArgv,
  hypitChildEnv,
  hypitEntry,
  hypitMissingMessage
} from "../adapters/hypit/runtimeAdapter.mjs";
import { assertPhase1ObserveTarget } from "../adapters/hypit/trust.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Hypit Phase 1 pin and launcher", () => {
  it("pins the official npm Distribution, not the unscoped 404 name", () => {
    expect(HYPIT_PACKAGE).toBe("@hypit/hypit");
    expect(HYPIT_VERSION).toBe("0.1.8");
    expect(hypitEntry()).toContain("node_modules/@hypit/hypit/bin/hypit.mjs");
  });

  it("fails with an install hint instead of a global hypit binary", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-hypit-missing-"));
    roots.push(root);
    for (const name of ["cli.mjs", "permissions.mjs", "runtimeAdapter.mjs", "digest.mjs", "trust.mjs", "pin.json"]) {
      copyFileSync(join("adapters/hypit", name), join(root, name));
    }
    const result = spawnSync(process.execPath, [join(root, "cli.mjs"), "--version"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm run hypit:install");
    expect(result.stdout).toBe("");
  });

  it("allowlists child env and drops NODE_OPTIONS plus provider credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "tsugite-hypit-env-"));
    roots.push(root);
    const home = join(root, "home");
    const tmp = join(root, "tmp");
    const state = join(root, "state");
    const original = {
      PATH: "/bin",
      NODE_OPTIONS: "--require ./evil.js",
      NODE_PATH: "/evil",
      OPENAI_API_KEY: "sk-test",
      HYPIHUB_TOKEN: "secret",
      HYPIT_API_KEY: "secret",
      HOME: "/Users/someone",
      TSUGITE_HYPIT_GRANT: "build"
    };
    const env = hypitChildEnv(original, { home, tmpdir: tmp, stateHome: state });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe(home);
    expect(env.TMPDIR).toBe(tmp);
    expect(env.HYPIT_STATE_HOME).toBe(state);
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.TSUGITE_HYPIT_GRANT).toBeUndefined();
    expect(original.NODE_OPTIONS).toBe("--require ./evil.js");
  });
});

describe("Hypit Phase 1 unconditional deny", () => {
  it("allows check and plan without any grant object", () => {
    expect(classifyHypitArgv(["check", "main.svml", "--json"]).class).toBe("observe");
    expect(classifyHypitArgv(["plan", "build.svrun", "--workspace", "ws"]).class).toBe("observe");
    expect(classifyHypitArgv(["--version"]).class).toBe("observe");
    expect(assertAllowed(["plan", "a.svrun"]).class).toBe("observe");
  });

  it("refuses build even when a grant array or exec token is supplied", () => {
    expect(classifyHypitArgv(["build", "build.svrun"]).class).toBe("denied");
    expect(() => assertAllowed(["build", "build.svrun"])).toThrow(/no grant override/);
    expect(() => assertAllowed(["build", "build.svrun"], ["build"])).toThrow(/ignores grant arrays/);
    expect(() => assertAllowed(["build", "build.svrun", "--follow"], ["exec"])).toThrow(/ignores grant arrays/);
  });

  it("refuses Worker start, login, transcribe, pricing, and packages install", () => {
    for (const argv of [
      ["runtime", "up"],
      ["runtime", "init"],
      ["programs", "up"],
      ["auth", "login", "hypihub.default"],
      ["transcribe", "clip.mp4"],
      ["packages", "install", "@fontsource-variable/inter@5.3.0"],
      ["pricing", "build.svrun"],
      ["studio", "--run", "build.svrun"],
      ["get", "bld_1", "--output", "final.video", "--to", "out.mp4"],
      ["status", "bld_1", "--watch"]
    ]) {
      expect(classifyHypitArgv(argv).class).toBe("denied");
      expect(() => assertAllowed(argv)).toThrow(/Phase 1 has no grant override/);
    }
  });

  it("the gated launcher exits 3 for --package-root after a positional check source", () => {
    const result = spawnSync(process.execPath, [
      join("adapters/hypit/cli.mjs"),
      "check",
      "chat.svml",
      "--workspace",
      "/tmp/ws",
      "--package-root",
      "/evil/packages"
    ], { encoding: "utf8" });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("package-root");
  });

  it("the gated launcher exits 2 for build and ignores TSUGITE_HYPIT_GRANT", () => {
    const denied = spawnSync(process.execPath, [join("adapters/hypit/cli.mjs"), "build", "build.svrun"], {
      encoding: "utf8"
    });
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain("Phase 1 has no grant override");
    const envUnlock = spawnSync(process.execPath, [join("adapters/hypit/cli.mjs"), "build", "build.svrun"], {
      encoding: "utf8",
      env: { ...process.env, TSUGITE_HYPIT_GRANT: "build" }
    });
    expect(envUnlock.status).toBe(2);
    expect(envUnlock.stderr).toContain("ignores TSUGITE_HYPIT_GRANT");
  });
});

describe("Hypit cost reading never invents zero", () => {
  it("keeps an empty payload unknown with a null amount", () => {
    const cost = assertCostNotInvented(readHypitCost(undefined));
    expect(cost.status).toBe("unknown");
    expect(cost.amount).toBeNull();
  });

  it("does not treat missing pricing as zero", () => {
    const cost = readHypitCost({ format: "hypit.plan@1", targets: ["final.video"] });
    expect(cost.status).toBe("unknown");
    expect(cost.amount).toBeNull();
    expect(cost.requestCount).toBe(0);
  });

  it("keeps amount null even when every listed request is local", () => {
    const local = readHypitCost({
      requests: [
        { request: "a", pricing: { kind: "local" } },
        { request: "b", pricing: { kind: "local" } }
      ]
    });
    expect(local.status).toBe("local-only");
    expect(local.amount).toBeNull();
  });
});

describe("Hypit observation fingerprint is not an approval", () => {
  it("hashes raw bytes so invalid UTF-8 sequences do not collapse", () => {
    const left = Buffer.from([0xff]);
    const right = Buffer.from([0xfe]);
    expect(left.toString("utf8")).toBe(right.toString("utf8"));
    expect(sha256Text(left.toString("utf8"))).toBe(sha256Text(right.toString("utf8")));
    expect(sha256Bytes(left)).not.toBe(sha256Bytes(right));
  });

  it("labels the fingerprint observation-only and changes when a file hash changes", () => {
    const base = {
      distribution: { package: "@hypit/hypit", version: "0.1.8", entrySha256: "aaa" },
      workspace: "/tmp/ws",
      files: [{ path: "main.svml", sha256: "s1", bytes: 1 }],
      runtime: { path: "hypit.runtime.json", sha256: "r1", bytes: 1 },
      planSha256: "p1",
      cost: { status: "unknown", requestCount: 0 }
    };
    const first = observePlanFingerprint(base);
    expect(first.observation.authorization).toBe(false);
    expect(first.observation.role).toBe("observation-only");
    expect(first.observationDigest).toHaveLength(64);
    const changed = observePlanFingerprint({
      ...base,
      files: [{ path: "main.svml", sha256: "s2", bytes: 1 }]
    });
    expect(changed.observationDigest).not.toBe(first.observationDigest);
  });
});

describe("Hypit agent bridge stays before build", () => {
  it("writes a standalone author prompt that forbids nested execution", () => {
    const prompt = authorProjectPrompt({
      workspace: "/tmp/ws",
      brief: "synthetic ranking without a user video"
    });
    expect(prompt).toContain("Do not claim reference analysis");
    for (const denied of AUTHOR_STOPS_BEFORE) {
      expect(prompt).toContain(denied);
    }
    expect(prompt).not.toContain("spawn");
  });
});

describe("Hypit observe argv", () => {
  it("builds official flags from the v0.1.8 help contract", () => {
    expect(buildObserveArgv("check", {
      source: "chat.svml",
      workspace: "/ws",
      json: true
    })).toEqual(["check", "chat.svml", "--workspace", "/ws", "--json"]);
    expect(buildObserveArgv("plan", {
      source: "chat.svrun",
      workspace: "/ws",
      json: true
    })).toEqual(["plan", "chat.svrun", "--workspace", "/ws", "--json"]);
  });
});

function stageOfficialPin(adapterRoot, repo) {
  const official = join(adapterRoot, "runtime/node_modules/@hypit/hypit/examples/semantic-composition");
  const files = {
    "chat.svml": "svml-official",
    "chat.svs": "svs-official",
    "chat.svrun": "svrun-official",
    "hypit.runtime.json": "{}",
    "packages/chat-scene/src/activation.ts": "act-src",
    "packages/chat-scene/src/render.ts": "ren-src",
    "packages/chat-scene/dist/activation.js": "act-js",
    "packages/chat-scene/dist/render.js": "ren-js"
  };
  for (const [rel, body] of Object.entries(files)) {
    const path = join(official, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  writeFileSync(join(adapterRoot, "expected-build.json"), JSON.stringify({
    format: "tsugite.hypit-expected-build@1",
    files: {
      "packages/chat-scene/dist/activation.js": {
        sha256: sha256Bytes(Buffer.from("act-js")),
        bytes: Buffer.byteLength("act-js")
      },
      "packages/chat-scene/dist/render.js": {
        sha256: sha256Bytes(Buffer.from("ren-js")),
        bytes: Buffer.byteLength("ren-js")
      }
    }
  }));
  const workspace = join(repo, ".tsugite/tools/hypit-phase1-workspace");
  mkdirSync(dirname(workspace), { recursive: true });
  cpSync(official, workspace, { recursive: true });
  return workspace;
}

describe("Hypit Phase 1 exact check/plan profile", () => {
  it("refuses --package-root even when the positional source comes first", () => {
    const argv = [
      "check",
      "chat.svml",
      "--workspace",
      "/tmp/ws",
      "--json",
      "--package-root",
      "/evil/packages"
    ];
    expect(() => assertPhase1ObserveTarget(argv, "/tmp")).toThrow(/package-root/);
  });

  it("refuses --runtime and --asset-root overrides on plan", () => {
    expect(() => assertPhase1ObserveTarget([
      "plan",
      "chat.svrun",
      "--runtime",
      "hypit.runtime.json",
      "--workspace",
      "/tmp/ws"
    ], "/tmp")).toThrow(/--runtime/);
    expect(() => assertPhase1ObserveTarget([
      "plan",
      "chat.svrun",
      "--workspace",
      "/tmp/ws",
      "--asset-root",
      "/evil/assets"
    ], "/tmp")).toThrow(/asset-root/);
  });

  it("refuses a tampered SVML in the prepared workspace before spawn", () => {
    const adapterRoot = mkdtempSync(join(tmpdir(), "tsugite-hypit-adapter-"));
    const repo = mkdtempSync(join(tmpdir(), "tsugite-hypit-repo-"));
    roots.push(adapterRoot, repo);
    const workspace = stageOfficialPin(adapterRoot, repo);
    writeFileSync(join(workspace, "chat.svml"), "tampered-svml");
    expect(() => assertPhase1ObserveTarget([
      "check",
      join(workspace, "chat.svml"),
      "--workspace",
      workspace,
      "--json"
    ], workspace, adapterRoot, repo)).toThrow(/drifted: chat\.svml/);
  });

  it("refuses a new SVML name under the fixture root", () => {
    const adapterRoot = mkdtempSync(join(tmpdir(), "tsugite-hypit-adapter-"));
    const repo = mkdtempSync(join(tmpdir(), "tsugite-hypit-repo-"));
    roots.push(adapterRoot, repo);
    const workspace = stageOfficialPin(adapterRoot, repo);
    writeFileSync(join(workspace, "evil.svml"), "not-official");
    expect(() => assertPhase1ObserveTarget([
      "check",
      join(workspace, "evil.svml"),
      "--workspace",
      workspace
    ], workspace, adapterRoot, repo)).toThrow(/must be named chat\.svml/);
  });

  it("refuses a tampered activation.js even when SVML bytes still match", () => {
    const adapterRoot = mkdtempSync(join(tmpdir(), "tsugite-hypit-adapter-"));
    const repo = mkdtempSync(join(tmpdir(), "tsugite-hypit-repo-"));
    roots.push(adapterRoot, repo);
    const workspace = stageOfficialPin(adapterRoot, repo);
    writeFileSync(join(workspace, "packages/chat-scene/dist/activation.js"), "tampered-activation");
    expect(() => assertPhase1ObserveTarget([
      "plan",
      join(workspace, "chat.svrun"),
      "--workspace",
      workspace,
      "--json"
    ], workspace, adapterRoot, repo)).toThrow(/Activation\/build bytes/);
  });

  it("accepts the exact check argv only when source tree and activation match the pin", () => {
    const adapterRoot = mkdtempSync(join(tmpdir(), "tsugite-hypit-adapter-"));
    const repo = mkdtempSync(join(tmpdir(), "tsugite-hypit-repo-"));
    roots.push(adapterRoot, repo);
    const workspace = stageOfficialPin(adapterRoot, repo);
    expect(() => assertPhase1ObserveTarget([
      "check",
      join(workspace, "chat.svml"),
      "--workspace",
      workspace,
      "--json"
    ], workspace, adapterRoot, repo)).not.toThrow();
  });
});

describe("live pinned Hypit CLI", () => {
  const entry = hypitEntry();
  const installed = existsSync(entry);

  it("reports 0.1.8 from the isolated Distribution when installed", () => {
    if (!installed) {
      expect(hypitMissingMessage()).toContain("hypit:install");
      return;
    }
    const result = spawnSync(process.execPath, ["adapters/hypit/cli.mjs", "--version"], {
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "TSUGITE_HYPIT_GRANT"))
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.8");
  });
});
