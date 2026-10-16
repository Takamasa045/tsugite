import { dirname } from "node:path";
import { inspectGenerationReceipts } from "./receipts.js";
import { loadAdapterDefinition } from "./registry.js";
import { resolveGenerationConnection } from "../connections/registry.js";
import { billingApprovalDigest, loadGenerationBilling } from "./billing.js";
import { readBoundedRunJson } from "../../adapters/billing-store.mjs";
import { RECEIPT_LIMITS } from "../../adapters/receipt-protocol.mjs";
import { billingLabel, combineActualBilling } from "../../adapters/billing-contract.mjs";
import type { AdapterDefinition } from "./registry.js";
import type { Project } from "../project/schema.js";

export type NarrationStatus = {
  schema_version: 1;
  state: "inspect" | "retrieve" | "pinned" | "needs_quote" | "needs_approval" | "ready";
  reason: string;
  next_action: { id: string; label: string; command?: string };
  can_generate: boolean;
  can_resume: boolean;
  approval_digest: string | null;
  billing_label: string;
  actual_label: string;
  quote_expires_at: string | null;
  submission_increment: 0 | null;
  requests: Array<{ request_id: string; state: string; [key: string]: unknown }>;
};

/** Shared local-only read model. It is not included in Gate/input digests. */
export async function readNarrationStatus(configPath: string, project: Project, adapter: AdapterDefinition | undefined, runDir: string): Promise<NarrationStatus | undefined> {
  if (adapter?.receipts?.protocol !== "narration-v1") return undefined;
  const receipts = await inspectGenerationReceipts(adapter, project.generation?.requests ?? [], runDir);
  let state;
  try { state = await readBoundedRunJson(runDir, "state.json"); } catch { /* Missing or malformed approval stays unapproved. */ }
  const gate = state?.gates?.gate_1;
  const approval = state?.run_id === (project.run_id ?? project.slug) && gate?.decision_source === "human" && gate?.status === "approved" && /^[a-f0-9]{64}$/.test(gate.approved_input_digest ?? "") ? gate.approved_input_digest : null;
  const billing = await loadGenerationBilling(configPath, project, adapter, dirname(runDir)), expires = billing?.estimate.quotes?.map(q => q.expires_at).sort()[0] ?? null;
  const known = billing?.estimate.status === "known" && Boolean(billing.estimate.context_digest) && expires !== null && Date.parse(expires) > Date.now();
  const requests = receipts.requests;
  const actual = combineActualBilling(requests.flatMap(r => "billing" in r ? [r.billing] : []));
  const base = { actual_label: billingLabel(actual, true), schema_version: 1 as const, approval_digest: approval, billing_label: billingLabel(billing), quote_expires_at: expires,
    submission_increment: null, can_generate: false, can_resume: false, requests };
  const inspect = requests.find(r => ["unknown", "submitting", "failed"].includes(r.state) || ("gate_approval_digest" in r && r.gate_approval_digest !== null && r.gate_approval_digest !== approval));
  if (inspect) return { ...base, state: "inspect", reason: "送信結果または処理記録を安全に照合できません。料金が発生している可能性があるため再送を止めています。", next_action: { id: "inspect_record", label: "元の処理記録を確認" } };
  const exhausted = requests.find(r => ["accepted", "succeeded"].includes(r.state) && "budgets" in r && r.budgets && (
    (r.state === "accepted" && (r.budgets.polls_used >= RECEIPT_LIMITS.polls || r.budgets.wait_ms_used >= RECEIPT_LIMITS.wait_ms)) || r.budgets.downloads_used >= RECEIPT_LIMITS.downloads || r.budgets.refreshes_used >= RECEIPT_LIMITS.refreshes));
  if (exhausted) return { ...base, state: "inspect", reason: "同じ処理の照会・取得予算に達しました。再起動しても予算は戻りません。", next_action: { id: "inspect_record", label: "providerの処理記録を確認" } };
  const retrieve = requests.some(r => ["accepted", "succeeded"].includes(r.state));
  if (retrieve) return { ...base, state: "retrieve", submission_increment: 0, can_resume: Boolean(approval),
    reason: "受理済みの音声があります。同じ処理を照会・取得します。新しい生成は開始しません。",
    next_action: { id: "resume", label: "同じ処理の結果を取得", command: "node bin/pipeline resume --config <project.yaml> --apply --actor coordinator" } };
  if (requests.length > 0 && requests.every(r => r.state === "pinned")) return { ...base, state: "pinned", submission_increment: 0, can_resume: Boolean(approval),
    reason: "音声を保存済みです。技術QAと、人による聴取確認を分けて確認してください。",
    next_action: { id: state?.status === "running" ? "resume" : "review_audio", label: state?.status === "running" ? "保存済み素材からQCを再構築" : "Gate 2で音声を聴いて確認", ...(state?.status === "running" ? { command: "node bin/pipeline resume --config <project.yaml> --apply --actor coordinator" } : {}) } };
  if (!known) return { ...base, state: "needs_quote", reason: "生成料金が未確認か、見積の有効期限が切れています。本文・声・モデル・数量と送信先を確認してください。",
    next_action: { id: "quote", label: "送信内容と見積手順を確認", command: "node bin/pipeline quote --config <project.yaml>" } };
  if (!approval || billingApprovalDigest(billing) !== gate?.billing_approval_digest) return { ...base, state: "needs_approval", reason: "本文・声・モデル・数量・接続・費用をレビューし、Gate 1で人が承認してください。",
    next_action: { id: "review", label: "Gate 1のレビューを確認" } };
  return { ...base, state: "ready", can_generate: true, reason: "見積とGate 1承認があります。送信直前に接続・期限・承認をもう一度照合します。",
    next_action: { id: "generate", label: requests.some(r => r.state === "pinned") ? "未送信分だけ生成" : "承認した音声を生成" } };
}

export async function loadProjectGenerationAdapter(project: Project) {
  const id = project.generation?.adapter ?? (project.generation?.connection ? (await resolveGenerationConnection(project.generation.connection))?.adapter : undefined);
  return id ? loadAdapterDefinition(id).catch(() => undefined) : undefined;
}
