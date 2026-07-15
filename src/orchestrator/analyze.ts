import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runCliAnalysisAdapter, type CliAnalysisRequestResult } from "../adapters/cliAnalysis.js";
import type { AdapterDefinition } from "../adapters/registry.js";
import type { Manifest } from "../manifest/schema.js";
import type { Project } from "../project/schema.js";
import type { Result } from "../types.js";
import { createEditorialProposal } from "./editorialProposal.js";

export type AnalysisArtifact = {
  schema_version: 1;
  run_id: string;
  slug: string;
  adapter: string;
  adapters: string[];
  input_digest: string;
  actual_credits: 0;
  api_used: false;
  network_used: false;
  results: Array<CliAnalysisRequestResult & { adapter: string }>;
};

export type AnalyzeProjectResult = {
  analysisPath: string;
  proposalPath: string;
  handoffPath: string;
  actualCredits: 0;
  apiUsed: false;
  networkUsed: false;
  resultCount: number;
};

export async function analyzeProject(
  configPath: string,
  project: Project,
  manifest: Manifest,
  adapterInput: AdapterDefinition | AdapterDefinition[] | undefined,
  stateDir?: string
): Promise<Result<AnalyzeProjectResult>> {
  if (!project.analysis || !adapterInput) {
    return {
      ok: false,
      issues: [{ code: "analysis.not_configured", message: "project.analysis and its adapter are required" }]
    };
  }
  const adapters = Array.isArray(adapterInput) ? adapterInput : [adapterInput];
  const adapterByName = new Map(adapters.map((adapter) => [adapter.name, adapter]));
  if (!Array.isArray(adapterInput)) {
    adapterByName.set(project.analysis.adapter, adapterInput);
  }

  const runId = project.run_id ?? project.slug;
  const distDir = stateDir ? resolve(stateDir) : resolve(dirname(resolve(configPath)), project.dist_dir);
  const runDir = join(distDir, runId);
  const analysisDir = join(runDir, "analysis");
  const analysisPath = join(analysisDir, "raw-analysis.json");
  const proposalPath = join(analysisDir, "editorial-proposal.json");
  const handoffPath = join(analysisDir, "agent-handoff.md");
  try {
    await mkdir(analysisDir, { recursive: true });
  } catch {
    return artifactWriteFailure();
  }

  const resultsByRequest = new Map<string, CliAnalysisRequestResult & { adapter: string }>();
  for (const adapterName of uniqueInOrder(
    project.analysis.requests.map((request) => request.adapter ?? project.analysis!.adapter)
  )) {
    const adapter = adapterByName.get(adapterName);
    if (!adapter) {
      return {
        ok: false,
        issues: [{ code: "analysis.adapter_not_loaded", message: `analysis adapter '${adapterName}' is not loaded` }]
      };
    }
    const requests = project.analysis.requests.filter(
      (request) => (request.adapter ?? project.analysis!.adapter) === adapterName
    );
    const executed = runCliAnalysisAdapter(adapter, requests, manifest, {
      runId,
      runDir,
      manifestDir: dirname(resolve(dirname(resolve(configPath)), project.manifest))
    });
    if (!executed.ok) return executed;
    for (const result of executed.results) {
      resultsByRequest.set(result.request_id, { ...result, adapter: adapter.name });
    }
  }
  const results = project.analysis.requests.map((request) => resultsByRequest.get(request.id)!);
  const selectedAdapterNames = uniqueInOrder(results.map((result) => result.adapter));

  const artifact: AnalysisArtifact = {
    schema_version: 1,
    run_id: runId,
    slug: project.slug,
    adapter: selectedAdapterNames[0]!,
    adapters: selectedAdapterNames,
    input_digest: inputDigest(project, results),
    actual_credits: 0,
    api_used: false,
    network_used: false,
    results
  };
  const proposal = createEditorialProposal(artifact);
  const nonce = `${process.pid}-${Date.now()}`;
  const temporaryAnalysisPath = `${analysisPath}.${nonce}.tmp`;
  const temporaryProposalPath = `${proposalPath}.${nonce}.tmp`;
  const temporaryHandoffPath = `${handoffPath}.${nonce}.tmp`;
  try {
    await writeFile(temporaryAnalysisPath, `${JSON.stringify(artifact, null, 2)}\n`);
    await writeFile(temporaryProposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    await writeFile(temporaryHandoffPath, renderAgentHandoff(artifact));
    await rename(temporaryHandoffPath, handoffPath);
    await rename(temporaryProposalPath, proposalPath);
    await rename(temporaryAnalysisPath, analysisPath);
  } catch {
    await Promise.allSettled([
      rm(temporaryAnalysisPath, { force: true }),
      rm(temporaryProposalPath, { force: true }),
      rm(temporaryHandoffPath, { force: true })
    ]);
    return artifactWriteFailure();
  }

  return {
    ok: true,
    issues: [],
    analysisPath,
    proposalPath,
    handoffPath,
    actualCredits: 0,
    apiUsed: false,
    networkUsed: false,
    resultCount: artifact.results.length
  };
}

function artifactWriteFailure(): Result<AnalyzeProjectResult> {
  return {
    ok: false,
    issues: [{
      code: "analysis.artifact_write_failed",
      message: "local analysis artifacts could not be written"
    }]
  };
}

function inputDigest(project: Project, results: Array<CliAnalysisRequestResult & { adapter: string }>): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        slug: project.slug,
        run_id: project.run_id ?? project.slug,
        analysis: project.analysis,
        sources: results.map((result) => ({ adapter: result.adapter, source: result.source }))
      })
    )
    .digest("hex");
}

function uniqueInOrder<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function renderAgentHandoff(artifact: AnalysisArtifact): string {
  return `# Local editorial analysis handoff

This handoff is local-only. Do not upload source media, use external APIs, or change the source files.

## Input

- analysis: raw-analysis.json
- proposal: editorial-proposal.json
- run_id: ${artifact.run_id}
- input_digest: ${artifact.input_digest}

## Agent task

1. Read the local analysis JSON.
2. Treat \`source_start\` / \`source_end\` as immutable positions in the original media.
3. Suggest filler removal, chapter titles, summaries, and concise captions as reviewable proposals.
4. Configure only intended removals under \`edit.editorial\` in project.yaml. Use \`remove_kinds\` or \`remove_ids\`, and use \`exclude_ids\` to keep false positives.
5. Select captions and chapters by analysis request ID. Do not rewrite source timestamps into output timestamps by hand.
6. Run \`review\` and inspect every item marked \`適用予定\`. Never approve Gate 1 on an unseen or mismatched review.
7. Keep the proposal backend-neutral so the approved EDL can render with the selected editing backend.

Only an explicit editorial policy plus Gate 1 approval allows \`run\` to write an edited manifest and editorial-edl.json. Source files remain immutable.
`;
}
