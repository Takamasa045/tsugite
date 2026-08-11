# Implementation Plan

この順番を実装時の正本とする。各Phaseは小さなPR単位へ分け、RED → GREEN → REFACTOR → full regression → independent reviewで進める。

## 0. 共通完了条件

各Phaseで必須:

- 対象schemaとinvariantを先にtest化
- legacy fixtureの意図しない差分0
- `npm run build`
- 対象test
- `npm run check`
- H3 / Gate / generation / pathを触る場合はadversarial test
- docsのstatusと実装path更新
- code変更後の独立review
- push / PR / release / provider traffic / Gate操作は別承認

## PO-0: Baseline Freeze

### 目的

現在のtruthをfixtureとgoldenで固定し、次期実装による見えないregressionを止める。

### 変更

- `test/fixtures/production-control/legacy/`
- legacy project / Gate / finalize / generation job / H3 artifact snapshot
- baseline metric field inventory
- current public Launcher DTO snapshot

### Tests

- existing `test/state.test.ts`
- `test/finalize*.test.ts`
- `test/generation-jobs.test.ts`
- `test/h3-director.test.ts`
- `test/video-prompt-director-*.test.ts`
- `test/viewer-launcher*.test.ts`

### Exit

- legacy挙動の固定hash一覧
- historical欠損fieldを`legacy_not_recorded`と定義
- current full check green

## PO-0A: Launcher 3D Visibility Repair

### 目的

現在発生している「右panelとtimelineは8工程を表示するが、中央3Dだけ空白」の退行を、control plane実装より先に修復する。

### 変更

- scene専用Error Boundary
- WebGL capability / first-frame / context-loss state
- 同じworkflow DTOを使う操作可能なDOM / SVG fallback
- viewer source version / bundle digest
- packaged Desktop bundle整合test
- failure class別のsanitized診断。特定のWebGL / GPU原因を証拠なしに固定しない

詳細契約は[launcher-and-visualization.md](./launcher-and-visualization.md)を正本とする。Mission Treeはまだ追加せず、現行8工程projectionで直す。

### Tests

- `WorkflowScene`をmockしないbrowser integration
- software WebGLでfirst-frameとnode hit targetを確認
- `getContext() === null`、initialization throw、`webglcontextlost`を注入
- fallbackからnodeをkeyboard選択し、SidePanel / TimelinePanelと同期
- raw error / path / prompt / secret非表示
- CLI generated viewerとpackaged runtimeのbundle version / digest照合
- CLI再build成功とは独立に、`resources/runtime/viewer/`をpackage fixtureで検証

### Exit

- 現行8工程fixtureで3Dが実際に見える
- 3Dを利用できない環境でも中央が空白にならず、8工程を操作できる
- scene failureがGate / workflow truthを変更しない
- current screenshot相当の退行を自動testが検出する

## PO-1: Contract / Store Foundation

### 目的

副作用なしのcontract、artifact、event、snapshot基盤をshadowで追加する。

### 新規module

```text
src/productionControl/
├── schema.ts
├── canonical.ts
├── artifactStore.ts
├── events.ts
├── eventStore.ts
├── reducer.ts
├── statePersistence.ts
└── errors.ts
```

### 実装順

1. strict Zod schema
2. canonical digest
3. create-only ArtifactStore
4. append-only event chain
5. pure reducer
6. snapshot CAS
7. crash recovery

### Tests

- schema unknown field / invalid enum / non-finite number
- digest determinism / object key order / array order
- symlink / path escape / leaf swap
- duplicate artifact
- event gap / duplicate / tamper
- 全write crash point
- artifact acceptとinvalidationの全interleaving
- expected sequence / input / lease / dependency closure mismatch
- deterministic replay

### Exit

- store単体でMission stateを再構築可能
- legacy orchestratorへ未接続
- 外部送信・Gate・render pathなし

## PO-2: ProductionContract / Task Tree

### 目的

brief / `project.yaml`から、必要contractとhierarchical taskを決定的に作る。

### 新規module

```text
src/productionControl/
├── contractCompiler.ts
├── contractRegistry.ts
├── taskTreeTemplates.ts
├── taskTreeCompiler.ts
├── dependencyIndex.ts
├── invalidation.ts
└── roleEnvelope.ts
```

### 既存接続

- `src/project/schema.ts`: optional `orchestration.mode`
- `src/orchestrator/plan.ts`: shadow summaryのみ
- `src/orchestrator/review.ts`: read-only tree section

### Tests

- same input → same tree / digest
- project type別optional contract判定
- cycle / unknown role / unknown kind拒否
- depth 6 / nodes 256 / bounded map
- canonical ContractFragmentRef / whole-contract fallback
- IdentityDefinition / VerificationReportの分離
- Phase A–E exact lock migrationとconfirmation / verification非推測
- `locked: true`単独でconfirmed / verifiedへ移行しない
- selected output / evidence / human decision不足時はVerificationReportを作らない
- Identity definition confirmed decision subject、required condition、multi-shot / multi-condition coverage
- residual-risk acceptanceはlow risk + 非空drift + scopeだけ
- Identity / Music / Lyrics fragment invalidation matrix
- choose-oneのHuman BranchSelection必須
- series child ProductionのGate / budget scope分離
- sibling preservation
- shadow outputがlegacy plan digestを変えない

### Exit

- shadow reviewでTask Treeが見える
- 実行はlegacyのみ
- Gate mutationなし

## PO-3: MV Contract Foundation

### 目的

master audio、beat / section、lyrics cue、caption / audio policyを第一級contractにする。

### 新規module

```text
src/productionControl/contracts/
├── asset.ts
├── identity.ts
├── music.ts
├── lyrics.ts
└── generationUnit.ts
src/productionControl/templates/mv.ts
src/productionControl/mv/timeline.ts
src/productionControl/mv/composition.ts
```

### 既存接続

- `src/project/schema.ts`: authoring refsのみ
- `src/manifest/schema.ts`: caption / chapter / master audio binding
- existing analyze adapters: evidence付き結果だけimport
- `knowledge/story-frameworks`: advisory selectionを参照

### Tests

- master audio hash / duration
- tempo change / unknown BPM
- section gap / overlap
- repeated lyric cue
- untimed / partial cueと架空timestamp拒否
- alignment state / basis / cue / timing digest整合行列の全組合せ
- Unicode / whitespace / line break
- caption-only lyricsがgeneration promptへ流れない
- Identity optional / required
- Chorus branchだけのinvalidation
- master audio変更で全timeline stale
- GenerationUnit欠落 / 誤順序 / 誤区間 / 誤cue
- clip-local reference audio derived asset
- track overlap / time transform / source-timeline尺差
- speed transformの正数・有限値、duration式、Intent / Plan不一致、frame量子化境界

### Exit

- 72秒歌詞MV fixtureがcontract → CompositionIntent → resolved CompositionPlanまでpure compile
- generation / renderなし

## PO-4: VideoPromptIrV2 / H3 Workflow v3

### 目的

H3とvideo_promptの二重compilerを一本化し、MV clip、exact text、budget、routeを安全にcompileする。

### 主な変更

```text
src/videoPromptDirector/schemaV2.ts
src/videoPromptDirector/upgradeV1.ts
src/videoPromptDirector/semanticBlocks.ts
src/videoPromptDirector/effectiveContract.ts
src/videoPromptDirector/compileV2.ts
src/videoPromptDirector/render/h3GrammarV3.ts
src/videoPromptDirector/adapterDialect.ts
src/videoPromptDirector/compilationBundle.ts
src/h3/*                         # compatibility export維持
```

### 実装順

1. v1 pure reader / upgrader
2. V2 neutral validation
3. semantic blocks
4. EffectiveGenerationContract
5. H3 grammar v3
6. adapter dialect
7. exact text / timeline / budget validation
8. atomic compilation bundle
9. lineage / compilation digest

### Tests

- legacy six-mode golden byte-identical
- V2 base / reference golden
- dialogue / singing / group singer / voiceover
- `<scenetrans>` / `<cutoff>`
- base top-level 3 sectionsとmode alignment位置
- grammar feature / source digest binding
- reserved delimiter exact-text拒否
- untimed lyrics cue拒否
- visible text editor/model分離
- gap / overlap / final end
- prompt budget soft / hard / unknownとlimit-1 / limit / limit+1
- freshness / profile / route contradiction
- hard / advisory claim分離
- canonical / adapter labels
- MV GenerationUnit / program binding
- mixed RouteIdentity batch拒否
- partial bundle / asset mutation
- h3 + video_prompt同時指定拒否

### Exit

- new V2 requestはsingle compilerのみ
- legacy requestはcompatibility authoringで同じoutput
- active pathの旧compiler invocation 0
- compilation digestを次Phaseへ渡せる

## PO-5: Gate Bundle / Execution Bridge

### 目的

hierarchical planを既存GateとgenerationJobsへ安全に接続する。

### 新規module

```text
src/productionControl/
├── gateBundle.ts
├── authorityGuard.ts
├── dispatcher.ts
├── generationBridge.ts
├── leases.ts
└── resume.ts
```

### 既存変更

- `src/orchestrator/review.ts`: GateBundle表示
- `src/orchestrator/stateTransitions.ts`: active modeのsubject digest bridge
- `src/generationJobs/schema.ts`: optional production binding → active modeで必須
- `src/generationJobs/approval.ts`: compilation / route digest結合
- `src/generationJobs/machine.ts`:既存no-resubmit維持

### Tests

- approval digest mismatch
- unknown price
- wrong model / connection / route
- batch内RouteIdentity混在拒否
- job revision増加とimmutable identity drift分離
- `submission_unknown` provider id有無
- pinned-only acceptance
- effectful task同時1
- lease expiry reconciliation
- Gate 1 stale propagation
- Gate 1→2→3 / Gate 2→3 cascade
- render / finalize直前subject digest再照合
- IdentityVerificationReport変更はGate 2 / 3だけstale
- Gate 2 existing auto-pass条件不変
- explicit render不変

### Exit

- fixture connectionでactive MissionをGate 1後のgeneration jobまで実行
- external DNS / provider trafficなし
- legacy project挙動不変

## PO-6: Recovery Controller

### 目的

local recoveryと明示opt-inの限定再生成を導入する。

### 新規module

```text
src/productionControl/recovery.ts
src/productionControl/revisionIntent.ts
src/productionControl/grantLedger.ts
```

### 実装順

1. LocalRecoveryPermitV1
2. CritiqueReport → one active RevisionIntent
3. grant ledger atomic reserve
4. no-credit local resume
5. fixture-only RegenerationPolicySpec / Grant / AttemptAuthorization
6. 実adapterへのbinding

### Tests

- grant無し自動生成0
- allowed / disallowed error code
- 1 mutable block上限
- attempt / submit / credit境界
- concurrent reserve
- crash後二重消費なし
- trigger failure / error code / attempt key / reservation digestをjob immutable identityへbind
- derived compilationでAuthorization欠落 / mismatch拒否
- digest drift停止
- `submission_unknown`停止
- saturation escalation
- base / derived compilationとpatch artifact結合
- policy内derived compilationだけGate 1維持
- permitのtask / job / connection / expiry drift停止

### Exit

- policy内だけbranch recovery
- 範囲外は無変更`awaiting_human`
- safety SLO 0

## PO-7: Learning / Launcher / Metrics / Finalize

### 目的

実験済みの学びだけを人間判断へ上げ、利用者が階層状態と効果を確認でき、完成記録がworktree削除後も残るようにする。

### 主な変更

```text
src/productionControl/publicProjection.ts
src/productionControl/metrics.ts
src/productionControl/learning/*
src/feedback/*                    # existing API bridge only
src/viewer/launcher.ts
apps/workflow-viewer/*
src/orchestrator/finalize.ts
src/orchestrator/finalizeApplyMutatingPromoteRecord.ts
```

### UI

- Mission Tree
- ready / running / stale / blocked / awaiting-human
- current Gate
- recovery attempt /上限
- human intervention / credit / branch reuse
- secret-free error codes

### Tests

- public DTO strict / no prompt / path / secret
- legacy fixed workflow view
- PO-0A scene state / DOM fallbackをactive treeでも共用
- active tree keyboard / focus / reduced motion / responsive
- stale cause representation
- metrics deterministic projection
- exact feedback key / semantic-advisory separation
- fixture / replay / shadow experiment
- validated proposalの無断適用拒否
- approved rule revisionだけを新Missionへbind
- finalize retention / preview digest
- durable projects home after worktree cleanup

### Exit

- Launcherでcurrent decisionが一目で分かる
- metric reportがbaseline比較可能
- 学習proposalが実験証拠と人間decisionを持つ
- finalizeがcontract / events / metricsを保持

## PO-8: Release Candidate

### 実証案件

最低限fixture / local mediaで次を通す。

1. legacy local edit
2. character multi-shot
3. lyric MV
4. concept MV without Identity
5. pause / resume
6. Chorus branch replacement
7. recovery grant exhaustion
8. `submission_unknown`

### Commands

```sh
npm run build
npm run test:coverage
npm run viewer:check
npm run viewer:build
npm run vendor:check
npm run check
```

Desktop変更がある場合だけ:

```sh
npm run desktop:test
npm run desktop:prepare
npm run desktop:audit
```

### Release更新

- package.json / package-lock.json
- CHANGELOG.md
- README.md
- onboarding / setup contract
- current implementation docs
- design status

### Stop Conditions

- main / target worktree dirty conflict
- unknown failing test
- safety SLO nonzero
- migration / rollback未検証
- Gate / cost / connection ambiguity
- H3 official source / profile freshness expired
- provider trafficが必要だが明示承認なし

## 9. Dependency Order

```text
PO-0
  ↓
PO-0A
  ↓
PO-1
  ↓
PO-2
  ├── PO-3
  └── PO-4
       ↓
      PO-5
       ↓
      PO-6
       ↓
      PO-7
       ↓
      PO-8
```

PO-3とPO-4はschema境界を固定した後なら並行可能。ただし`VideoPromptIrV2.program_binding`の契約変更はPO-3 / PO-4双方のowner reviewを必要とする。

## 10. 「全部実装」の完了定義

単にファイルが存在することではない。以下を満たして完了とする。

- PO-0、PO-0A、PO-1〜PO-8のExitをすべて満たす。
- planned文書のstatusを実装path / test evidence付きで更新する。
- legacy compatibility、MV、H3、resume、recovery、Launcherを一つのRCで再検証する。
- versionを一度だけ更新する。
- provider実生成を行っていない場合はfixture-onlyと明記する。
- push / PR / releaseはユーザーの明示承認後だけ行う。
