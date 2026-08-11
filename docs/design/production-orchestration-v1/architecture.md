# Architecture

## 1. 設計判断

次期Tsugiteは「固定順の6役pipeline」ではなく、**単一Coordinatorが所有する階層Task Tree**とする。

- hierarchy は `Project → Mission → Task → Attempt → Artifact / Job` で表す。
- agent processの親子関係をtruthにしない。
- roleはstateless capabilityであり、状態を直接保存しない。
- mutable state writerはCoordinator一つに限定する。
- role成果物はimmutable、create-only、digest付きとする。
- Gate / provider job / final manifestの既存state machineは、親Missionから参照する独立truthとして残す。

この形なら、専門分業と枝単位の再実行を実現しつつ、二重実行、共有blackboard競合、task増殖を避けられる。

## 2. 論理構造

```text
Project (project.yaml / durable projects home)
└── Mission
    ├── ProductionContract snapshot
    ├── Task: source-and-rights
    ├── Task: music-analysis                # MV時のみ
    ├── Task: identity-definition           # 必要時のみ
    ├── Task: treatment-and-story
    ├── Task: visual-system
    ├── Task: production-plan
    ├── Task group: section-or-shot branches
    │   ├── Task: generation-batch
    │   │   ├── Attempt 1 → generation job → artifact
    │   │   └── Attempt 2 → generation job → artifact
    │   └── Task: branch-critique
    ├── Task: edit-and-compose
    ├── Task: output-qa
    └── Task: closeout-learning
```

すべての案件で同じtaskを作らない。例えば既存素材だけの編集ではgeneration taskを作らず、抽象MVではIdentity taskを作らない。

## 3. コンポーネント

### 3.1 Mission Compiler

自然言語briefと`project.yaml`を読み、次を行う。

1. 必要なdomain contractを判定する。
2. `ProductionContractV1`のdraftを作る。
3. Task Treeのdraftを作る。
4. unknown / human decision / external connection decisionを列挙する。
5. direction、connection、費用、Gateを勝手に確定しない。

出力はdraft artifactであり、実行stateを直接変えない。

### 3.2 Coordinator Reducer

唯一のmutable writer。現在stateと一件のvalid eventから次stateを決定するpure reducerを持つ。

責務:

- schema、digest、parent lineage、task revisionの検証
- ready taskの選択
- role invocationの冪等key発行
- role resultのcreate-only保存
- task statusとdependency projection更新
- Gate / generation job / manifest truthの照合
- branch invalidationとresume

禁止:

- 自分の提案を自分で承認する
- Gate、費用、connection、model、Identity definitionを暗黙変更する
- providerへの結果不明POSTを再送する
- roleが返した未検証payloadをstateへ直書きする

### 3.3 Capability Registry

roleは固定順ではなく、task kindに対する許可済みcapabilityとして登録する。

| role | 主な出力 | 許可されないこと |
| --- | --- | --- |
| `director` | 優先度、treatment候補、判断理由 | Gate決定、費用決定、実行 |
| `story` | StoryPlan、尺・beatの役割 | Identity固定文変更、実行 |
| `music` | MusicStructure、sync cue、分析証拠 | 不明なBPM/歌詞時刻の捏造 |
| `identity` | IdentityDefinition draft / VerificationReport候補 | 人間確認の代行、`locked:true`自動化 |
| `visual` | VisualPlan、scene、shot設計 | model/connection fallback、実行 |
| `generator` | GenerationBatch案、承認済みjob起動要求 | promptの無断修正、予算超過 |
| `editor` | CompositionPlan、caption/edit計画 | render開始、Gate決定 |
| `critic` | CritiqueReport、RevisionIntent候補 | asset編集、再生成、Gate決定 |
| `learning` | LearningCandidate | 共有rule変更、自己承認 |
| `coordinator` | 検証済みstate transition | creative / safety decisionの自己承認 |

同じruntime processが複数role capabilityを実行してもよいが、artifact上の`role`とauthorityは混ぜない。

### 3.4 Artifact Store

Mission配下の成果物はcreate-onlyで保存する。

```text
projects/<project>/coordination/<mission-id>/
├── mission.json                 # immutable root identity
├── coordination-state.json     # atomic mutable projection
├── events.jsonl                # append-only coordinator events
├── artifacts/
│   └── <artifact-id>.json      # immutable typed artifact
├── attempts/
│   └── <attempt-id>.json       # invocation/result binding
└── metrics/
    └── mission-metrics.json
```

このdirectoryはdurable projects home内に置く。feature worktreeだけに置かない。symlink ancestor / path escapeを拒否し、atomic write、revision CAS、file digest再検証を行う。

### 3.5 Existing State Bridges

既存truthを複製しない。

| 既存truth | Missionからの扱い |
| --- | --- |
| Gate / run `state.json` | `RunBindingV1`でpath、run_id、digestを参照 |
| generationJobs store | approval時のimmutable bindingとpin後CompletionRefで参照。mutable revisionは単調増加を許す |
| H3 / video_prompt artifact | ArtifactEnvelopeからlineage digestを参照 |
| manifest / pinned media | SHA-256、MIME、ffprobe証拠を参照 |
| feedback.jsonl | closeout taskが既存append APIを呼ぶ。複製しない |
| completion-record | final selected runとMission digestを追記 |

## 4. State 階層

### Project

durableな制作物の境界。`project.yaml`、media、dist、completion recordを所有する。

### Mission

数時間から数週間の目標単位。例:

- 1本のMVを完成する
- 同シリーズの次の3本を作る
- 既存作品のChorusだけを別案へ差し替える

Missionはobjectiveとdeliverableを持つが、provider jobやGate stateそのものではない。

### Task

依存関係、role、入力artifact、期待出力、risk class、invalidation scopeを持つ。Task TreeはDAG制約を持ち、cycleを拒否する。

### Attempt

同じtaskに対する1回の実行。`attempt_key = sha256(task_id + task_revision + input_digest + ordinal)`を使い、同じkeyを二重起動しない。

### Artifact / Generation Job

Artifactは結果のimmutable証拠。外部生成は既存generationJobs state machineがtruthであり、Attemptはjobを参照するだけである。

## 5. Task 状態

```text
proposed
  → blocked
  → ready
  → running
  → completed
  → failed_known
  → outcome_unknown
  → awaiting_human
  → stale
```

- `blocked`: dependency、connection、価格、素材など機械的阻害。
- `awaiting_human`: direction、Identity、Gate、費用、最終選択など。
- `outcome_unknown`: task起動結果または外部副作用の成立が不明。照合するまで再実行しない。
- `stale`: upstream contract/artifactが変わり、過去結果を採用できない。
- `completed`: schema / lineage / evidenceを満たしたartifactが存在する場合だけ。

`completed`から`ready`へ戻さない。入力変更時は旧taskを`stale`にし、新revisionを作る。

## 6. 依存と枝単位 invalidation

各artifactは`parent_artifact_ids`と、そのTaskが実際に読んだslot / fragmentの`contract_bindings`を持つ。全体の`contract_set_digest`だけでartifactを無効化しない。変更時はfragment digest graphを辿り、依存する下流だけをstale化する。一方、GateBundleはactive ContractSet全体をbindするため、実行に関わるcontract revision変更時はGate承認をstaleにする。

例:

| 変更 | staleになる範囲 |
| --- | --- |
| Identity definition appearance | 当該subjectを使うVisualPlan、shot、generation、QA、edit、全downstream Gate |
| Identity result verification | 対象outputのIdentity QA、Gate 2 / 3。definition自体は維持 |
| Chorusのshot visual | Chorus branchのgeneration以降のみ |
| master音源 | Music / Lyrics /全timeline / edit / final QA |
| 歌詞の1行時刻 | 該当caption cue、関連sync QA、edit |
| connection / model | 該当GenerationBatch、approval/cost binding、job |
| story direction | Story以降の全creative branch。人間再確認 |

upstream変更を受けても、無関係なasset、別section、完成済み分析を再実行しない。

## 7. Human Approval Model

### 常に人間が決める

- creative directionの採用
- Identity definitionの確認とresult verification
- connection / model /課金経路
- Gate 1、Gate 3
- 現行条件に該当しないGate 2
- budget上限拡大
- external send、publish、push、release
- final outputの選択と完成宣言

### Gate 1で事前承認できる範囲

GateBundleに結合する`RegenerationPolicySpecV1`として、次を明示的に承認できる。

- 対象task / branch
- 許可する変更class
- attempt上限
- incremental credit上限
- model / connection固定
- mutable prompt blockの上限
- expiryと停止条件

このspecとGate 1 decisionから発行される`RegenerationGrantV1`が無い場合、自動再生成は0回とする。無課金・同一入力のlocal recoveryは別のtask-bound `LocalRecoveryPermitV1`で扱う。

## 8. 代表フロー

### 新規制作

1. briefと素材を受け取る。
2. Mission Compilerが必要contractとTask Treeをdraftする。
3. domain rolesが分析・Story・Visual artifactを作る。
4. review artifactを生成し、Gate 1で方向・費用・recovery範囲を承認する。
5. ready branchを実行する。
6. Criticがartifactとmedia evidenceを検証する。
7. policy内の失敗だけ枝単位で回復する。
8. Gate 2、明示render、Gate 3へ進む。
9. 完成宣言後、feedback / learning / finalizeを行う。

### 数日後の再開

1. Mission root、state revision、event tail、artifact digestを再検証する。
2. Gate state、generation job revision、manifest/pinned mediaを外部truthから再読する。
3. `running`のまま残ったtaskを機械照合する。
4. provider job idが存在すればpoll/downloadを再開する。
5. submissionの成立が不明なら`outcome_unknown`で停止する。
6. ready taskだけ再度queueへ載せる。

### シリーズ制作

seriesは`SeriesProductionGraphV1`から複数の独立Productionを参照する。各作品は別ProductionContract、TaskTree、Gate、budget、final outputを持ち、一つの子Missionへ権限をまとめない。過去作品の学びはapproved rule revision / contract / templateだけを参照し、未承認feedbackを自動適用しない。

## 9. Launcher Projection

Launcherが表示するのは安全なprojectionだけとする。

- Mission名、deliverable、進捗
- Task Treeとstatus
- blocked / awaiting-human理由の公開code
- branch attempt回数とcredit集計
- current Gateと必要な人間decision
- stale範囲と原因artifact kind
- canonical output / QA / completion state

表示しないもの:

- prompt本文
- provider raw response
- secret、credential名以外の認証情報
- private path / command
- agent internal reasoning

## 10. 設計不変条件

1. state transitionは同じstate + eventから常に同じ結果になる。
2. Coordinator以外のroleはstate storeへ書けない。
3. artifactは上書きできない。
4. completed taskは検証済みartifactなしに成立しない。
5. stale artifactはGate digest、generation、final manifestへ採用できない。
6. approval digest不一致のjobは起動できない。
7. unknown price、unknown outcome、unknown capabilityは実行不可。
8. legacy projectはMission機能を使わなくても従来通り動く。
