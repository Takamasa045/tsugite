# Contracts

この文書のschemaは実装契約であり、利用者へ直接YAMLを書かせるUI契約ではない。自然言語briefからagentとcompilerが作成し、人間には読みやすいreviewとして提示する。

## 1. 共通規則

- JSON互換、strict schema、未知field拒否を既定とする。
- `schema_version`はpayload schema、`revision`は同一entityの改訂番号を表す。
- SHA-256はcanonical JSONまたはraw bytesから計算する。日時、local absolute path、secretはdigest対象payloadに入れない。
- immutable contract / artifactは上書きしない。修正は新revision / 新artifactを作る。
- optional contractが無い状態と、解析できずunknownの状態を区別する。
- `not_applicable`を推測で設定しない。適用判定理由を記録する。
- source text、lyrics、dialogue、visible text、locked blockはbyte-for-byte保持する。

```ts
type TypedDigestRef = {
  kind: string;
  id: string;
  digest: Sha256;
};

type ContractFragmentRefV1 = {
  slot: "assets" | "identity-definition" | "music" | "lyrics" | "rules";
  contract_id: string;
  revision: number;
  kind: "whole" | "asset" | "subject" | "scene" | "section" | "beat" | "lyric-cue" | "rule";
  fragment_id: string;
  digest: Sha256;
};

type RouteIdentityV1 = {
  ir_model: string;
  provider_model: string;
  model_profile_digest: Sha256;
  connection_id: string;
  connection_digest: Sha256;
  adapter_id: string;
  transport: string;
  mode_binding: string;
  route_digest: Sha256;
};
```

各contractはcanonicalなfragment indexを生成する。fragment規則を証明できないschema / legacy inputは、安全側に`kind="whole"`だけを発行しwhole-contract invalidationとする。文字列pathの都合でfragment境界を推測しない。

## 2. ProductionContractV1

`project.yaml`とbriefからcompileするMissionのroot contract。

```ts
type ProductionContractV1 = {
  schema_version: 1;
  production_id: string;
  project: {
    slug: string;
    project_yaml_digest: Sha256;
  };
  objective: string;
  deliverables: Array<{
    id: string;
    kind: "video" | "audio" | "image" | "package";
    required: boolean;
    acceptance_summary: string;
  }>;
  constraints: {
    duration_ms?: number;
    aspect?: string;
    locale?: string;
    must_include: string[];
    prohibited: string[];
  };
  authority: {
    gate_1: "human";
    gate_2: "human-or-existing-safe-auto-pass";
    gate_3: "human";
    render: "explicit-human-command";
    publish: "explicit-human-command";
  };
  contract_slots: {
    assets: ContractRequirement;
    identity: ContractRequirement;
    music: ContractRequirement;
    lyrics: ContractRequirement;
  };
  limits: {
    max_tree_depth: number;      // v1 default 6
    max_nodes: number;           // v1 default 256
    max_parallel_pure_tasks: number; // v1 default 3
    max_effectful_tasks: 1;
  };
  created_from: {
    brief_digest: Sha256;
    compiler_version: string;
  };
  rule_set_digest: Sha256;
  root_digest: Sha256;
};

type ContractRequirement = {
  requirement: "required" | "optional" | "not_applicable";
  reason: string;
};
```

予算はrootの説明値だけで実行許可にしない。実際の費用承認はGateBundleのpricing bindingと、各GenerationJobApprovalBinding / RegenerationAttemptAuthorizationへ結合する。

## 3. ContractSetV1

optional contractをrootへ埋め込まず、active revisionの集合として参照する。

```ts
type ContractSetV1 = {
  schema_version: 1;
  production_id: string;
  revision: number;
  contracts: Array<{
    slot: "assets" | "identity-definition" | "music" | "lyrics";
    contract_id: string;
    contract_revision: number;
    artifact_id: string;
    digest: Sha256;
  }>;
  digest: Sha256;
};
```

Taskは必要なslot / fragmentだけをbindする。Lyrics timingの変更でIdentityやMusic解析をstaleにしないためである。

## 4. AssetContractV1

```ts
type AssetContractV1 = {
  schema_version: 1;
  contract_id: string;
  revision: number;
  assets: Array<{
    asset_id: string;
    kind: "video" | "image" | "audio" | "text" | "font" | "data";
    project_relative_path: string;
    sha256: Sha256;
    byte_size: number;
    media_evidence?: {
      mime: string;
      duration_ms?: number;
      streams_digest?: Sha256;
    };
    roles: string[];
    provenance: {
      source: "user" | "generated" | "licensed" | "project-created" | "unknown";
      note?: string;
      usage_confirmed: boolean | "unknown";
    };
    external_send: "allowed" | "forbidden" | "needs-human";
  }>;
  digest: Sha256;
};
```

`unknown` provenanceをAIが補完しない。pathはproject-relative regular fileだけを許可し、symlinkとproject escapeを拒否する。

## 5. Identity Definition / Verification

Identityはキャラクター、出演者、継続する声・場所がある場合だけ作る。

```ts
type IdentityDefinitionBaseV1 = {
  schema_version: 1;
  contract_id: string;
  revision: number;
  subjects: Array<{
    id: string;
    locked_blocks: {
      voice?: LockedText;
      appearance?: LockedText;
      manner?: LockedText;
    };
    variants: Array<{
      id: string;
      source_asset_id: string;
      asset_digest: Sha256;
    }>;
  }>;
  scenes: Array<{
    id: string;
    location_map?: LockedText;
    palette?: LockedText;
    wardrobe?: LockedText;
    props: string[];
    time_of_day?: string;
    screen_direction?: string;
    active_subjects: string[];
  }>;
  verification_requirements: {
    risk_class: "low" | "medium" | "high";
    conditions: Array<{
      condition_id: string;
      description: string;
      subject_ids: string[];
      variant_ids?: string[];
      scene_ids?: string[];
    }>;
    minimum_distinct_outputs: number;
    minimum_distinct_conditions: number;
  };
  definition_digest: Sha256;
  digest: Sha256;
};

type IdentityDefinitionContractV1 = IdentityDefinitionBaseV1 & (
  | {
      definition_status: "draft" | "awaiting_human";
      definition_confirmation?: never;
    }
  | {
      definition_status: "confirmed";
      definition_confirmation: HumanDecisionRef;
    }
);

type LockedText = { text: string; sha256: Sha256 };

type IdentityVerificationBaseV1 = {
  schema_version: 1;
  production_id: string;
  identity_definition_digest: Sha256;
  selected_output_refs: TypedDigestRef[];
  required_condition_ids: string[];
  evaluated_condition_ids: string[];
  evaluations: Array<{
    condition_id: string;
    output_refs: TypedDigestRef[];
    evidence_artifact_refs: TypedDigestRef[];
    result: "pass" | "drift" | "not-evaluable";
  }>;
  verification_subject_digest: Sha256;
  digest: Sha256;
};

type IdentityVerificationReportV1 = IdentityVerificationBaseV1 & (
  | {
      status: "verified";
      coverage_basis: "multiple-shots" | "multiple-conditions";
      distinct_output_count: number;
      distinct_condition_count: number;
      decision: HumanDecisionRef;
    }
  | {
      status: "residual-risk-accepted";
      risk_class: "low";
      residual_drifts: [string, ...string[]];
      acceptance_scope: string;
      decision: HumanDecisionRef;
    }
  | {
      status: "rejected";
      rejection_reasons: [string, ...string[]];
      decision: HumanDecisionRef;
    }
  | {
      status: "not-evaluable";
      blocking_reasons: [string, ...string[]];
      decision: HumanDecisionRef;
    }
);
```

固定文の人間確認はpre-Gate contract、生成結果の確認はpost-generation reportとして分ける。`definition_status="confirmed"`ではdecisionの`subject_digest`が`definition_digest`と一致しなければならない。definition確認だけでは結果をverified扱いにしない。

Verificationの不変条件:

- required conditionはconfirmed definitionの`verification_requirements.conditions`と一致し、report側で減らさない。
- `evaluated_condition_ids`はevaluationsのunique condition集合と一致する。
- `verified`はdefinitionのminimum coverageを満たし、かつdistinct outputまたはconditionが2以上である。単一output / 単一conditionだけではverifiedにしない。
- `residual-risk-accepted`はdefinitionのrisk classが`low`の場合だけ許し、非空のdrift一覧とacceptance scopeを必須にする。medium / highをreport側でlowへ下げない。
- `verification_subject_digest`はstatus、definition、selected outputs、requirements、evaluations、coverageまたはresidual riskを含み、decision自身とreport digestだけを除外して計算する。decisionの`subject_digest`はこれと一致させる。
- `not-evaluable`はGate 2のIdentity確認通過を意味しない。

shot / output変更はIdentityVerificationReportとGate 2 / 3をstaleにするが、definitionが不変ならGate 1のIdentity定義承認まで巻き戻さない。

## 6. MusicStructureContractV1

MVのmaster timelineの正本。H3の4–15秒clip timelineとは分離する。

```ts
type MusicStructureContractV1 = {
  schema_version: 1;
  contract_id: string;
  revision: number;
  master_audio: {
    asset_id: string;
    sha256: Sha256;
    duration_ms: number;
    sample_rate?: number;
    channels?: number;
  };
  analysis: {
    status: "analyzed" | "manual" | "imported" | "unknown";
    analyzer_id?: string;
    analyzer_version?: string;
    evidence_artifact_id?: string;
    confidence?: number;
  };
  tempo_map: Array<{
    id: string;
    start_ms: number;
    end_ms?: number;
    bpm: number;
    meter?: string;
    confidence?: number;
  }>;
  beat_markers: Array<{
    id: string;
    at_ms: number;
    kind: "beat" | "downbeat" | "accent" | "transition";
    bar?: number;
    beat?: number;
  }>;
  sections: Array<{
    id: string;
    label: string;
    start_ms: number;
    end_ms: number;
    musical_role?: string;
    energy?: number;
  }>;
  source_digest: Sha256;
  timing_digest: Sha256;
  digest: Sha256;
};
```

不明なBPM、section、beatを補完しない。`unknown`のままStory提案はできるが、beat-locked editはblockする。

## 7. LyricsContractV1

```ts
type LyricsSourceSpanV1 = {
  occurrence_id: string;
  start_utf8_byte: number;
  end_utf8_byte: number;
  text_digest: Sha256;
};

type UntimedLyricsCueV1 = {
  timing: "untimed";
  id: string;
  section_id?: string;
  source_span: LyricsSourceSpanV1;
  singer_ids: string[];
  use: Array<"caption-overlay" | "story-cue" | "generated-singing" | "audio-reference">;
};

type TimedLyricsCueV1 = {
  timing: "timed";
  id: string;
  section_id?: string;
  source_span: LyricsSourceSpanV1;
  start_ms: number;
  end_ms: number;
  singer_ids: string[];
  confidence?: number;
  word_timings?: Array<{
    source_span: LyricsSourceSpanV1;
    start_ms: number;
    end_ms: number;
  }>;
  use: Array<"caption-overlay" | "story-cue" | "generated-singing" | "audio-reference">;
};

type LyricsContractV1 = {
  schema_version: 1;
  contract_id: string;
  revision: number;
  language_bcp47: string;
  source: {
    asset_id?: string;
    canonical_text: string;
    text_digest: Sha256;
  };
  alignment_state: "unaligned" | "partial" | "complete";
  alignment_basis: "not-aligned" | "machine" | "human-reviewed" | "imported";
  cues: Array<UntimedLyricsCueV1 | TimedLyricsCueV1>;
  timing_digest: Sha256 | null;
  digest: Sha256;
};
```

cue本文を複製せず、UTF-8 byte boundaryを検証した`source_span`からcanonical sourceをlosslessに解決する。同じ歌詞が複数回現れる場合は`occurrence_id`で区別する。完全性と由来を一つのenumへ混ぜない。

整合行列:

| alignment state | basis | cue | timing digest |
| --- | --- | --- | --- |
| `unaligned` | `not-aligned`だけ | 全てuntimed | `null` |
| `partial` | machine / human-reviewed / imported | timedとuntimedが混在 | timed subsetとcue状態全体のdigest |
| `complete` | machine / human-reviewed / imported | 全てtimed | 全timingのdigest |

この組合せ以外はschema / semantic validationで拒否する。架空の時刻やsentinelを入れず、caption用歌詞をvideo modelのvisible textやsingingへ自動転用しない。

## 8. GenerationUnitContractV1

長尺MVのmaster timelineから、1回の動画生成へ渡す区間を固定する。MV requestでは必須で、例示YAMLだけにしない。

```ts
type GenerationUnitContractV1 = {
  schema_version: 1;
  kind: "mv-generation-unit";
  production_id: string;
  unit_id: string;
  ordinal: number;
  music_binding: {
    contract_id: string;
    revision: number;
    contract_digest: Sha256;
    timing_digest: Sha256;
    master_audio_digest: Sha256;
  };
  lyrics_binding?: {
    contract_id: string;
    revision: number;
    text_digest: Sha256;
    timing_digest: Sha256 | null;
  };
  program: {
    master_duration_ms: number;
    start_ms: number;
    end_ms: number;
    section_id?: string;
  };
  clip_duration_ms: number;
  beat_anchor_refs: ContractFragmentRefV1[];
  lyric_cue_refs: ContractFragmentRefV1[];
  audio_policy: "reuse-master" | "reference-only" | "native-generated" | "silent";
  reference_audio_binding?: {
    derived_asset_id: string;
    derived_asset_digest: Sha256;
    source_master_audio_digest: Sha256;
    source_start_ms: number;
    source_end_ms: number;
  };
  route: RouteIdentityV1;
  digest: Sha256;
};
```

GenerationUnitはmaster timeline側の入力契約であり、VideoPromptIrやcompilationを逆参照しない。lineageは`GenerationUnit → VideoPromptIrV2 → CompilationArtifact → GateBundle`の一方向とし、unit digestとIR digestの循環参照を禁止する。

hard invariants:

- `0 <= start_ms < end_ms <= master_duration_ms`
- `end_ms - start_ms == clip_duration_ms`
- beat / lyric cueはbound contract revisionに存在し、unit区間に属する
- `reference-only`の音声はunit区間から作ったpin済みderived assetへbindし、master全体を暗黙送信しない
- lyrics timing digestが`null`、または参照cueがuntimedなら、exact syncを要求するunitは実行不可。story cueなど時刻不要の参照まで捏造時刻で埋めない
- `ordinal`、unit digest、route、compilation digestの順序をGateBundleへbindする

## 9. TaskTreeSpecV1

```ts
type TaskTreeSpecV1 = {
  schema_version: 1;
  production_id: string;
  tree_revision: number;
  root_node_id: string;
  nodes: Array<MissionNodeV1 | TaskNodeV1>;
  digest: Sha256;
};

type MissionNodeV1 = {
  node_type: "mission";
  node_id: string;
  parent_id?: string;
  aggregation:
    | { kind: "all" }
    | { kind: "ordered" }
    | { kind: "bounded_map" }
    | { kind: "choose_one"; selection: "human-branch-selection" };
  child_ids: string[];
};

type TaskNodeV1 = {
  node_type: "task";
  node_id: string;
  parent_id: string;
  kind: string;
  role: RoleId;
  effect:
    | "read"
    | "propose"
    | "local-write"
    | "external-observe"
    | "external-submit"
    | "paid"
    | "render"
    | "gate";
  dependencies: string[];
  required_contract_fragments: ContractFragmentRefV1[];
  required_artifacts: TypedDigestRef[];
  output_schema: string;
  risk_class: "low" | "medium" | "high";
  invalidation_tags: string[];
};

type BranchSelectionV1 = {
  schema_version: 1;
  production_id: string;
  mission_node_id: string;
  candidate_artifact_refs: TypedDigestRef[];
  selected_artifact_ref: TypedDigestRef;
  decision: HumanDecisionRef;
  digest: Sha256;
};

type SeriesProductionGraphV1 = {
  schema_version: 1;
  series_id: string;
  child_productions: Array<{
    production_id: string;
    production_contract_digest: Sha256;
    gate_scope_id: string;
    budget_scope_id: string;
  }>;
  dependencies: Array<{ before: string; after: string }>;
  digest: Sha256;
};
```

`bounded_map`はcontractに列挙済みのsection / scene / shotだけを展開する。`choose_one`はBranchSelectionV1の人間decisionなしに完了できず、最初に完成した枝を自動採用しない。TaskTreeは1 Production / 1 Gate / 1 budget scopeに限定する。シリーズは別Productionの参照graphで表し、子作品のGateや予算を共有しない。roleやTask自身は子nodeを追加できない。

## 10. ArtifactEnvelopeV1

```ts
type ArtifactEnvelopeV1<T> = {
  schema_version: 1;
  artifact_id: string;
  kind: string;
  production_id: string;
  tree_revision: number;
  node_id: string;
  task_revision: number;
  attempt_id: string;
  producer_role: RoleId;
  input_refs: TypedDigestRef[];
  contract_bindings: ContractFragmentRefV1[];
  parent_artifact_ids: string[];
  payload: T;
  payload_digest: Sha256;
  created_at: string;
  envelope_digest: Sha256;
};
```

`envelope_digest`はそのfield自身を除くcanonical envelopeから計算する。保存順は `artifact create-only → event append → state CAS`。eventに参照されない孤立artifactはresume時に採用しない。

## 11. RevisionIntentV1

Criticは問題を複数列挙できるが、active revision intentは一度に一つとする。

```ts
type RevisionIntentV1 = {
  schema_version: 1;
  revision_intent_id: string;
  source_critique_artifact_id: string;
  target_node_id: string;
  change_class:
    | "local-technical"
    | "parameter-tune"
    | "mutable-prompt-block"
    | "visual-plan"
    | "story"
    | "identity"
    | "music-timing"
    | "lyrics-text"
    | "lyrics-timing"
    | "asset"
    | "model-connection";
  changed_paths: string[];
  expected_stale_nodes: string[];
  rationale: string;
  proposed_by: "critic";
  digest: Sha256;
};
```

## 12. Recovery Authorization Contracts

回復を、無課金local permitと、人間がGate 1で事前承認した有償regenerationに分ける。

### 12.1 LocalRecoveryPermitV1

Coordinatorが現在contextを照合して都度発行する。人間承認は不要だが、別task / revision / jobへ再利用できない。

```ts
type LocalRecoveryPermitV1 = {
  schema_version: 1;
  permit_id: string;
  production_id: string;
  tree_revision: number;
  node_id: string;
  task_revision: number;
  input_digest: Sha256;
  action:
    | "rerun-pure-task"
    | "revalidate"
    | "rebuild-same-input-artifact"
    | "resume-known-job-poll"
    | "retry-verified-download";
  known_job?: {
    generation_job_id: string;
    provider_job_id: string;
    connection_id: string;
    connection_digest: Sha256;
  };
  issued_by: "coordinator";
  issued_at: string;
  expires_at: string;
  max_attempts: number;
  max_new_submissions: 0;
  max_new_credits: 0;
  digest: Sha256;
};
```

poll / download actionは`known_job`必須。resume時にtree、task、input、job、connectionのいずれかが変わればpermitを再発行せず停止する。

### 12.2 RegenerationPolicySpecV1 / Grant

低リスク再生成を許す**任意の人間事前承認**は二段階にする。まずGateBundleがpolicy specをbindし、そのGate 1 decisionからだけ実行grantを発行する。

```ts
type RegenerationPolicySpecV1 = {
  schema_version: 1;
  policy_spec_id: string;
  execution_context: {
    production_contract_digest: Sha256;
    contract_set_digest: Sha256;
    task_tree_digest: Sha256;
    task_scope: string[];
    base_compilations: Array<{ node_id: string; compilation_digest: Sha256 }>;
    route: RouteIdentityV1;
    pricing_binding_digest: Sha256;
  };
  allowed_error_codes: string[];
  allowed_prompt_block_ids: string[];
  allowed_parameter_ranges: Record<string, { min?: number; max?: number; values?: string[] }>;
  max_changed_prompt_blocks_per_attempt: 1;
  max_attempts_per_task: number;
  max_total_new_submissions: number;
  max_incremental_credits: number;
  expires_at: string;
  digest: Sha256;
};

type RegenerationGrantV1 = {
  schema_version: 1;
  grant_id: string;
  policy_spec_digest: Sha256;
  gate_bundle_digest: Sha256;
  gate_1_decision: HumanDecisionRef;
  execution_context_digest: Sha256;
  issued_at: string;
  expires_at: string;
  digest: Sha256;
};

type RegenerationAttemptAuthorizationV1 = {
  schema_version: 1;
  grant_digest: Sha256;
  node_id: string;
  ordinal: number;
  attempt_key: Sha256;
  trigger_failure_ref: TypedDigestRef;
  observed_error_code: string;
  base_compilation_digest: Sha256;
  patch_artifact_digest: Sha256;
  changed_prompt_block_id?: string;
  parameter_changes: Record<string, unknown>;
  derived_compilation_digest: Sha256;
  pricing_binding_digest: Sha256;
  credit_ledger_reservation_id: string;
  credit_ledger_reservation_digest: Sha256;
  digest: Sha256;
};
```

policy内のpatchから決定的に作られた`derived_compilation_digest`は、base compilationを置換せずAttemptAuthorizationに連結する。この証明が有効な範囲だけGate 1 decisionを維持できる。TaskTree、base compilation、許可block、parameter範囲、route、price basis、契約digestの変更、またはpolicy外patchはGate 1をstaleにする。

禁止:

- `submission_unknown`の再送
- model / connection / route / price basisの変更
- Identity、Story、Music、Lyrics本文の変更
- Gate / render / publish / finalize
- 上限超過、digest drift、未知errorからの継続

RegenerationPolicySpecの明示opt-inと有効なGrantが無い案件の自動再生成回数は0。

## 13. Learning Contracts

LearningCandidate、LearningExperiment、PromotionProposal、rule revisionの正本は[learning-loop.md](./learning-loop.md)とする。

- candidate / experiment / proposalはimmutable artifactである。
- `validated`と`approved`を分ける。
- shared ruleのactive化はHumanDecisionRefを必須とする。
- pending proposalはTask入力や自動recovery policyへ使わない。
- applied rule revisionだけをProductionContractの`rule_set_digest`へbindする。

## 14. GateBundleV1

Gate 1はplan本文だけでなく、実行に影響するdigestを結合する。

```ts
type GateBundleV1 = {
  schema_version: 1;
  production_id: string;
  run_id: string;
  production_contract_digest: Sha256;
  contract_set_digest: Sha256;
  task_tree_digest: Sha256;
  selected_artifact_digests: Sha256[];
  composition_intent_digest?: Sha256;
  generation_batches: Array<{
    batch_id: string;
    route: RouteIdentityV1;
    ordered_units: Array<{
      ordinal: number;
      generation_unit_digest: Sha256;
      base_compilation_digest: Sha256;
      program_start_ms?: number;
      program_end_ms?: number;
    }>;
    pricing: {
      status: "known" | "unknown" | "not-applicable";
      version: string | null;
      currency: string | null;
      amount: number | null;
      max_amount: number | null;
    };
    pricing_binding_digest: Sha256;
    estimated_credits?: number; // advisory only
    regeneration_policy_spec_digest?: Sha256;
  }>;
  review_artifact_digest: Sha256;
  digest: Sha256;
};
```

1 batchは同一RouteIdentityだけを許し、routeが異なるunitは別batchへ分ける。MVでは`ordered_units`とpre-Gateの`composition_intent_digest`が必須で、unitの曲中区間、順序、cue、route、base compilation、配置意図を承認へ固定する。生成後のartifact選択を解決したCompositionPlanはGate 2 subjectへbindする。

`pricing`は既存generation jobのpricing schemaと同じbasisを使い、`status`、`version`、`currency`、`max_amount`をapprovalへbindする。`estimated_credits`は比較指標に限り、価格承認の代替にしない。unknown priceを含むbundleは承認済み実行へ進めない。

bound digest変更は原則Gate 1をstaleにする。唯一の例外は、GateBundleに含まれるRegenerationPolicySpecから有効なAttemptAuthorizationを通じて派生したcompilationである。派生artifactはbase compilationを置換せず、policy外変更は必ずGate 1をstaleにする。

## 15. Generation Job Approval / Completion Binding

```ts
type GenerationJobApprovalBindingV1 = {
  production_id: string;
  run_id: string;
  node_id: string;
  attempt_id: string;
  generation_job_id: string;
  approval_observed_revision: number;
  approval_digest: Sha256; // existing Gate 1 approved_input_digest
  gate_bundle_digest: Sha256;
  gate_1_decision_digest: Sha256;
  request_digest: Sha256;
  compilation_digest: Sha256;
  route: RouteIdentityV1;
  pricing_binding_digest: Sha256;
  regeneration_attempt_authorization_digest?: Sha256;
  immutable_identity_digest: Sha256;
};

type GenerationCompletionRefV1 = {
  production_id: string;
  run_id: string;
  node_id: string;
  attempt_id: string;
  generation_job_id: string;
  pinned_revision: number;
  immutable_identity_digest: Sha256;
  artifact_sha256: Sha256;
  artifact_byte_length: number;
  verification_digest: Sha256;
  digest: Sha256;
};
```

generation job stateを複製しない。revisionはsubmit / poll / verify / pinで単調増加してよい。各観測時にrevisionが後退していないことと、production / run / Gate / request / approval / compilation / route / pricing / optional regeneration authorizationから作る`immutable_identity_digest`が不変なことを検証する。base compilation以外のderived compilationでは`regeneration_attempt_authorization_digest`を必須とし、Authorizationのattempt key、failure、error code、reservation、derived compilationと一致させる。`pinned`到達後にcreate-only CompletionRefを作り、approval bindingとCompletionRefの両方が一致する場合だけtask acceptedにできる。

## 16. HumanDecisionRef

```ts
type HumanDecisionRef = {
  decision_id: string;
  decision: string;
  actor: string;
  decided_at: string;
  subject_digest: Sha256;
  reason?: string;
};
```

actor文字列だけを権限証明にしない。CLI / UIの既存承認経路とsubject digest照合を必要とする。
