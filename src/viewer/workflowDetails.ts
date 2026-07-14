import type { ExecutionPlan } from "../orchestrator/plan.js";
import type { GateId, RunState } from "../orchestrator/state.js";
import type { Project } from "../project/schema.js";
import type {
  ViewerArtifactSnapshot,
  ViewerMediaPreview,
  ViewerWorkflowStatus
} from "./workflow.js";

export type ViewerWorkflowDetailItem = {
  label: string;
  description: string;
  reference?: string;
  facts?: string[];
};

export type ViewerWorkflowApprovalDetails = {
  subject: string;
  checkpoints: string[];
  decision: string;
  decidedAt?: string;
};

export type ViewerWorkflowNodeDetails = {
  purpose: string;
  activity: string;
  outcome: string;
  inputs: ViewerWorkflowDetailItem[];
  outputs: ViewerWorkflowDetailItem[];
  previews?: ViewerMediaPreview[];
  approval?: ViewerWorkflowApprovalDetails;
};

type DetailContext = {
  project: Project;
  plan: ExecutionPlan;
  stepName: string;
  status: ViewerWorkflowStatus;
  state?: RunState;
  artifacts: ViewerArtifactSnapshot;
};

const numberFormatter = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 3 });

export function createViewerNodeDetails(context: DetailContext): ViewerWorkflowNodeDetails {
  switch (context.stepName) {
    case "validate": return validationDetails(context);
    case "creative-review": return reviewDetails(context);
    case "gate-1": return gate1Details(context);
    case "assemble-manifest": return assemblyDetails(context);
    case "gate-2": return gate2Details(context);
    case "render": return renderDetails(context);
    case "gate-3": return gate3Details(context);
    case "completed": return completionDetails(context);
    default: return genericDetails(context);
  }
}

function validationDetails({ project, plan }: DetailContext): ViewerWorkflowNodeDetails {
  return {
    purpose: "制作開始前に、設定漏れや素材構成の矛盾を見つけるための工程です。",
    activity: "project.yamlと制作マニフェストの読み込み、および尺・素材・編集方法の整合性検証",
    outcome: `目標${seconds(plan.target_duration_seconds)}、${plan.clips.length}本の映像構成を制作工程へ渡せる状態にしました。`,
    inputs: [{
      label: "制作設計書",
      description: "映像の尺、素材、編集構成、使用する生成・編集ツールを定義したファイルです。",
      reference: project.manifest,
      facts: [
        `目標尺: ${seconds(plan.target_duration_seconds)}`,
        `映像クリップ: ${plan.clips.length}本`,
        `編集方法: ${toolName(plan.backend)}`
      ]
    }],
    outputs: [{
      label: "検証済みの制作計画",
      description: "必須設定と工程のつながりを確認し、後続作業へ進めると判断した結果です。",
      reference: "validate.result"
    }]
  };
}

function reviewDetails({ plan, artifacts, status }: DetailContext): ViewerWorkflowNodeDetails {
  const evidenceMessage = artifacts.reviewPresent
    ? "HTMLレビュー画面とレビュー用データを証跡として保存しました。"
    : status === "completed"
      ? "制作方針を確認済みとして後続工程へ進めました。ただし、今回の実行にはHTMLレビュー証跡が残っていません。"
      : "レビュー画面で制作方針を確認し、Gate 1へ進む準備をします。";
  return {
    purpose: "外部生成を始める前に、企画・演出・素材生成条件を人が読める形で確認する工程です。",
    activity: "完成尺、カット構成、生成方法、使用モデル、プロンプトのレビュー画面への整理",
    outcome: evidenceMessage,
    inputs: [{
      label: "検証済みの制作計画",
      description: "設定エラーがなく、制作へ進めることを確認した計画です。",
      reference: "validate.result",
      facts: [`完成予定: ${seconds(plan.target_duration_seconds)}`, `構成: ${plan.clips.length}カット`]
    }],
    outputs: [{
      label: "制作方針レビュー",
      description: "人が制作意図と外部生成条件を確認するためのレビュー内容です。",
      reference: artifacts.reviewPresent ? "review/index.html" : "creative-review.result",
      facts: [`レビュー証跡: ${artifacts.reviewPresent ? "保存済み" : "今回の実行には未保存"}`]
    }]
  };
}

function gate1Details(context: DetailContext): ViewerWorkflowNodeDetails {
  const { project, plan, artifacts } = context;
  const adapter = toolName(project.generation?.adapter ?? "生成エージェント");
  const requests = project.generation?.requests ?? [];
  const requestCount = requests.length || plan.clips.length;
  const decision = gateDecision("gate_1", context, `${adapter}による素材生成を開始できる状態にしました。`);
  const models = unique(requests.map((request) => request.model));
  const modes = unique(requests.map((request) => inputModeLabel(request.input_mode)));
  const creditSummary = artifacts.runLog
    ? `クレジット: 事前見積り${formatNumber(plan.estimated_credits)} / 実績${formatNumber(artifacts.runLog.actualCredits)}`
    : `事前見積りクレジット: ${formatNumber(plan.estimated_credits)}`;
  return {
    purpose: "外部サービスへの送信とクレジット消費を始める前に、人が制作方針を承認する工程です。",
    activity: "クリエイティブレビューを基にした、生成本数、使用モデル、入力画像、想定コストの確認",
    outcome: decision.decision,
    inputs: [{
      label: "クリエイティブレビュー",
      description: "企画、演出、カット構成、生成条件を承認判断できるようにまとめた内容です。",
      reference: artifacts.reviewPresent ? "review/index.html" : "creative-review.result",
      facts: [`生成予定: ${requestCount}本`, `完成予定: ${seconds(plan.target_duration_seconds)}`]
    }],
    outputs: [{
      label: "素材生成の開始判断",
      description: "外部生成サービスへ制作指示を送り、クレジットを消費してよいかという判断結果です。",
      reference: "gate-1.result",
      facts: [decision.decision]
    }],
    approval: {
      subject: `${adapter}で${requestCount}本の映像素材を生成する制作方針と、外部サービス実行によるクレジット消費`,
      checkpoints: [
        `完成予定は${seconds(plan.target_duration_seconds)}、生成予定は${requestCount}本`,
        `使用モデル: ${models.length ? models.join("、") : "未指定"}`,
        `生成方法: ${modes.length ? modes.join("、") : "未指定"}`,
        creditSummary,
        "プロンプトと参照素材が、企画意図・人物・衣装・画面方向の一貫性を満たしていること"
      ],
      ...decision
    }
  };
}

function assemblyDetails({ project, plan, artifacts, status }: DetailContext): ViewerWorkflowNodeDetails {
  const runLog = artifacts.runLog;
  const adapter = toolName(project.generation?.adapter ?? "生成エージェント");
  const requestCount = runLog?.requests.length ?? project.generation?.requests.length ?? 0;
  const facts = runLog
    ? [
        `素材数: ${runLog.assetCount}点`,
        `生成リクエスト: ${requestCount}件`,
        `実績クレジット: ${formatNumber(runLog.actualCredits)}`
      ]
    : [`生成予定: ${requestCount}件`, `見積りクレジット: ${formatNumber(plan.estimated_credits)}`];
  const outcome = runLog
    ? `${adapter}への${requestCount}件の生成依頼を完了し、映像・画像・音声を合わせて${runLog.assetCount}点の素材を制作マニフェストへ統合しました。`
    : status === "running"
      ? `${adapter}で素材を生成し、結果を制作マニフェストへまとめています。`
      : "素材生成と制作マニフェストへの統合を待っています。";
  return {
    purpose: "承認済みの方針に沿って素材を生成・収集し、編集で使える一式にまとめる工程です。",
    activity: `${adapter}への各カットの生成指示、戻った素材の命名・配置、制作マニフェストへの統合`,
    outcome,
    inputs: [{
      label: "承認済みの制作方針",
      description: "Gate 1で、人が外部生成の内容とクレジット消費を認めた判断です。",
      reference: "gate-1.result"
    }],
    outputs: [{
      label: "生成・収集済みの制作素材一式",
      description: "最終編集に使用する映像、参照画像、ナレーション、BGMなどをまとめたものです。",
      reference: "manifest.json / run-log.md",
      facts
    }]
  };
}

function gate2Details(context: DetailContext): ViewerWorkflowNodeDetails {
  const { plan, artifacts } = context;
  const qc = artifacts.gate2Qc;
  const assetCount = qc?.assetCount ?? artifacts.runLog?.assetCount ?? 0;
  const totalDuration = qc?.totalClipDurationSeconds ?? plan.total_clip_duration_seconds;
  const targetDuration = qc?.targetDurationSeconds ?? plan.target_duration_seconds;
  const durationDelta = qc?.durationDeltaSeconds ?? totalDuration - targetDuration;
  const backend = toolName(plan.backend);
  const decision = gateDecision("gate_2", context, `${backend}の最終編集へ進める状態にしました。`);
  const checkpoints = gate2Checkpoints(qc, totalDuration, targetDuration, durationDelta);
  return {
    purpose: "生成素材と構成が編集に耐えられるかを確認し、最終編集へ進めてよいか人が承認する工程です。",
    activity: "全素材の読み込みと、破損、尺、解像度、フレームレート、必要な音声の有無の自動検査",
    outcome: qc?.ok === false ? `自動検査で${qc.issues?.length ?? 0}件の問題を検出しました。${decision.decision}` : decision.decision,
    inputs: [{
      label: "生成済み素材と編集構成",
      description: "映像、画像、音声と、それらをどの順番・尺で編集するかを定義した制作一式です。",
      reference: "manifest.json / gate2-qc.json",
      facts: [`素材総数: ${assetCount}点`, `構成尺: ${seconds(totalDuration)}`, ...assetKindFacts(qc)]
    }],
    outputs: [{
      label: "最終編集への進行判断",
      description: "検査済みの素材と構成を編集エンジンへ渡してよいかという判断結果です。",
      reference: "gate-2.result",
      facts: [decision.decision]
    }],
    approval: {
      subject: `生成済み${assetCount}点の素材と${formatNumber(totalDuration)}秒の構成を、${backend}の最終編集へ渡すこと`,
      checkpoints,
      ...decision
    }
  };
}

function renderDetails({ plan, artifacts, status }: DetailContext): ViewerWorkflowNodeDetails {
  const qc = artifacts.gate3Qc;
  const outputName = fileName(qc?.outputPath) ?? "final.mp4";
  const facts = finalOutputFacts(qc, plan);
  const outcome = qc?.actual?.durationSeconds !== undefined
    ? `${outputName}を書き出しました。${seconds(qc.actual.durationSeconds)}、${qc.actual.width ?? qc.expected?.width ?? "?"}×${qc.actual.height ?? qc.expected?.height ?? "?"}、${formatNumber(qc.actual.fps ?? qc.expected?.fps ?? 0)}fpsの動画です。`
    : status === "running"
      ? `${toolName(plan.backend)}で最終動画を書き出しています。`
      : "Gate 2の承認後、最終動画を書き出します。";
  return {
    purpose: "承認済みの素材と構成を、視聴・納品できる一本の動画に仕上げる工程です。",
    activity: `映像、画像、ナレーション、BGM、効果音の${toolName(plan.backend)}による合成と、最終動画の書き出し`,
    outcome,
    inputs: [{
      label: "Gate 2で承認された制作一式",
      description: "素材の破損や尺の問題がなく、最終編集へ進めると判断された映像・画像・音声・構成です。",
      reference: "gate-2.result / manifest.json"
    }],
    outputs: [{
      label: "最終動画ファイル",
      description: "最終確認と納品に使用する、映像と音声を統合したMP4動画です。",
      reference: outputName,
      facts
    }]
  };
}

function gate3Details(context: DetailContext): ViewerWorkflowNodeDetails {
  const { plan, artifacts } = context;
  const qc = artifacts.gate3Qc;
  const outputName = fileName(qc?.outputPath) ?? "final.mp4";
  const decision = gateDecision("gate_3", context, "最終動画を承認し、納品可能な完成品として採用しました。");
  return {
    purpose: "書き出した動画の技術品質と視聴品質を確認し、完成品として採用するか人が判断する工程です。",
    activity: "再生時間、画面サイズ、fps、音声、黒画面、長い無音の検査と、最終動画の目視確認",
    outcome: qc?.ok === false ? `最終検査で${qc.issues?.length ?? 0}件の問題を検出しました。${decision.decision}` : decision.decision,
    inputs: [{
      label: "レンダリング済みの最終動画",
      description: "映像と音声を一本に統合し、最終検査へ提出された動画です。",
      reference: `${outputName} / gate3-qc.json`,
      facts: finalOutputFacts(qc, plan)
    }],
    outputs: [{
      label: "最終成果物の採用判断",
      description: "この動画を完成品として納品・公開に使用してよいかという最終判断です。",
      reference: "gate-3.result",
      facts: [decision.decision]
    }],
    approval: {
      subject: `${outputName}を納品可能な最終成果物として採用すること`,
      checkpoints: gate3Checkpoints(qc, plan),
      ...decision
    }
  };
}

function completionDetails({ project, artifacts }: DetailContext): ViewerWorkflowNodeDetails {
  const outputName = fileName(artifacts.gate3Qc?.outputPath) ?? "final.mp4";
  return {
    purpose: "すべての承認と品質検査が完了し、成果物を利用できる状態になったことを示します。",
    activity: "Gate 1の制作方針、Gate 2の素材・構成、Gate 3の最終動画に対する判断結果の集約",
    outcome: "すべてのGateとQCを通過し、最終動画を承認済みの完成品として確定しました。",
    inputs: [{
      label: "Gate 3の最終承認",
      description: "技術品質と視聴品質を確認し、最終動画を完成品として採用した判断です。",
      reference: "gate-3.result"
    }],
    outputs: [{
      label: "承認済みの最終動画",
      description: "制作工程と品質確認を完了し、納品・視聴に使用できる最終成果物です。",
      reference: outputName,
      facts: [`プロジェクト: ${project.slug}`, ...finalOutputFacts(artifacts.gate3Qc, undefined)]
    }]
  };
}

function genericDetails({ stepName, status }: DetailContext): ViewerWorkflowNodeDetails {
  const outcome = status === "completed"
    ? "この工程を完了し、結果を次の工程へ渡しました。"
    : status === "running"
      ? "現在、この工程を実行しています。"
      : "前工程の完了後に着手します。";
  return {
    purpose: `${stepName}で必要な処理を行い、次の工程へ渡すための工程です。`,
    activity: `${stepName}に必要な情報を受け取り、担当処理を実行します。`,
    outcome,
    inputs: [{ label: "前工程の結果", description: "この工程を始めるために必要な情報です。" }],
    outputs: [{ label: "工程の実行結果", description: "次の工程へ渡す処理結果です。" }]
  };
}

function gateDecision(
  gateId: GateId,
  context: DetailContext,
  approvedSummary: string
): Pick<ViewerWorkflowApprovalDetails, "decision" | "decidedAt"> {
  const gate = context.state?.gates[gateId];
  if (gate?.status === "approved") {
    return { decision: gateId === "gate_3" ? approvedSummary : `${gateLabel(gateId)}を承認し、${approvedSummary}`, ...(gate.updated_at ? { decidedAt: gate.updated_at } : {}) };
  }
  if (gate?.status === "awaiting_approval") {
    return { decision: "現在は未承認です。内容を確認して進行可否を判断してください。", ...(gate.updated_at ? { decidedAt: gate.updated_at } : {}) };
  }
  if (gate?.status === "revise") {
    return { decision: "修正が必要と判断されました。指摘内容を反映して再確認してください。", ...(gate.updated_at ? { decidedAt: gate.updated_at } : {}) };
  }
  if (gate?.status === "abort") {
    return { decision: "この工程で制作を中止する判断が行われました。", ...(gate.updated_at ? { decidedAt: gate.updated_at } : {}) };
  }
  return { decision: "まだ判断は行われていません。前工程の完了後に内容を確認してください。" };
}

function gate2Checkpoints(
  qc: ViewerArtifactSnapshot["gate2Qc"],
  totalDuration: number,
  targetDuration: number,
  durationDelta: number
): string[] {
  return [
    ...(qc?.assetKinds ? [`内訳: 映像${qc.assetKinds.clip}本・画像${qc.assetKinds.image}枚・音声${qc.assetKinds.audio}本`] : []),
    `構成尺${formatNumber(totalDuration)}秒は、目標${formatNumber(targetDuration)}秒との差が${formatNumber(Math.abs(durationDelta))}秒で許容範囲内`,
    "すべての映像・画像・音声を読み込め、破損や不足がないこと",
    "各映像の尺・解像度・fpsが制作マニフェストの指定と一致すること",
    qc?.ok === false ? `自動検査で${qc.issues?.length ?? 0}件の問題あり` : "自動検査の問題: 0件"
  ];
}

function gate3Checkpoints(
  qc: ViewerArtifactSnapshot["gate3Qc"],
  plan: ExecutionPlan
): string[] {
  const expected = qc?.expected;
  const actual = qc?.actual;
  return [
    `再生時間: 実測${seconds(actual?.durationSeconds ?? expected?.durationSeconds ?? plan.target_duration_seconds)} / 目標${seconds(expected?.durationSeconds ?? plan.target_duration_seconds)}`,
    `画面: ${actual?.width ?? expected?.width ?? "?"}×${actual?.height ?? expected?.height ?? "?"} / ${formatNumber(actual?.fps ?? expected?.fps ?? 0)}fps`,
    `音声: ${actual?.hasAudio === false ? "なし（要確認）" : "あり"}`,
    `黒画面の最長: ${seconds(qc?.content?.longestBlackSeconds ?? 0)}`,
    `無音の最長: ${seconds(qc?.content?.longestSilenceSeconds ?? 0)}`,
    qc?.ok === false ? `最終検査で${qc.issues?.length ?? 0}件の問題あり` : "最終検査の問題: 0件"
  ];
}

function finalOutputFacts(
  qc: ViewerArtifactSnapshot["gate3Qc"],
  plan: ExecutionPlan | undefined
): string[] {
  const actual = qc?.actual;
  const expected = qc?.expected;
  return [
    `再生時間: ${seconds(actual?.durationSeconds ?? expected?.durationSeconds ?? plan?.target_duration_seconds ?? 0)}`,
    `画面: ${actual?.width ?? expected?.width ?? "?"}×${actual?.height ?? expected?.height ?? "?"} / ${formatNumber(actual?.fps ?? expected?.fps ?? 0)}fps`,
    `音声: ${actual?.hasAudio === false ? "なし" : "あり"}`
  ];
}

function assetKindFacts(qc: ViewerArtifactSnapshot["gate2Qc"]): string[] {
  if (!qc?.assetKinds) return [];
  return [`内訳: 映像${qc.assetKinds.clip}本・画像${qc.assetKinds.image}枚・音声${qc.assetKinds.audio}本`];
}

function inputModeLabel(mode: string | undefined): string {
  if (mode === "image-to-video") return "参照画像から動画生成";
  if (mode === "text-to-video") return "テキストから動画生成";
  return "入力方法未指定";
}

function gateLabel(gateId: GateId): string {
  if (gateId === "gate_1") return "制作方針";
  if (gateId === "gate_2") return "素材と構成";
  return "最終動画";
}

function toolName(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatNumber(value: number): string {
  return numberFormatter.format(Number.isFinite(value) ? value : 0);
}

function seconds(value: number): string {
  return `${formatNumber(value)}秒`;
}

function fileName(path: string | undefined): string | undefined {
  return path?.split(/[\\/]/).filter(Boolean).at(-1);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
