import { lstat, mkdir, mkdtemp, readFile, rename, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateFeedback,
  appendProjectFeedback,
  decideProjectFeedbackPromotion,
  FEEDBACK_MAX_FILE_BYTES,
  FEEDBACK_MAX_LINE_BYTES,
  FEEDBACK_MAX_RECORDS,
  readProjectFeedback,
  type FeedbackRecord
} from "../src/feedback/index.js";

const base = {
  key: "opening-audio",
  category: "audio",
  signal: "prefer" as const,
  stage: "observed" as const,
  summary: "冒頭から音を入れる"
};

describe("feedback contract", () => {
  it("appends strict JSONL beside project.yaml and reads it", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    await writeProjectConfig(configPath);

    const appended = await appendProjectFeedback(configPath, {
      ...base,
      id: "fb-1",
      created_at: "2026-07-17T00:00:00.000Z",
      evidence: ["dist/run-1/review/index.html"]
    });
    const result = await readProjectFeedback(configPath);

    expect(appended.path).toBe(join(root, "feedback.jsonl"));
    expect(result.entries).toEqual([appended.entry]);
    expect(result.issues).toEqual([]);
    expect((await readFile(appended.path, "utf8")).endsWith("\n")).toBe(true);
  });

  it("rejects unsafe paths, unknown fields, and unsupported maturity claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    await writeProjectConfig(configPath);
    await expect(appendProjectFeedback(configPath, { ...base, evidence: ["../secret"] })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.invalid_record" })]
    });
    await expect(appendProjectFeedback(configPath, { ...base, evidence: ["C:/Users/example/secret"] })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.invalid_record" })]
    });
    await expect(appendProjectFeedback(configPath, { ...base, stage: "promoted" })).rejects.toThrow("promoted feedback requires promotion");
    await expect(appendProjectFeedback(configPath, { ...base, stage: "verified" })).rejects.toThrow("verified feedback requires evidence");
    await expect(appendProjectFeedback(configPath, {
      ...base,
      stage: "verified",
      evidence: ["dist/run/gate3-qc.json"],
      promotion: { kind: "qa", target: "src/orchestrator/gate3Qc.ts" }
    })).rejects.toThrow("promotion is only valid for promoted feedback");
    await expect(appendProjectFeedback(configPath, { ...base, extra: true } as never)).rejects.toThrow("Unrecognized key");
  });

  it("records promotion proposals only while recurring and requires a human decision timestamp", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    await writeProjectConfig(configPath);
    const pendingProposal = {
      id: "opening-audio-v1",
      kind: "qa" as const,
      target: "src/orchestrator/gate3Qc.ts",
      change_summary: "冒頭音声をGate 3で確認する",
      verification: "後続案件のgate3-qc.jsonで確認する",
      decision: "pending" as const
    };

    const legacyProposal = await appendProjectFeedback(configPath, {
      ...base,
      stage: "recurring",
      evidence: ["dist/run-1/gate3-qc.json"],
      promotion_proposal: pendingProposal
    });
    expect(legacyProposal.entry).toMatchObject({ promotion_proposal: pendingProposal });
    expect(legacyProposal.entry.promotion_proposal?.source).toBeUndefined();
    await expect(appendProjectFeedback(configPath, {
      ...base,
      promotion_proposal: pendingProposal
    })).rejects.toThrow("promotion proposal is only valid for recurring feedback");
    await expect(appendProjectFeedback(configPath, {
      ...base,
      stage: "recurring",
      promotion_proposal: pendingProposal
    })).rejects.toThrow("promotion proposal requires evidence");
    await expect(appendProjectFeedback(configPath, {
      ...base,
      stage: "recurring",
      evidence: ["dist/run-1/gate3-qc.json"],
      promotion_proposal: { ...pendingProposal, decision: "approved" }
    })).rejects.toThrow("decided promotion proposal requires decided_at and decided_by");

    const decisions = await Promise.allSettled([
      decideProjectFeedbackPromotion(configPath, {
        key: "opening-audio",
        proposalId: "opening-audio-v1",
        decision: "approved"
      }),
      decideProjectFeedbackPromotion(configPath, {
        key: "opening-audio",
        proposalId: "opening-audio-v1",
        decision: "rejected"
      })
    ]);
    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((decision) => decision.status === "rejected")).toHaveLength(1);
    expect((await readProjectFeedback(configPath)).entries.filter((entry) => (
      entry.promotion_proposal?.decision !== "pending"
    ))).toHaveLength(1);
  });

  it("records strict automation provenance and preserves it when a human decides", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    await writeProjectConfig(configPath);
    const proposal = {
      id: "opening-audio-automation-v1",
      kind: "qa" as const,
      target: "src/orchestrator/gate3Qc.ts",
      change_summary: "冒頭音声をGate 3で確認する",
      verification: "後続案件のgate3-qc.jsonで確認する",
      source: {
        kind: "codex_automation" as const,
        workflow_id: "tsugite-learning-promotion-review",
        run_id: "automation-run-17"
      },
      decision: "pending" as const
    };

    await expect(appendProjectFeedback(configPath, {
      ...base,
      stage: "recurring",
      evidence: ["dist/run-1/gate3-qc.json"],
      promotion_proposal: proposal
    })).resolves.toMatchObject({ entry: { promotion_proposal: proposal } });
    await expect(appendProjectFeedback(configPath, {
      ...base,
      stage: "recurring",
      evidence: ["dist/run-1/gate3-qc.json"],
      promotion_proposal: {
        ...proposal,
        source: { ...proposal.source, workflow_id: "unsafe workflow" }
      }
    })).rejects.toThrow("must be a safe id");
    await expect(appendProjectFeedback(configPath, {
      ...base,
      stage: "recurring",
      evidence: ["dist/run-1/gate3-qc.json"],
      promotion_proposal: {
        ...proposal,
        source: { ...proposal.source, extra: true }
      }
    } as never)).rejects.toThrow("Unrecognized key");

    const decided = await decideProjectFeedbackPromotion(configPath, {
      key: "opening-audio",
      proposalId: proposal.id,
      decision: "approved"
    });
    expect(decided.entry.promotion_proposal).toMatchObject({
      source: proposal.source,
      decision: "approved",
      decided_by: "human"
    });

    const rejectedProposal = {
      ...proposal,
      id: "opening-audio-automation-v2"
    };
    await appendProjectFeedback(configPath, {
      ...base,
      key: "opening-audio-rejected",
      stage: "recurring",
      evidence: ["dist/run-2/gate3-qc.json"],
      promotion_proposal: rejectedProposal
    });
    const rejected = await decideProjectFeedbackPromotion(configPath, {
      key: "opening-audio-rejected",
      proposalId: rejectedProposal.id,
      decision: "rejected"
    });
    expect(rejected.entry.promotion_proposal).toMatchObject({
      source: proposal.source,
      decision: "rejected",
      decided_by: "human"
    });
  });

  it("rejects a decision when the append handle does not match the expected feedback identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    await writeProjectConfig(configPath);
    const pending = await appendProjectFeedback(configPath, {
      ...base,
      stage: "recurring",
      evidence: ["dist/run-1/gate3-qc.json"],
      promotion_proposal: {
        id: "opening-audio-identity-v1",
        kind: "qa",
        target: "src/orchestrator/gate3Qc.ts",
        change_summary: "冒頭音声をGate 3で確認する",
        verification: "後続案件のgate3-qc.jsonで確認する",
        decision: "pending"
      }
    });
    const loadedStats = await lstat(pending.path);
    const originalContents = await readFile(pending.path, "utf8");
    await rename(pending.path, join(root, "feedback-original.jsonl"));
    await writeFile(pending.path, originalContents);

    await expect(decideProjectFeedbackPromotion(configPath, {
      key: base.key,
      proposalId: "opening-audio-identity-v1",
      decision: "approved"
    }, {
      expectedFileIdentity: { device: loadedStats.dev, inode: loadedStats.ino }
    })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.file_changed" })]
    });
    expect(await readFile(pending.path, "utf8")).toBe(originalContents);
  });

  it("atomically rejects duplicate automation proposals and allows a new proposal after a decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    await writeProjectConfig(configPath);
    const proposal = {
      kind: "qa" as const,
      target: "src/orchestrator/gate3Qc.ts",
      change_summary: "冒頭音声をGate 3で確認する",
      verification: "後続案件のgate3-qc.jsonで確認する",
      decision: "pending" as const
    };
    const inputFor = (id: string, runId: string) => ({
      ...base,
      stage: "recurring" as const,
      evidence: ["dist/run-1/gate3-qc.json"],
      promotion_proposal: {
        ...proposal,
        id,
        source: {
          kind: "codex_automation" as const,
          workflow_id: "tsugite-learning-promotion-review",
          run_id: runId
        }
      }
    });

    const concurrent = await Promise.allSettled([
      appendProjectFeedback(configPath, inputFor("automation-race-1", "automation-run-1")),
      appendProjectFeedback(configPath, inputFor("automation-race-2", "automation-run-2"))
    ]);
    const fulfilled = concurrent.filter((result) => result.status === "fulfilled");
    const rejected = concurrent.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.proposal_pending_exists" })]
    });

    const accepted = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof appendProjectFeedback>>>).value;
    await decideProjectFeedbackPromotion(configPath, {
      key: base.key,
      proposalId: accepted.entry.promotion_proposal!.id,
      decision: "approved"
    });
    await expect(appendProjectFeedback(configPath, inputFor(
      "automation-duplicate-after-decision",
      "automation-run-3"
    ))).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.proposal_duplicate" })]
    });

    await expect(appendProjectFeedback(configPath, {
      ...inputFor("automation-new-after-decision", "automation-run-4"),
      promotion_proposal: {
        ...inputFor("automation-new-after-decision", "automation-run-4").promotion_proposal,
        change_summary: "冒頭音声と波形をGate 3で確認する"
      }
    })).resolves.toMatchObject({
      entry: {
        promotion_proposal: {
          id: "automation-new-after-decision",
          decision: "pending"
        }
      }
    });

    await expect(appendProjectFeedback(configPath, {
      ...base,
      stage: "recurring",
      evidence: ["dist/run-1/gate3-qc.json"],
      promotion_proposal: {
        ...proposal,
        id: "manual-proposal-after-pending",
        change_summary: "冒頭音声と波形をGate 3で確認する"
      }
    })).resolves.toMatchObject({
      entry: {
        promotion_proposal: {
          id: "manual-proposal-after-pending",
          decision: "pending"
        }
      }
    });
  });

  it("keeps valid records when another line is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    await writeFile(join(root, "feedback.jsonl"), `${JSON.stringify(record("fb-1", "observed"))}\nnot-json\n`);

    const result = await readProjectFeedback(configPath);

    expect(result.entries).toHaveLength(1);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "feedback.invalid_json", line: 2 }));
  });

  it("reports oversized and symlink feedback files without following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    await writeProjectConfig(configPath);
    await writeFile(join(root, "large.jsonl"), "x".repeat(FEEDBACK_MAX_FILE_BYTES + 1));
    await symlink(join(root, "large.jsonl"), join(root, "feedback.jsonl"));

    const result = await readProjectFeedback(configPath);
    expect(result.issues[0]?.code).toBe("feedback.symlink");
    await expect(appendProjectFeedback(configPath, base)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.symlink" })]
    });
  });

  it("enforces file, line, and record-count limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    const feedbackPath = join(root, "feedback.jsonl");
    await writeProjectConfig(configPath);

    await writeFile(feedbackPath, "x".repeat(FEEDBACK_MAX_FILE_BYTES + 1));
    expect((await readProjectFeedback(configPath)).issues[0]?.code).toBe("feedback.file_too_large");
    await expect(appendProjectFeedback(configPath, base)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.file_too_large" })]
    });

    await writeFile(feedbackPath, `${"x".repeat(FEEDBACK_MAX_LINE_BYTES + 1)}\n`);
    expect((await readProjectFeedback(configPath)).issues[0]?.code).toBe("feedback.line_too_long");

    await writeFile(feedbackPath, "\n".repeat(FEEDBACK_MAX_RECORDS + 1));
    const tooMany = await readProjectFeedback(configPath);
    expect(tooMany.lineCount).toBe(FEEDBACK_MAX_RECORDS + 1);
    expect(tooMany.issues).toContainEqual(expect.objectContaining({ code: "feedback.too_many_records" }));
    await expect(appendProjectFeedback(configPath, base)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.too_many_records" })]
    });
  });

  it("refuses to append when project.yaml is missing, a directory, or a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    await expect(appendProjectFeedback(join(root, "missing.yaml"), base)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.config_missing" })]
    });
    const directoryConfig = join(root, "directory.yaml");
    await mkdir(directoryConfig);
    await expect(appendProjectFeedback(directoryConfig, base)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.config_not_file" })]
    });
    const realConfig = join(root, "real.yaml");
    await writeFile(realConfig, "slug: example\n");
    const linkedConfig = join(root, "linked.yaml");
    await symlink(realConfig, linkedConfig);
    await expect(appendProjectFeedback(linkedConfig, base)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.config_symlink" })]
    });

    const invalidConfig = join(root, "project-invalid.yaml");
    await writeFile(invalidConfig, "# not a Tsugite project\n");
    await expect(appendProjectFeedback(invalidConfig, base)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "project.schema" })]
    });
  });

  it("serializes concurrent appends without introducing empty lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    await writeProjectConfig(configPath);
    await writeFile(join(root, "feedback.jsonl"), JSON.stringify(record("existing", "observed")));

    await Promise.all(Array.from({ length: 10 }, (_, index) => appendProjectFeedback(configPath, {
      ...base,
      id: `concurrent-${index}`,
      created_at: `2026-07-17T00:01:${String(index).padStart(2, "0")}.000Z`
    })));

    const result = await readProjectFeedback(configPath);
    expect(result.entries).toHaveLength(11);
    expect(result.issues).toEqual([]);
  });

  it("recovers only old locks whose owner process no longer exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    const lockPath = join(root, "feedback.jsonl.lock");
    await writeProjectConfig(configPath);
    await writeFile(lockPath, `${JSON.stringify({ pid: 999_999, createdAt: "2000-01-01T00:00:00.000Z" })}\n`);
    await utimes(lockPath, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));

    await expect(appendProjectFeedback(configPath, { ...base, id: "after-stale-lock" })).resolves.toMatchObject({
      entry: { id: "after-stale-lock" }
    });
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reclaim an old lock while its owner process is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    const lockPath = join(root, "feedback.jsonl.lock");
    await writeProjectConfig(configPath);
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" })}\n`);
    await utimes(lockPath, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));

    await expect(appendProjectFeedback(configPath, base)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "feedback.lock_timeout" })]
    });
    await unlink(lockPath);
  });

  it("recovers an old malformed lock left before owner metadata was written", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-feedback-"));
    const configPath = join(root, "project.yaml");
    const lockPath = join(root, "feedback.jsonl.lock");
    await writeProjectConfig(configPath);
    await writeFile(lockPath, "");
    await utimes(lockPath, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));

    await expect(appendProjectFeedback(configPath, { ...base, id: "after-empty-lock" })).resolves.toMatchObject({
      entry: { id: "after-empty-lock" }
    });
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aggregates unique keys as a maturity funnel and preserves promotion proof", () => {
    const first = record("fb-1", "observed");
    const promoted = record("fb-2", "promoted", {
      promotion: { kind: "template", target: "templates/dialogue/template.yaml" }
    });
    const verified = record("fb-3", "verified", {
      evidence: ["dist/run-b/gate3-qc.json"]
    });
    const aggregate = aggregateFeedback([
      { projectId: "a", projectName: "Project A", runId: "run-a", entries: [first, promoted] },
      { projectId: "b", projectName: "Project B", runId: "run-b", entries: [verified], issues: [{ code: "feedback.invalid_json", message: "bad", line: 2 }] }
    ]);

    expect(aggregate.metrics).toEqual({ observed: 1, recurring: 1, promoted: 1, verified: 1, issues: 1 });
    expect(aggregate.preferences[0]?.lastSeenAt).toBe("2026-07-17T00:00:03.000Z");
    expect(aggregate.preferences[0]).toMatchObject({
      key: "opening-audio",
      stage: "verified",
      projectCount: 2,
      projectNames: ["Project A", "Project B"],
      runIds: ["run-a", "run-b"],
      promotion: {
        kind: "template",
        target: "templates/dialogue/template.yaml",
        promotedAt: "2026-07-17T00:00:02.000Z"
      }
    });
    expect(aggregate.issues[0]).toMatchObject({ projectName: "Project B", line: 2 });
  });

  it("raises the display stage to recurring after the same key appears in two projects", () => {
    const aggregate = aggregateFeedback([
      { projectId: "a", projectName: "A", entries: [record("fb-a", "observed")] },
      { projectId: "b", projectName: "B", entries: [record("fb-b", "observed")] }
    ]);
    expect(aggregate.preferences[0]?.stage).toBe("recurring");
    expect(aggregate.metrics).toEqual({ observed: 1, recurring: 1, promoted: 0, verified: 0, issues: 0 });
  });

  it("shows the latest promotion proposal decision until the feedback is promoted", () => {
    const proposal = {
      id: "opening-audio-v1",
      kind: "qa" as const,
      target: "src/orchestrator/gate3Qc.ts",
      change_summary: "冒頭音声をGate 3で確認する",
      verification: "後続案件のgate3-qc.jsonで確認する",
      source: {
        kind: "codex_automation" as const,
        workflow_id: "tsugite-learning-promotion-review",
        run_id: "automation-run-17"
      },
      decision: "pending" as const
    };
    const pending = record("proposal-1", "recurring", { promotion_proposal: proposal });
    const approved = record("proposal-2", "recurring", {
      created_at: "2026-07-17T00:00:04.000Z",
      promotion_proposal: {
        ...proposal,
        decision: "approved",
        decided_at: "2026-07-17T00:00:04.000Z",
        decided_by: "human"
      }
    });
    const aggregate = aggregateFeedback([
      { projectId: "a", projectName: "Project A", entries: [pending, approved] }
    ]);

    expect(aggregate.preferences[0]?.promotionProposal).toMatchObject({
      projectId: "a",
      projectName: "Project A",
      decision: "approved",
      decidedBy: "human",
      source: {
        kind: "codex_automation",
        workflowId: "tsugite-learning-promotion-review",
        runId: "automation-run-17"
      }
    });

    const promoted = record("proposal-3", "promoted", {
      created_at: "2026-07-17T00:00:05.000Z",
      promotion: { kind: "qa", target: "src/orchestrator/gate3Qc.ts" }
    });
    const promotedAggregate = aggregateFeedback([
      { projectId: "a", projectName: "Project A", entries: [pending, approved, promoted] }
    ]);
    expect(promotedAggregate.preferences[0]?.promotionProposal).toBeUndefined();
  });

  it("excludes conflicting key meanings and does not verify without promotion history", () => {
    const conflict = aggregateFeedback([
      { projectId: "a", projectName: "A", entries: [record("fb-a", "observed")] },
      { projectId: "b", projectName: "B", entries: [{ ...record("fb-b", "observed"), signal: "avoid" }] }
    ]);
    expect(conflict.preferences).toEqual([]);
    expect(conflict.issues[0]?.code).toBe("feedback.key_conflict");

    const unsupported = aggregateFeedback([
      { projectId: "a", projectName: "A", entries: [record("fb-v", "verified", { evidence: ["dist/run/gate3-qc.json"] })] }
    ]);
    expect(unsupported.preferences[0]?.stage).toBe("observed");
    expect(unsupported.metrics).toEqual({ observed: 1, recurring: 0, promoted: 0, verified: 0, issues: 1 });
    expect(unsupported.issues[0]?.code).toBe("feedback.promotion_history_missing");

    const outOfOrder = aggregateFeedback([
      { projectId: "a", projectName: "A", entries: [
        record("verified-first", "verified", {
          created_at: "2026-07-17T00:00:01.000Z",
          evidence: ["dist/run/gate3-qc.json"]
        }),
        record("promoted-later", "promoted", {
          created_at: "2026-07-17T00:00:02.000Z",
          promotion: { kind: "qa", target: "src/orchestrator/gate3Qc.ts" }
        })
      ] }
    ]);
    expect(outOfOrder.preferences[0]?.stage).toBe("promoted");
    expect(outOfOrder.metrics.verified).toBe(0);
    expect(outOfOrder.issues[0]?.code).toBe("feedback.promotion_history_missing");

    const promotedAgain = aggregateFeedback([
      { projectId: "a", projectName: "A", entries: [
        record("promoted-a", "promoted", {
          created_at: "2026-07-17T00:00:01.000Z",
          promotion: { kind: "qa", target: "src/orchestrator/gate3Qc.ts" }
        }),
        record("verified-a", "verified", {
          created_at: "2026-07-17T00:00:02.000Z",
          evidence: ["dist/run-a/gate3-qc.json"]
        }),
        record("promoted-b", "promoted", {
          created_at: "2026-07-17T00:00:03.000Z",
          promotion: { kind: "documentation", target: "docs/requirements.md" }
        })
      ] }
    ]);
    expect(promotedAgain.preferences[0]?.stage).toBe("promoted");
    expect(promotedAgain.preferences[0]?.summary).toBe("冒頭から音を入れる");
    expect(promotedAgain.metrics.verified).toBe(0);
    expect(promotedAgain.issues[0]?.code).toBe("feedback.promotion_history_missing");
  });
});

function record(
  id: string,
  stage: FeedbackRecord["stage"],
  extra: Partial<FeedbackRecord> = {}
): FeedbackRecord {
  return {
    schema_version: 1,
    id,
    created_at: `2026-07-17T00:00:0${id.endsWith("1") ? "1" : id.endsWith("2") ? "2" : "3"}.000Z`,
    ...base,
    stage,
    ...extra
  };
}

async function writeProjectConfig(path: string): Promise<void> {
  await writeFile(path, "slug: example\nmanifest: manifest.json\nedit:\n  backend: remotion\n");
}
