import { describe, expect, it } from "vitest";
import {
  GLOBAL_OPTIONS,
  commandRequiresConfig,
  getCommandHelp,
  isCommandOptionAllowed,
  isKnownCommand,
  listCommandHelp,
  suggestCommands
} from "../src/cli/commandCatalog.js";

const expectedOptions = {
  doctor: ["--config"],
  guides: ["--catalog", "--model", "--input-mode"],
  "story-guides": ["--request", "--duration"],
  connections: ["--model", "--capability"],
  presets: ["--backend"],
  "viewer-launcher": ["--projects-dir", "--port", "--open"],
  feedback: [
    "--config",
    "--key",
    "--category",
    "--signal",
    "--stage",
    "--summary",
    "--run-id",
    "--gate",
    "--evidence",
    "--promotion-kind",
    "--target",
    "--proposal-summary",
    "--verification",
    "--proposal-workflow",
    "--proposal-run-id",
    "--proposal-source"
  ],
  "shitate-import": [
    "--config",
    "--shitate-root",
    "--character",
    "--run-id",
    "--anchor",
    "--request-id",
    "--speaker-id",
    "--display-name",
    "--side",
    "--accent"
  ],
  validate: ["--config"],
  finalize: ["--config", "--state-dir", "--actor", "--apply"],
  plan: ["--config"],
  analyze: ["--config", "--actor", "--state-dir", "--allow-external-analysis"],
  compose: ["--config", "--actor", "--state-dir"],
  viewer: ["--config", "--output", "--state-dir", "--open"],
  review: ["--config", "--output", "--state-dir", "--open"],
  run: ["--config", "--dry-run", "--actor", "--state-dir"],
  gate: ["--config", "--actor", "--gate", "--decision", "--state-dir"],
  render: ["--config", "--actor", "--state-dir"]
} as const;

const configCommands = new Set([
  "feedback",
  "shitate-import",
  "validate",
  "finalize",
  "plan",
  "analyze",
  "compose",
  "viewer",
  "review",
  "run",
  "gate",
  "render"
]);

describe("CLI command catalog", () => {
  it("defines every command once with serializable help metadata", () => {
    const commands = listCommandHelp();
    const names = commands.map(({ name }) => name);

    expect(names).toEqual(Object.keys(expectedOptions));
    expect(new Set(names).size).toBe(names.length);
    expect(() => JSON.parse(JSON.stringify(commands))).not.toThrow();

    for (const command of commands) {
      expect(command.summary.length).toBeGreaterThan(0);
      expect(command.usage).toMatch(new RegExp(`^node bin/pipeline ${command.name}(?: |$)`));
      expect(command.requiresConfig).toBe(configCommands.has(command.name));
      expect(["read-only", "local-write", "approval-gated"]).toContain(command.safety);
      expect(new Set(command.options.map(({ name }) => name)).size).toBe(command.options.length);
    }
  });

  it("keeps the exact command option allow-list in the catalog", () => {
    for (const [name, options] of Object.entries(expectedOptions)) {
      const command = getCommandHelp(name);

      expect(command?.options.map((option) => option.name)).toEqual(options);
      for (const option of options) {
        expect(isCommandOptionAllowed(name, option)).toBe(true);
      }
      expect(isCommandOptionAllowed(name, "--not-supported")).toBe(false);
    }
  });

  it("defines global help and JSON options for every known command", () => {
    expect(GLOBAL_OPTIONS.map(({ name }) => name)).toEqual(["--json", "--help"]);

    for (const command of listCommandHelp()) {
      expect(isCommandOptionAllowed(command.name, "--json")).toBe(true);
      expect(isCommandOptionAllowed(command.name, "--help")).toBe(true);
    }
  });

  it("looks up known commands and preserves permissive unknown-command parsing", () => {
    expect(getCommandHelp("validate")?.usage).toBe(
      "node bin/pipeline validate --config <project.yaml> [--json]"
    );
    expect(getCommandHelp("missing")).toBeUndefined();
    expect(isKnownCommand("validate")).toBe(true);
    expect(isKnownCommand("validte")).toBe(false);
    expect(commandRequiresConfig("validate")).toBe(true);
    expect(commandRequiresConfig("doctor")).toBe(false);
    expect(commandRequiresConfig("missing")).toBe(false);
    expect(isCommandOptionAllowed("validte", "--config")).toBe(true);
  });

  it("classifies compose as a config-scoped local write", () => {
    expect(getCommandHelp("compose")).toMatchObject({
      requiresConfig: true,
      safety: "local-write",
      options: [
        expect.objectContaining({ name: "--config" }),
        expect.objectContaining({ name: "--actor" }),
        expect.objectContaining({ name: "--state-dir" })
      ]
    });
  });

  it("does not expose mutable catalog data", () => {
    const commands = listCommandHelp();
    const validate = getCommandHelp("validate");

    expect(Object.isFrozen(commands)).toBe(true);
    expect(Object.isFrozen(validate)).toBe(true);
    expect(Object.isFrozen(validate?.options)).toBe(true);
    expect(Object.isFrozen(validate?.options[0])).toBe(true);
    expect(Object.isFrozen(GLOBAL_OPTIONS)).toBe(true);
    expect(Object.isFrozen(GLOBAL_OPTIONS[0])).toBe(true);
    expect(() => (commands as unknown[]).push({})).toThrow();
    expect(() => (validate?.options as unknown[]).push({})).toThrow();
  });

  it("suggests the closest commands deterministically and honors the limit", () => {
    expect(suggestCommands("validte")[0]).toBe("validate");
    expect(suggestCommands("story-guide", 1)).toEqual(["story-guides"]);
    expect(suggestCommands("", 3)).toEqual([]);
    expect(suggestCommands("run", 0)).toEqual([]);
    expect(suggestCommands("v", 2)).toHaveLength(2);
  });
});
