const HUMAN_COMMANDS = new Set(["validate", "plan", "review", "doctor"]);

type IssueLike = {
  code?: string;
  message?: string;
  path?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asIssues(value: unknown): IssueLike[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      code: typeof record?.code === "string" ? record.code : undefined,
      message: typeof record?.message === "string" ? record.message : String(item),
      path: typeof record?.path === "string" ? record.path : undefined
    };
  });
}

export function softenIssueMessage(message: string, code = ""): string {
  const combined = `${code} ${message}`;
  if (/ENOENT|no such file|not found|ENOTDIR/i.test(combined)) {
    return `ファイルが見つかりません。パスを確認してください。`;
  }
  if (/Invalid input|invalid_type|invalid_enum|too_small|too_big|Required/i.test(combined)) {
    return `入力の形が正しくありません。設定の書き方を確認してください。`;
  }
  return message;
}

function commandLabel(command: string): string {
  if (command === "validate") return "検証（validate）";
  if (command === "plan") return "計画（plan）";
  if (command === "review") return "確認画面（review）";
  if (command === "doctor") return "環境確認（doctor）";
  return command;
}

function formatIssueLine(issue: IssueLike): string {
  const text = softenIssueMessage(issue.message ?? "", issue.code ?? "");
  const path = issue.path ? `（${issue.path}）` : "";
  return `  ・${text}${path}`;
}

function formatFailure(command: string | undefined, issues: IssueLike[]): string {
  const title = command ? `✗ ${commandLabel(command)}: できませんでした` : "✗ 実行できませんでした";
  const lines = issues.length > 0 ? issues.map(formatIssueLine) : ["  ・詳細は --json で確認してください。"];
  return [title, ...lines].join("\n");
}

function formatValidate(record: Record<string, unknown>, issues: IssueLike[]): string {
  const ok = record.ok === true;
  const lines = [ok ? "✓ 検証（validate）: 問題なし" : formatFailure("validate", issues)];
  if (ok && record.launcher_visible === true) {
    lines.push("  ランチャーに表示されます。");
  }
  if (ok && typeof record.launcher_project_root === "string") {
    lines.push(`  場所: ${record.launcher_project_root}`);
  }
  if (ok && issues.length > 0) {
    lines.push("  確認ポイント:");
    lines.push(...issues.map(formatIssueLine));
  }
  return lines.join("\n");
}

function formatPlan(record: Record<string, unknown>, issues: IssueLike[]): string {
  if (record.ok !== true) return formatFailure("plan", issues);
  const plan = asRecord(record.plan);
  const lines = ["✓ 計画（plan）: 作成しました"];
  if (typeof plan?.run_id === "string") lines.push(`  実行ID: ${plan.run_id}`);
  if (typeof plan?.estimated_credits === "number") {
    lines.push(`  予想される生成費用: ${plan.estimated_credits}`);
  }
  if (typeof plan?.total_clip_duration_seconds === "number") {
    lines.push(`  素材の合計尺: ${plan.total_clip_duration_seconds}秒`);
  }
  return lines.join("\n");
}

function formatReview(record: Record<string, unknown>, issues: IssueLike[]): string {
  if (record.ok !== true) return formatFailure("review", issues);
  const lines = ["✓ 確認画面（review）: 書き出しました"];
  if (typeof record.review_path === "string") lines.push(`  画面: ${record.review_path}`);
  if (record.gate_state === "unchanged") lines.push("  承認状態は変えていません。");
  return lines.join("\n");
}

function formatDoctor(record: Record<string, unknown>, issues: IssueLike[]): string {
  if (record.ok !== true) return formatFailure("doctor", issues);
  const lines = ["✓ 環境確認（doctor）: 問題なし"];
  const checks = Array.isArray(record.checks) ? record.checks : [];
  for (const check of checks) {
    const item = asRecord(check);
    if (!item) continue;
    const name = typeof item.name === "string" ? item.name : "check";
    lines.push(`  ${item.ok === true ? "✓" : "✗"} ${name}`);
  }
  return lines.join("\n");
}

export function formatHuman(payload: unknown): string {
  const record = asRecord(payload);
  if (!record) return JSON.stringify(payload, null, 2);

  const command = typeof record.command === "string" ? record.command : undefined;
  const issues = asIssues(record.issues);

  if (command && HUMAN_COMMANDS.has(command)) {
    if (command === "validate") return formatValidate(record, issues);
    if (command === "plan") return formatPlan(record, issues);
    if (command === "review") return formatReview(record, issues);
    if (command === "doctor") return formatDoctor(record, issues);
  }

  if (record.ok === false && issues.length > 0 && command && HUMAN_COMMANDS.has(command)) {
    return formatFailure(command, issues);
  }

  return JSON.stringify(payload, null, 2);
}
