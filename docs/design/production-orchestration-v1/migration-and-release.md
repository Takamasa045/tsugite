# Migration and Release

## 1. Version方針

現行software versionは`0.9.0`。この設計書を追加しただけではversionを変更しない。

次期実装は段階releaseする。

| release | 目的 |
| --- | --- |
| `0.10.0-alpha.1` | 現行Launcher描画退行の修復、contract / artifact / event / reducerのshadow基盤 |
| `0.10.0-alpha.2` | hierarchical planningとbranch invalidation |
| `0.10.0-alpha.3` | MV contractsとVideoPrompt/H3 single compiler shadow |
| `0.10.0-alpha.4` | Gate bundle、generation bridge、resume / recovery |
| `0.10.0-beta.1` | learning loop、Launcher tree、metrics、finalize retention |
| `1.0.0-rc.1` | default-off active modeと全回帰 |
| `1.0.0` | READMEのexit criteriaを全て満たした安定版 |

実際のrelease番号は各phaseが統合された時点で一度だけ更新する。設計だけ、途中実装、テスト未完了の状態で先に`1.0.0`へ上げない。

contract schema version、compiler workflow version、package versionを別管理する。

```text
package:                    0.10.0-alpha.N → 1.0.0
ProductionContract:        schema_version 1
TaskTreeSpec:              schema_version 1
VideoPromptIr:             version 2
H3 compiler workflow:      version 3
legacy H3 workflow:        version 2 readerを維持
```

## 2. Compatibility Principles

1. `project.yaml`を入口として残す。
2. `orchestration`未指定projectはlegacy線形挙動を変えない。
3. 現行`RunState`を破壊的変換せず、Missionからleaf truthとして参照する。
4. existing generation job storeをin-place変換しない。
5. H3 v1 source / workflow v2 artifactを自動書換えしない。
6. legacy run / final artifact / completion recordを再計算しない。
7. new public DTOはlegacy recordの欠損を`legacy_not_recorded`と表示する。
8. shadow modeのartifactはGate、plan digest、run、render結果を変えない。

## 3. Activation Modes

```ts
type ProductionControlMode = "disabled" | "shadow" | "active";
```

### disabled

現行v0.9.xと同じ。control-plane fileを読まない。

### shadow

- legacy validate / planからcontract / tree候補を計算する。
- shadow directoryへartifactを保存できる。
- Gate、generation、render、project digestを変更しない。
- mismatchをreportするが、legacy executionを止めない。ただし既存validation errorは従来通り止める。

### active

- explicit project opt-inが必要。
- ProductionContract / TaskTree / GateBundleが実行条件になる。
- legacy leaf state machineをcontrol planeから呼ぶ。
- H3 legacy authoringもV2 pure upgrader経由でsingle compilerへ流し、旧compilerを直接実行しない。

RCまではdefault `disabled`。v1.0でも既存projectは自動active化しない。

## 4. Phase 0: Freeze Existing Truth

実装前に次を固定する。

- current package / schema / workflow versions
- legacy project fixture set
- Gate state transition tests
- finalize / durable projects home tests
- generationJobs no-resubmit / pin tests
- H3 v1 goldens
- Identity Lock tests
- Launcher fixed workflow snapshot
- current full build / test / Windows smoke command

このPhaseで機能追加しない。

Phase 0のfixtureを固定した直後、Phase 1より先にPO-0Aとして現行Launcherの3D無表示を修復する。修復仕様は[launcher-and-visualization.md](./launcher-and-visualization.md)を正本とし、3D失敗時のDOM fallbackまで含める。Mission Tree UIはここでは追加しない。直接原因は未確定のままなのでfailure class別の診断証拠を先に取り、CLIの毎回buildをpackaged Desktop bundleのfreshness証明へ流用しない。

## 5. Phase 1: Shadow Foundation

追加:

- `src/productionControl/schema.ts`
- canonical digest helpers
- ArtifactStore
- EventStore
- deterministic reducer
- snapshot CAS
- legacy project → single Mission / Task Tree compiler

条件:

- legacy plan / review / run output byte-equivalentまたは既知の非意味的差分のみ
- shadow failureがlegacy executionを変更しない
- path / symlink / crash adversarial tests
- event replayがdeterministic

rollback: feature flagをdisabledへ戻す。legacy stateは無変更。

## 6. Phase 2: Hierarchical Planning

追加:

- ProductionContract / ContractSet
- domain contract slots
- TaskTree template registry
- reverse dependency index
- canonical ContractFragmentRef indexとwhole-contract fallback
- invalidation report
- IdentityDefinitionContract / post-generation VerificationReport分離
- human BranchSelectionとSeriesProductionGraph
- role result envelope
- Gate 1 reviewへのread-only tree preview

条件:

- 同じinputから同じtree / digest
- cycle / unknown role / unknown task kind拒否
- depth / node / concurrency上限
- sibling branch preservation
- Identity / Music / Lyrics optionality

active executionはまだ行わない。

### Identity Lock Phase A–Eの移行規則

既存Identity Lockを新contractへ機械的に「承認済み」と読み替えない。previewで次を分離して示す。

| 現行 | 新contract | 移行規則 |
| --- | --- | --- |
| `subjects[].locked_blocks.{voice,appearance,manner}` | `IdentityDefinitionContractV1.subjects[].locked_blocks` | exact textと既存sha256をそのままcopyし、再計算値と不一致なら移行停止 |
| `scenes[].location_map / palette` | definitionのscene locked text | exact textを保持し、derived hashとsource fieldをmigration artifactへ記録。内容を補完しない |
| `subjects[].variants[].source_asset` | AssetContract + definition variant ref | project-local regular fileをsnapshotし、SHA / asset idをpreview表示。missing、symlink、project外参照は停止 |
| `shots[].scene / cast / variant` | Task fragment binding | 参照関係を保持し、unknown idを推測修正しない |
| `subject.locked: true` | legacy evidence only | definition confirmationにもoutput verificationにも変換しない |
| 人間が固定文を確認した記録 | `definition_confirmation` | exact definition digestを持つdecisionを解決できる場合だけimport。Gate 1通過だけから推測しない |
| `subject_expectations`等の明示条件 | definitionのverification requirements | exact subject / conditionをlosslessに対応できる項目だけcandidate化し、人間previewで不足条件を確認する |
| 生成結果のperson consistency確認 | `IdentityVerificationReportV1` | selected output digest、required/evaluated condition、coverage、evidence、explicit human decisionが全て解決できる場合だけimport |

したがって、hashが正しいだけの既存lockは`awaiting_human`、または証拠が無いhistorical状態として表示する。`locked: false` / 未指定は未確認のまま、`locked: true`も単独では`verified`にしない。verification requirementを安全に移せない場合は人間確認までactive executionを止める。旧IR、lineage、QA、Gate artifactはread-onlyで保持し、migration apply後も証拠chainから参照できるようにする。

## 7. Phase 3: MV and H3 Compiler

追加:

- MusicStructureContract / LyricsContract
- GenerationUnitContract / CompositionIntent / resolved CompositionPlan
- MV Task Tree template
- VideoPromptIrV2
- H3 v1 → V2 pure upgrader
- semantic block AST
- EffectiveGenerationContract
- H3 grammar v3
- adapter dialect stage
- atomic compilation bundle

導入順:

1. legacy golden freeze
2. V2 compiler shadow
3. legacy inputのparallel compile diff
4. new V2-only fixture
5. MV multi-unit fixture
6. compilation digestのreview表示

legacy `request.h3`はauthoring compatibilityとして残す。`disabled=legacy compile/execute`、`shadow=legacy execute + V2比較`、`active=全入力V2 single compiler`を固定し、active pathから旧compilerを呼ぶtestを0件にする。

## 8. Phase 4: Gate / Generation / Recovery

追加:

- GateBundleV1
- GenerationJobApprovalBindingV1 / GenerationCompletionRefV1
- AuthorityGuard
- ResumeReconciler
- LocalRecoveryPermitV1
- opt-in RegenerationPolicySpec / Grant / AttemptAuthorization

順序:

1. Gate bundleをreviewに表示するだけ
2. approval digestへbind
3. existing generationJobsのread-only reconciliation
4. active job bridge
5. local recovery
6. paid regeneration grant

paid regenerationは最後に導入する。先に`submission_unknown`、job mutable revision、Gate cascade、grant consumption、digest drift、credit ceiling、artifact accept / invalidation interleavingのadversarial testsを通す。

## 9. Phase 5: Learning / Launcher / Metrics / Finalize

Learning:

- existing feedback APIを再利用し、fileへ直接writeしない
- candidate / experiment / proposalをappend-only artifact化
- fixture / replay / shadowだけを既定自動実験にする
- validated proposalを人間承認なしにactive ruleへしない
- approved rule revisionだけを新Missionへbindする

Launcher:

- legacy固定workflow表示を維持
- active projectだけMission Tree表示
- PO-0Aのscene state / DOM fallbackをlegacyとactiveで共用
- public DTOをstrict parse
- prompt / secret / path / raw provider responseを除外
- stale / awaiting-human / blocked codeを表示

Metrics:

- event projectionのみ
- legacy欠損は`legacy_not_recorded`
- metricでGateを変更しない

Finalize:

- selected contract / tree / event / metricsを保持
- production completion digestをpreviewへ追加
- legacy finalize digestを維持
- media cleanup対象を広げない

## 10. State Migration

### legacy projectをactiveにする場合

明示CLIでpreviewする。

```text
pipeline production migrate --config <project.yaml> --preview --json
```

preview内容:

- source project / run identity
- 作成するProductionContract / TaskTree digest
- legacy Gate / run binding
- Identity Lock Phase A–Eからdefinition / verificationへ移せる項目と、再確認が必要な項目
- 不足contract
- active化でstaleになる対象
- 書込みpath

applyはCoordinator +明示承認が必要。in-place source rewriteではなく、新しいcoordination rootをcreate-onlyで作る。

### 移行不能

- unknown Gate state
- source project digest drift
- symlink / path escape
- run identity mismatch
- missing canonical artifact
- generation job outcome unknown

の場合は無変更停止。

## 11. Rollback

control planeはadditiveなので、rollbackでlegacy stateを復元する操作を不要にする。

### shadow

modeをdisabledにし、shadow artifactを残す。削除しない。

### active planning前

新taskを停止し、legacy project / Gate stateをそのまま利用できる。

### active execution後

- 新規submitを停止
- 既知provider jobはread-only照合
- pinned assetとmanifestを保持
- 現在Gate stateをtruthとして報告
- rollback decision artifactを人間承認で記録

branch artifactやjobを消して「無かったこと」にしない。

## 12. Release Gate

各alpha / beta / RCで以下を証明する。

### repository

- clean targeted diff
- package / lockfile version一致
- changelog
- docs implemented / planned status整合
- no secret / absolute local path fixture leak

### tests

- typecheck / build
- full unit / integration
- H3 / VPD golden
- reserved-token / untimed-cue / GenerationUnit / mixed-route golden
- state / finalize / generationJobs regression
- Windows smoke
- path / symlink / crash adversarial
- Launcher public DTO / a11y
- 実Canvas first-frame、WebGL unavailable / context lost時のDOM fallback

### behavior

- Gate 1 / 3人間境界
- Gate 2 existing exceptionのみ
- explicit render
- no silent model / connection fallback
- unknown price block
- `submission_unknown` no-resubmit
- pinned-only artifact
- stale branch rejection
- current Gate subjectのrender / finalize直前再照合
- policy内derived compilation以外のGate 1失効
- job revision増加中のimmutable approval identity維持

### evidence

- baseline / candidate metric report
- migration preview fixture
- resume fixture
- MV end-to-end fixture
- 現行8工程の実Canvas可視化とdegraded fallback fixture
- learning proposal experiment / human approval fixture
- rollback rehearsal

## 13. Documentation Status Changes

実装Phaseが完了したら、そのPhaseに対応する文書だけを`implemented`へ変更する。

- 設計文書全体を一括で「実装済み」にしない。
- code path、test、commit / PRをstatus欄へ記載する。
- 未実装項目をREADME / Launcherで利用可能と表示しない。
- official knowledge更新時はpin / digest / verified_at / review_afterを揃える。

## 14. v1.0.0 Final Checklist

- 全Phaseのacceptance criteria
- legacy compatibility suite
- active mode 3 project types以上
- character multi-shot / lyric MV / local edit
- pause / resume / branch replacement / recoveryの実証
- safety SLO全て0
- package / changelog / onboarding / docs更新
- source-only releaseか、配布物を伴うreleaseかを明記
- provider traffic /課金をfixture成功と混同しない
