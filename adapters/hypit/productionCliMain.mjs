import { dirname, resolve } from "node:path";
import {
  acceptProduction,
  authorSources,
  approveProduction,
  exportProduction,
  feedbackProduction,
  inspectProduction,
  intakeReference,
  loadProductionState,
  planProduction,
  previewProduction,
  requestBuild,
  reviseProduction,
  setInstruction
} from "./orchestrator.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function flag(name) {
  return process.argv.includes(name);
}

const action = process.argv[2];
const productionRoot = resolve(arg("--production", process.cwd()));

async function main() {
  if (action === "intake") {
    const source = arg("--from");
    if (!source) throw new Error("usage: intake --from <file.mp4> --production <dir>");
    const state = await intakeReference(productionRoot, resolve(source), {
      production_id: arg("--production-id", "lab"),
      brief: arg("--brief"),
      instruction: arg("--instruction")
    });
    process.stdout.write(`${JSON.stringify({ ok: true, action, progress: state.ui, run: state.run }, null, 2)}\n`);
    return;
  }
  if (action === "instruction") {
    const state = setInstruction(productionRoot, arg("--text", ""));
    process.stdout.write(`${JSON.stringify({ ok: true, action, progress: state.ui }, null, 2)}\n`);
    return;
  }
  if (action === "author") {
    const state = authorSources(productionRoot, { wait: true });
    process.stdout.write(`${JSON.stringify({ ok: true, action, author: state.author, progress: state.ui }, null, 2)}\n`);
    return;
  }
  if (action === "plan") {
    const state = await planProduction(productionRoot);
    process.stdout.write(`${JSON.stringify({
      ok: state.plan?.status === 0 && state.check?.status === 0,
      action,
      cost: state.run.cost,
      connections: state.plan?.connections ?? [],
      plan_digest: state.run.plan_digest,
      progress: state.ui
    }, null, 2)}\n`);
    return;
  }
  if (action === "approve") {
    const state = approveProduction(productionRoot, {
      decision_id: arg("--decision-id", "human-1"),
      decision: arg("--decision", "approve-plan"),
      actor: arg("--actor", "human"),
      decided_at: new Date().toISOString()
    });
    process.stdout.write(`${JSON.stringify({ ok: true, action, approval: state.run.approval, progress: state.ui }, null, 2)}\n`);
    return;
  }
  if (action === "build") {
    const state = requestBuild(productionRoot, {
      confirmPaid: flag("--confirm-paid"),
      confirmLocalRender: flag("--confirm-local-render")
    });
    process.stdout.write(`${JSON.stringify({
      ok: state.run.build?.outcome === "pending" || state.run.build?.outcome === "complete",
      action,
      build: state.run.build,
      progress: state.ui
    }, null, 2)}\n`);
    return;
  }
  if (action === "status" || action === "inspect") {
    const state = inspectProduction(productionRoot, { buildId: arg("--build-id") });
    process.stdout.write(`${JSON.stringify({ ok: true, action, build: state.run.build, progress: state.ui }, null, 2)}\n`);
    return;
  }
  if (action === "accept") {
    const state = acceptProduction(productionRoot, { buildId: arg("--build-id") });
    process.stdout.write(`${JSON.stringify({ ok: true, action, accepted: state.run.accepted_build_ids, progress: state.ui }, null, 2)}\n`);
    return;
  }
  if (action === "export") {
    const state = exportProduction(productionRoot, {
      buildId: arg("--build-id"),
      output: arg("--output"),
      to: arg("--to")
    });
    process.stdout.write(`${JSON.stringify({ ok: true, action, export: state.export, progress: state.ui }, null, 2)}\n`);
    return;
  }
  if (action === "preview") {
    const state = previewProduction(productionRoot);
    process.stdout.write(`${JSON.stringify({ ok: true, action, preview: state.preview, progress: state.ui }, null, 2)}\n`);
    return;
  }
  if (action === "feedback") {
    const state = feedbackProduction(productionRoot, { actor: arg("--actor", "human"), text: arg("--text", "") });
    process.stdout.write(`${JSON.stringify({ ok: true, action, progress: state.ui }, null, 2)}\n`);
    return;
  }
  if (action === "review") {
    const { writeProductionReview } = await import("./productionReview.mjs");
    const loaded = loadProductionState(productionRoot);
    const review = writeProductionReview(productionRoot, loaded);
    process.stdout.write(`${JSON.stringify({ ok: true, action, review }, null, 2)}\n`);
    return;
  }
  if (action === "revise") {
    const state = reviseProduction(productionRoot, { instruction: arg("--text") });
    process.stdout.write(`${JSON.stringify({ ok: true, action, revision_count: state.run.revision_count, progress: state.ui }, null, 2)}\n`);
    return;
  }
  if (action === "show") {
    const state = loadProductionState(productionRoot);
    process.stdout.write(`${JSON.stringify({ ok: Boolean(state), action, state }, null, 2)}\n`);
    return;
  }
  if (action === "ui") {
    const { startAuthoringUi } = await import("./ui/server.mjs");
    startAuthoringUi({ productionRoot, port: Number(arg("--port", "8787")) });
    return;
  }
  throw new Error("usage: intake|instruction|author|plan|approve|build|status|inspect|accept|export|preview|feedback|review|revise|show|ui");
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

void dirname;
