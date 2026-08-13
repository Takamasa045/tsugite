# Runtime and Recovery

## 1. 新規control plane

既存`src/orchestrator`を一度に置換せず、その上に`src/productionControl/`を追加する。

```text
src/productionControl/
├── schema.ts
├── contractCompiler.ts
├── taskTreeCompiler.ts
├── reducer.ts
├── events.ts
├── store.ts
├── artifactStore.ts
├── dependencyIndex.ts
├── invalidation.ts
├── dispatcher.ts
├── authorityGuard.ts
├── recovery.ts
├── resume.ts
├── gateBundle.ts
├── generationBridge.ts
├── metrics.ts
└── publicProjection.ts
```

既存run/Gate、generationJobs、videoPromptDirector、manifest/finalize、feedbackはleaf実行のtruthとして利用する。

既存run stateは次のcreate-only observationで参照し、control planeへ複製して編集しない。

```ts
type RunBindingV1 = {
  production_id: string;
  run_id: string;
  state_relative_path: string;
  observed_state_digest: Sha256;
  observed_status: RunStatus;
  observed_gate_input_digests: Partial<Record<"gate_1" | "gate_2" | "gate_3", Sha256>>;
  observed_at: string;
  digest: Sha256;
};
```

`state_relative_path`はdurable project内だけを許す。RunBindingは観測証拠であり、Gate承認や実行権限の代用ではない。state更新ごとに新しいbindingを作り、実行直前は必ずlive stateを再読する。GateBundleはmutableなstate digestを含めず、`production_id / run_id`と既存review approval subjectの中で結合する。

## 2. Single Writer

Coordinatorだけが次へ書ける。

- `coordination-state.json`
- `events.jsonl`
- Task acceptance / stale event
- artifact採用event
- Gate / job binding

role executorはartifact候補を返すだけで、store pathを受け取らない。Coordinatorは次を確認してから保存する。

1. invocation id / attempt key
2. expected role / output schema
3. input digest / tree revision
4. contract binding freshness
5. authority / effect class
6. payload digest
7. path / size / secret policy

## 3. Event Model

最低限のevent:

```ts
type ProductionEvent =
  | { type: "mission-created"; ... }
  | { type: "contract-revision-selected"; ... }
  | { type: "tree-compiled"; ... }
  | { type: "task-readied"; ... }
  | { type: "attempt-leased"; ... }
  | { type: "attempt-started"; ... }
  | { type: "artifact-created"; ... }
  | { type: "artifact-accepted"; ... }
  | { type: "attempt-failed-known"; ... }
  | { type: "attempt-outcome-unknown"; ... }
  | { type: "task-awaiting-human"; ... }
  | { type: "revision-intent-selected"; ... }
  | { type: "nodes-invalidated"; ... }
  | { type: "gate-binding-recorded"; ... }
  | { type: "generation-job-bound"; ... }
  | { type: "mission-completed"; ... };
```

`artifact-accepted`は少なくとも`expected_event_sequence`、`tree_revision`、`task_revision`、`input_digest`、`lease_digest`、`dependency_closure_digest`、`artifact_digest`を持つ。値を省略したaccept eventはschemaで拒否する。

共通field:

- `schema_version`
- `event_id`
- `production_id`
- `sequence`
- `previous_event_digest`
- `payload_digest`
- `created_at`
- `coordinator_instance_id`

sequence欠落、重複、逆順、previous digest不一致を拒否する。

## 4. State Snapshot

`coordination-state.json`はevent replayを高速化するprojection。

```ts
type CoordinationStateV1 = {
  schema_version: 1;
  production_id: string;
  revision: number;
  applied_event_sequence: number;
  applied_event_digest: Sha256;
  production_contract_ref: TypedDigestRef;
  contract_set_ref: TypedDigestRef;
  task_tree_ref: TypedDigestRef;
  node_states: Record<string, NodeState>;
  active_attempts: Record<string, AttemptLease>;
  active_revision_intent?: TypedDigestRef;
  gate_bindings: GateBindingProjection[];
  generation_bindings: GenerationBindingProjection[];
  metrics_revision: number;
};
```

snapshotだけからtruthを復元しない。起動時にevent tailをreplayし、既存Gate / job storeを再照合する。

## 5. Atomic Write / Crash Consistency

### artifact採用

artifact fileのcreateと、stateへのacceptを分ける。

1. temp pathへartifactを書く。
2. schema / digestを再読検証する。
3. create-only final pathへatomic renameする。
4. append lock内で最新event tailを再読し、最新stateをreduceする。
5. expected sequence、tree / task revision、input、lease、contract fragment、全dependencyがなお一致することを再検証する。
6. `artifact-created`と、期待値を持つ`artifact-accepted`を同じ直列化区間でappend / fsyncする。
7. state revision CASでsnapshotを更新する。

`nodes-invalidated`も同じappend lock / serial pointを使う。acceptance検証後からaccepted appendまでにinvalidationが割り込める実装を禁止する。不一致ならartifact fileは孤立証拠として残してacceptせず、新しいinputで別Attemptを作る。

crashした場合:

- step 3まで: orphan artifact。eventに無いため未採用。
- createdだけが記録されたlegacy / crash状態: resume時に最新dependency closureから再検証する。
- accepted append後: event replayでacceptedを復元。
- snapshotだけ失敗: eventから再構築。

### event append

append lock、file identity、sequence、fsync方針を既存durable storeと同等にする。symlink、path swap、foreign production idを拒否する。

## 6. Dispatcher

### 並行可能

- read-only分析
- pure compile / validate
- 独立したStory / Music / Visual proposal
- immutable artifact review

### 直列

- external submit
- paid generation
- Gate mutation
- render
- finalize
- 同じproject fileへのlocal write

既定:

- pure worker最大3
- effectful worker最大1
- 同じnode / attempt keyの二重lease禁止
- roleが新しいnodeをspawnすることは禁止

Task Treeの展開はallowlist済みtemplateから`TaskTreeCompiler`だけが行う。depth 6、node 256を初期上限とし、超過は人間へ分割提案を返す。

## 7. Attempt Lease

```ts
type AttemptLease = {
  lease_id: string;
  node_id: string;
  task_revision: number;
  attempt_key: Sha256;
  input_digest: Sha256;
  role: RoleId;
  effect: EffectClass;
  acquired_at: string;
  expires_at: string;
};
```

lease期限切れだけでeffectful taskを再実行しない。

- pure / read task: 同じinput digestで再実行可能。
- local write: journal / output identityを照合する。
- external observe: read-only照会を再開できる。
- external submit / paid: generation job truthを照合するまで`outcome_unknown`。
- render / Gate / finalize:既存stateとartifactを照合し、人間権限を再確認する。

## 8. Authority Guard

各Taskはeffect classを宣言し、実行前にauthorityを検査する。

| effect | 必須条件 |
| --- | --- |
| `read` / `propose` | schema-valid input |
| `local-write` | project-local path、Coordinator、journal |
| `external-observe` | connection allowlist、no submit |
| `external-submit` | Gate 1、approval digest、known price、Coordinator |
| `paid` | 上記 + budget binding |
| `render` | 明示command、Gate 2条件、Coordinator |
| `gate` | human decision subject digest |

Role resultがeffectを昇格させることはできない。

## 9. GenerationJobs Bridge

既存generationJobs state machineをそのまま使い、Task Attemptとbindingする。

### submit前

- job draftをdurable storeへ保存
- compilation digest
- Gate bundle digest
- connection / route digest
- estimated price / approved ceiling
- regeneration grant consumption
- request idempotency key

を確認する。

approval時点のproduction / run / GateBundle / Gate 1 decision / request / approval / compilation / RouteIdentity / pricingを`GenerationJobApprovalBindingV1.immutable_identity_digest`へ固定する。job recordのmutable revisionそのものは承認subjectに固定しない。

### submit後

- provider task idが返ったらjob stateへ保存してからpollする。
- provider IDがあるknown jobだけpoll / downloadを再開する。
- POST応答が不明なら`submission_unknown`。同じAttemptも新Attemptも再送しない。
- timeoutをprovider rejectionとみなさない。
- bounded GET / download retryだけを許す。
- `pinned`未満をArtifactEnvelopeへacceptedとしてbindしない。
- 各state更新でjob revisionが単調増加し、immutable identityが変わっていないことを確認する。
- `pinned`到達時はpinned revision、artifact SHA / size、verification digestを持つcreate-only `GenerationCompletionRefV1`を作る。

### human resolution

`submission_unknown`には次のresolution artifactを追加できる設計とする。

```ts
type SubmissionResolutionV1 = {
  job_id: string;
  observed_provider_task_id?: string;
  duplicate_search_basis: string;
  decision: "bind-known-job" | "mark-not-submitted" | "abandon";
  human_decision_ref: HumanDecisionRef;
};
```

`mark-not-submitted`後の新規submitも別Attempt / 新approval digestとして扱う。AI単独で決めない。

## 10. Invalidation Algorithm

1. 新contract / artifact revisionのchanged fragment digestを求める。
2. `DependencyIndex`で直接consumer nodeを列挙する。
3. accepted artifactを消さず、consumerを`stale`にする。
4. downstream consumerへ伝播する。
5. sibling branchは変更しない。
6. stale nodeを含むGate bundle / edit plan / final QAをstaleにする。
7. 新tree revisionを発行する。

invalidation resultをartifact化する。

```ts
type InvalidationReportV1 = {
  cause_refs: TypedDigestRef[];
  stale_node_ids: string[];
  preserved_node_ids: string[];
  stale_gate_bindings: string[];
  estimated_rework: { tasks: number; credits_at_risk: number | "unknown" };
  digest: Sha256;
};
```

Criticの推測だけでstale範囲を決めず、declared dependency graphから算出する。

## 11. Recovery

### local recovery

Coordinatorが現在のproduction / tree / task / input / known job / connectionへ結合したLocalRecoveryPermitV1を都度発行できた場合だけ、次を自動実行できる。

- pure task再実行
- 同一input artifact再build
- validation再実行
- known provider jobのpoll再開
- verified downloadのbounded retry

permitは期限とattempt上限を持ち、長期resume時に流用しない。poll / downloadは既知provider job idへ固定し、新規submitは常に0。

### bounded regeneration

GateBundleにRegenerationPolicySpecが含まれ、そのGate 1 decisionから発行したRegenerationGrantV1と、当該attempt用のRegenerationAttemptAuthorizationV1が有効な場合だけ、新規生成Attemptを起動できる。

- error codeがallowlist
- 対象nodeがscope内
- TaskTree、base compilation、model / connection / route / price basis不変
- Production / Identity / Music / Lyrics本文digest不変
- 変更block IDとparameterがpolicy allowlist内で、mutable block変更が1つ以下
- attempt / submission / incremental credit上限内
- previous submitがknown terminal state
- `submission_unknown`ではない

各Attempt前にcredit ledgerをatomic reserveし、trigger failure / error code、attempt key、patch artifact、base / derived compilation、pricing binding、reservation id / digestをAttemptAuthorizationへ結ぶ。job approval bindingはそのAuthorization digestをimmutable identityへ含める。base以外のcompilationにAuthorizationが無い、またはresume時にfailure / reservation / attempt keyが一致しない場合はsubmit / poll adoptionを停止する。submit失敗がknown non-submissionの場合だけ規定に従って戻す。課金成立が不明な場合は消費済みとして停止する。policy内のderived compilationだけがGate 1を維持し、それ以外のcompilation変更はGate 1をstaleにする。

### escalation

次で`awaiting_human`へ移る。

- grant無し、期限切れ、上限到達
- unknown error / price / capability
- digest drift
- model / connection変更が必要
- Identity / Story / Music / Lyrics変更
- policyで定めたattempt / elapsed saturation
- 複数prompt blockを同時変更する必要

## 12. Long-horizon Resume

再開処理:

1. production rootのrealpath / identityを確認する。
2. ProductionContract / ContractSet / TaskTreeのdigestを検証する。
3. event chainをsequence順にreplayする。
4. snapshotとの差分を修復する。
5. 既存Gate stateを再読する。
6. generation jobをrevision付きで再読する。
7. H3 / video_prompt compilation manifestを検証する。
8. pinned mediaをSHA / MIME / ffprobeで再確認する。
9. expired leaseをeffect classごとにreconcileする。
10. safeなready taskだけqueueへ戻す。

再開でprompt、connection、model、budgetを再選択しない。sourceが変更されていればinvalidationへ進み、暗黙更新しない。

## 13. Gate Binding

### Gate 1

GateBundleV1のdigestを既存Gate approval subjectへ含める。変更時は原則Gate 1をstale化する。RegenerationPolicySpec内のderived compilationだけはAttemptAuthorizationを追加証拠として扱い、GateBundleのbase compilationを置換しない。

### Gate 2

```ts
type Gate2SubjectV1 = {
  gate_1_decision_digest: Sha256;
  gate_bundle_digest: Sha256;
  selected_generation_completion_digests: Sha256[];
  manifest_digest: Sha256;
  resolved_composition_plan_digest?: Sha256;
  identity_verification_report_digest?: Sha256;
  technical_qa_digest: Sha256;
  semantic_qa_digest?: Sha256;
  digest: Sha256;
};
```

現行条件を維持する。

- projectの明示opt-in
- credits 0
- generated asset 0
- QC issue 0
- semantic QA無し

階層化だけを理由にauto-pass範囲を広げない。

### Gate 3

```ts
type Gate3SubjectV1 = {
  gate_2_decision_digest: Sha256;
  gate_2_subject_digest: Sha256;
  final_artifact_sha256: Sha256;
  render_report_digest: Sha256;
  gate_3_qc_digest: Sha256;
  selected_branch_digest: Sha256;
  resolved_composition_plan_digest?: Sha256;
  digest: Sha256;
};
```

final artifact SHA、render report、Gate 3 QC、selected branch / resolved edit plan digestをbindする。re-renderはGate 3-only条件を満たす既存意味を維持し、story / lyrics / title / duration / branch選択変更をre-render扱いにしない。

### 失効cascade

| 変更 | Gate 1 | Gate 2 | Gate 3 | render / finalize |
| --- | --- | --- | --- | --- |
| GateBundle、Identity definition、TaskTree、route、price、pre-Gate composition intent | stale | stale | stale | 禁止 |
| policy外prompt / compilation変更 | stale | stale | stale | 禁止 |
| policy内derived compilation | 維持 | stale | stale | 再評価 |
| selected generation artifact / completion、manifest、Identity verification、resolved composition、technical / semantic QA | 維持 | stale | stale | 禁止 |
| Gate 2 decision / subject | 維持 | current decisionを再取得 | stale | 禁止 |
| final artifact、render report、Gate 3 QC、selected final branch | 維持 | 維持 | stale | finalize禁止 |

Gate 1 staleはGate 2 / 3へ必ず伝播する。render直前にcurrent Gate 1 / 2 subject digest、finalize直前にcurrent Gate 1 / 2 / 3 subject digestを再照合する。古いdecisionの存在だけで続行しない。

## 14. Finalize / Retention

完成宣言後も次を保持する。

- ProductionContract / active ContractSet
- selected TaskTree revision
- event log / final snapshot
- selected artifact chain
- metrics
- final run / manifest / QA / completion record
- feedback / learning result

削除候補は従来どおりsuperseded mediaのみ。contract、artifact JSON、events、metrics、QAをmedia cleanupへ含めない。

既存finalize preview / applyの`plan_digest`算出と照合条件は、legacy modeでもactive modeでも変えない。active modeでは`production_completion_digest`を別の追加フィールドとしてpreviewへ載せ、apply時に両方を照合する。production treeの情報を既存`plan_digest`へ混ぜたり、その意味を上書きしたりしない。

## 15. Security / Privacy

- prompt本文とraw provider responseをpublic projectionへ出さない。
- secretはschema、event、artifact、errorへ保存しない。
- absolute pathをartifact payloadへ保存しない。project-relative idを使う。
- untrusted role resultのpath、HTML、errorをescape / validateする。
- remote URL、redirect、private IP、DNS rebindingはconnection adapter側でfail closed。
- artifact / event / state pathはsymlinkとpath swapを拒否する。
- arbitrary role / task kind / output schemaをruntime入力から追加しない。

## 16. Recovery Acceptance Tests

- reducer deterministic replay
- event duplicate / gap / tamper rejection
- snapshot crash point全箇所からの復元
- orphan artifact不採用
- artifact validation直後のcontract revision切替でaccept拒否
- artifact acceptとnodes-invalidatedの全interleavingでstale artifact受理0
- expected event sequence / lease / dependency closure mismatch拒否
- sibling branch保存
- stale artifact受理拒否
- effectful lease expiry後の自動再実行禁止
- known job poll再開
- job revision増加を許しつつimmutable approval identity drift拒否
- `submission_unknown` no-resubmit
- LocalRecoveryPermitのtask / job / expiry drift拒否
- RegenerationGrant 0 / 1 /上限境界
- grant atomic consumption crash
- paid Authorizationのtrigger failure / error code / attempt key / reservation digestとjob binding不一致拒否
- policy内derived compilationだけGate 1維持
- model / connection / digest driftで停止
- Gate 1→2→3、Gate 2→3の失効cascade
- render / finalize直前subject digest mismatch拒否
- Identity confirmed decision / verification requirements / coverage / residual-risk subject digest不一致拒否
- finalizeがcontrol-plane recordを保持
