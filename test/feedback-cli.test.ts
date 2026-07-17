import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

describe("pipeline feedback command", () => {
  it("records structured feedback with optional evidence and promotion metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-cli-"));
    const configPath = join(root, "project.yaml");
    await writeProjectConfig(configPath);

    const result = await capture([
      "feedback",
      "--config", configPath,
      "--key", "opening-audio",
      "--category", "sound",
      "--signal", "prefer",
      "--stage", "promoted",
      "--summary", "Start the soundtrack at frame zero",
      "--run-id", "feedback-cli-r2",
      "--gate", "gate_3",
      "--evidence", "dist/feedback-cli-r2/gate3-qc.json",
      "--promotion-kind", "qa",
      "--target", "src/orchestrator/gate3Qc.ts",
      "--json"
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      command: "feedback",
      entry: {
        schema_version: 1,
        key: "opening-audio",
        category: "sound",
        signal: "prefer",
        stage: "promoted",
        summary: "Start the soundtrack at frame zero",
        run_id: "feedback-cli-r2",
        gate: "gate_3",
        evidence: ["dist/feedback-cli-r2/gate3-qc.json"],
        promotion: {
          kind: "qa",
          target: "src/orchestrator/gate3Qc.ts"
        }
      }
    });
    expect(payload.entry.id).toEqual(expect.any(String));
    expect(payload.entry.created_at).toEqual(expect.any(String));
    expect(JSON.parse((await readFile(payload.path, "utf8")).trim())).toEqual(payload.entry);
  });

  it("records a pending promotion proposal for human approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-cli-"));
    const configPath = join(root, "project.yaml");
    await writeProjectConfig(configPath);

    const result = await capture([
      "feedback",
      "--config", configPath,
      "--key", "opening-audio",
      "--category", "sound",
      "--signal", "prefer",
      "--stage", "recurring",
      "--summary", "Start the soundtrack at frame zero",
      "--evidence", "dist/run-1/gate3-qc.json",
      "--promotion-kind", "qa",
      "--target", "src/orchestrator/gate3Qc.ts",
      "--proposal-summary", "Add an opening-audio Gate 3 check",
      "--verification", "Confirm the check on a later project",
      "--proposal-workflow", "tsugite-learning-promotion-review",
      "--proposal-run-id", "automation-run-17",
      "--json"
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      entry: {
        stage: "recurring",
        promotion_proposal: {
          id: expect.any(String),
          kind: "qa",
          target: "src/orchestrator/gate3Qc.ts",
          change_summary: "Add an opening-audio Gate 3 check",
          verification: "Confirm the check on a later project",
          source: {
            kind: "codex_automation",
            workflow_id: "tsugite-learning-promotion-review",
            run_id: "automation-run-17"
          },
          decision: "pending"
        }
      }
    });
  });

  it("rejects proposal provenance without proposal details, a workflow, or safe ids", async () => {
    const baseArgs = [
      "feedback",
      "--config", "project.yaml",
      "--key", "opening-audio",
      "--category", "sound",
      "--signal", "prefer",
      "--stage", "recurring",
      "--summary", "Start the soundtrack at frame zero",
      "--evidence", "dist/run-1/gate3-qc.json",
      "--promotion-kind", "qa",
      "--target", "src/orchestrator/gate3Qc.ts"
    ];

    const withoutProposal = await capture([
      ...baseArgs,
      "--proposal-workflow", "tsugite-learning-promotion-review",
      "--json"
    ]);
    expect(JSON.parse(withoutProposal.stderr).issues).toContainEqual(expect.objectContaining({
      code: "feedback.proposal_source_without_proposal",
      path: "--proposal-workflow"
    }));

    const withoutWorkflow = await capture([
      ...baseArgs,
      "--proposal-summary", "Add a check",
      "--verification", "Verify later",
      "--proposal-run-id", "automation-run-17",
      "--json"
    ]);
    expect(JSON.parse(withoutWorkflow.stderr).issues).toContainEqual(expect.objectContaining({
      code: "feedback.proposal_workflow_required",
      path: "--proposal-workflow"
    }));

    const unsafeIds = await capture([
      ...baseArgs,
      "--proposal-summary", "Add a check",
      "--verification", "Verify later",
      "--proposal-workflow", "unsafe workflow",
      "--proposal-run-id", "../run",
      "--json"
    ]);
    expect(JSON.parse(unsafeIds.stderr).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "feedback.proposal_workflow_invalid", path: "--proposal-workflow" }),
      expect.objectContaining({ code: "feedback.proposal_run_id_invalid", path: "--proposal-run-id" })
    ]));
  });

  it("reports missing and invalid values using structured issues", async () => {
    const result = await capture([
      "feedback",
      "--config", "project.yaml",
      "--signal", "sometimes",
      "--stage", "learned",
      "--gate", "gate-1",
      "--promotion-kind", "code",
      "--json"
    ]);

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stderr);
    expect(payload).toMatchObject({ ok: false, command: "feedback" });
    expect(payload.issues.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining([
      "feedback.key_required",
      "feedback.category_required",
      "feedback.signal_invalid",
      "feedback.stage_invalid",
      "feedback.summary_required",
      "feedback.gate_invalid",
      "feedback.promotion_kind_invalid",
      "feedback.promotion_incomplete"
    ]));
  });

  it("requires promotion kind and target together", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-cli-"));
    const configPath = join(root, "project.yaml");
    await writeProjectConfig(configPath);

    const result = await capture([
      "feedback",
      "--config", configPath,
      "--key", "opening-audio",
      "--category", "sound",
      "--signal", "prefer",
      "--stage", "observed",
      "--summary", "Start the soundtrack at frame zero",
      "--target", "LESSONS.md",
      "--json"
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues).toContainEqual(expect.objectContaining({
      code: "feedback.promotion_incomplete",
      path: "--promotion-kind"
    }));
  });

  it("rejects feedback-only options on other commands", async () => {
    const result = await capture([
      "validate",
      "--config", "fixtures/projects/local-valid.yaml",
      "--key", "opening-audio",
      "--json"
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0]).toMatchObject({
      code: "cli.option_unsupported",
      path: "--key"
    });
  });

  it("does not accept execution authority options", async () => {
    const result = await capture([
      "feedback",
      "--config", "project.yaml",
      "--actor", "coordinator",
      "--json"
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).issues[0]).toMatchObject({
      code: "cli.option_unsupported",
      path: "--actor"
    });
  });
});

async function capture(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const status = await main(args);
  const stdout = log.mock.calls.map((call) => String(call[0])).join("\n");
  const stderr = error.mock.calls.map((call) => String(call[0])).join("\n");
  log.mockRestore();
  error.mockRestore();
  return { status, stdout, stderr };
}

async function writeProjectConfig(path: string): Promise<void> {
  await writeFile(path, "slug: feedback-cli\nmanifest: manifest.json\nedit:\n  backend: remotion\n");
}
