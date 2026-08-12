# Observability and Evaluation

## 1. 原則

「良くなった」を感覚で判断しない。すべての改善は、同じ定義・同じ対象群・同じ評価手順で比較する。

ただし、指標はGateを自動承認する根拠にはしない。特にidentity、creative quality、権利、最終承認を一つのscoreへ潰さない。

## 2. Eventから導出する

metric用に別の手書きlogを増やさず、Production event、Gate state、generation job、manifest、QA、human ratingからprojectionする。

```ts
type MissionMetricsV1 = {
  production_id: string;
  tree_revision: number;
  source_event_sequence: number;
  flow: FlowMetrics;
  intervention: InterventionMetrics;
  recovery: RecoveryMetrics;
  consistency: ConsistencyMetrics;
  cost: CostMetrics;
  mv?: MvMetrics;
  safety: SafetyMetrics;
  computed_at: string;
  digest: Sha256;
};
```

metric projectionはread-only。Gate、task、jobを変更しない。

## 3. 人間介入回数

### 定義

人間が制作の進行に必要なdecisionを入力した回数。

```text
human_interventions_total
= Gate decision
+ direction / candidate selection
+ Identity definition / verification
+ connection / model / budget choice
+ recovery escalation resolution
+ final completion decision
```

同じdecisionをUIで再表示しただけでは増やさない。`decision_id + subject_digest`で重複排除する。

別表示:

- `mandatory_safety_interventions`: Gate 1/3など残すべき介入
- `operational_interventions`: retry、状態確認、手戻り指示
- `creative_interventions`: direction、shot、表現選択

改善目標はtotalを盲目的に0へ近づけることではなく、mandatory safetyを維持しながらoperational interventionを減らすこと。

### 比較

```text
intervention_reduction_rate
= (baseline_median - candidate_median) / baseline_median
```

project type、尺、generated shot数を揃えて比較する。

## 4. 自動リカバリ成功率

### attemptの母数

LocalRecoveryPermitV1またはRegenerationAttemptAuthorizationV1に正しく結合され、AIが人間の追加decisionなしで開始した回復attempt。Grantだけをattemptの証明にしない。

### 成功

次をすべて満たす。

- policy内
- unauthorized action 0
- stale / digest mismatch 0
- target taskがaccepted
- downstream Gate bundleに採用可能
- 人間が同じfailure原因で即座に再修正していない

```text
automatic_recovery_success_rate
= successful_recovery_attempts / eligible_recovery_attempts
```

別途:

- local recovery success
- paid regeneration success
- escalation rate
- attempts per recovered task
- credits per recovered task
- grant exhaustion rate

`submission_unknown`はeligible母数に含めず、安全停止として別計測する。

## 5. 一貫性

一つの不透明なAI scoreへまとめず、証拠basisを分ける。

```ts
type ConsistencyMetrics = {
  identity?: EvidenceScore;
  wardrobe?: EvidenceScore;
  scene?: EvidenceScore;
  style?: EvidenceScore;
  tone?: EvidenceScore;
  coverage: {
    evaluated_shots: number;
    expected_shots: number;
  };
};

type EvidenceScore = {
  value?: number; // 0..100, analyzer/human rubricが定義できる場合だけ
  basis: "human" | "fixture" | "local-analyzer" | "external-analyzer" | "not-run";
  evidence_artifact_ids: string[];
  ambiguity_codes: string[];
};
```

- analyzerが無ければ`not-run`。0点にしない。
- external analyzerへfallbackしない。
- human scoreはrubric versionを固定する。
- IdentityDefinitionContract不適用案件にidentity scoreを付けない。

### 継続制作

同シリーズN本の比較では、各作品のactive contract digestとtemplate revisionを記録する。契約が変わった作品を「同条件」として集計しない。

## 6. Creditあたり完成品質

### cost

```text
actual_generation_credits
= accepted / rejected / supersededを含むprovider actual credits
```

不明なcreditを0として扱わない。`unknown`を保つ。

### quality

品質は次を別々に残す。

- human final rating（rubric version付き）
- Gate 2 technical issue count
- Gate 3 issue count
- accepted branch ratio
- rework count
- Identity / MV sync coverage

同一rubricでhuman ratingがある場合だけ、参考値を出す。

```text
quality_per_credit
= normalized_human_quality / actual_generation_credits
```

credit 0のlocal editにはこの比率を出さず、`zero-credit-local`として別分類する。provider / model / project typeを跨いだ単純順位付けをしない。

## 7. Flow / Long-horizon

- Mission elapsed time
- active work time
- human wait time
- provider wait time
- critical path duration
- pause回数
- resume成功率
- resumeに要した時間
- stale fan-out
- branch reuse率

```text
branch_reuse_rate
= accepted_non_stale_sibling_artifacts_reused
 / eligible_preexisting_sibling_artifacts
```

長期案件では「完了までの速さ」だけでなく、「中断後に人間が状況を説明し直した回数」を測る。

## 8. MV指標

### timeline integrity

- `audio_video_duration_delta_ms`
- `unit_binding_violation_count`
- `clip_timeline_gap_count` / `clip_timeline_overlap_count`（required track / interval別）
- `source_timeline_duration_delta_ms`
- expected caption cue集合に対するduplicate / missing count
- orphan beat anchor count

gapの母数はCompositionIntentが指定した`required_visual_coverage_intervals`とtrackに限定する。意図的な空白、instrumental区間のcaption無し、承認済みoverlay / crossfadeを不良へ数えない。

### sync coverage

```text
lyric_timing_coverage
= timed_expected_caption_cues / expected_caption_cues

beat_anchor_coverage
= generated_or_edit_units_with_valid_anchor
 / units_declaring_beat_sync
```

### human correction

- lyric text corrections
- lyric timing corrections
- beat / section corrections
- caption line-break corrections

machine alignmentを人間が直した回数を減らすが、未確認alignmentを「修正0」として成功扱いしない。
untimed / partial / unknown alignmentは分母とunknown件数を明示し、母数0を100%成功へ変換しない。

## 9. H3 / Prompt Compiler指標

- compile success rate
- validation code別件数
- hard / soft / unknown budget件数
- canonical → adapter label error
- exact text mismatch
- stale knowledge / profile件数
- Gate後compilation digest drift
- generation acceptance by mode
- retry attempts by mutable block

prompt本文はmetric eventへ保存しない。block kind、文字数、digest、error codeだけを使う。

## 10. Learning Loop指標

- exact-key recurrence count
- candidate → experiment → pending-human conversion
- validated / rejected / inconclusive件数
- observationからhuman decisionまでの時間
- applied ruleの症状再発率before / after
- regression escape / rollback count
- pending proposal age

候補作成数を改善扱いしない。rule revision、対象母数、baseline、safety invariantを揃えた再発率で判断する。

## 11. Safety SLO

次は常に目標0。

- unauthorized external submit
- duplicate paid submit
- `submission_unknown`再送
- model / connection silent fallback
- unknown price execution
- stale artifact acceptance
- Gate digest mismatch execution
- unverified mediaを`pinned`扱い
- secret / raw promptのpublic projection流出
- roleによるCoordinator state直接write

0でない場合、品質指標より優先してreleaseを止める。

## 12. Evaluation Suites

### deterministic suite

- schema / reducer / event replay
- invalidation matrix
- recovery policy boundaries
- Gate / job binding
- H3 golden / adversarial
- MV timing fixture
- finalize retention
- Launcher public projection

### human rubric suite

同じbrief /素材 /上限creditでbaselineとcandidateをblind比較する。

rubric:

- 目的達成
- 構成と尺
- visual coherence
- Identity / scene continuity（適用時）
- edit rhythm / audio sync（MV時）
- captions / text
- 完成度

各項目1–5、評価者、rubric version、比較対象digestを残す。

### long-horizon simulation

fixture jobを各crash pointで停止し、24時間相当のclock advance後にresumeする。二重submit、stale採用、説明し直しなしを確認する。

## 13. Baseline

導入前にv0.9.xで最低10案件、またはproject typeごとに5案件のbaselineを取る。件数不足時は断定的な百分率を出さない。

推奨segment:

- local edit
- generated short
- character multi-shot
- lyric MV
- concept MV

既存historical logに必要fieldが無い場合は`legacy_not_recorded`とし、推定で埋めない。

## 14. Phase Exit Targets

数値targetはbaseline取得後に固定する。実装前の暫定guardrail:

- safety SLO: 0
- deterministic replay: 100%
- eligible sibling branch preservation: 100%
- known-job resume without resubmit: 100%
- MV timing fixture gap / overlap: 0
- exact lyrics preservation: 100%
- human operational interventions: baseline以下
- accepted outputあたりmedian credits: baseline以下、または品質向上をhuman rubricで説明

## 15. Reporting

各release candidateで次を一枚にまとめる。

1. 対象version / commit / fixture set
2. baselineとcandidateの案件数
3. mandatory / operational / creative介入
4. recovery success / escalation / credit
5. consistency coverageとbasis
6. MV sync
7. safety SLO
8. regressionと未計測項目

「改善」と書くときは、対象母数、差分、metric定義、unknown数を併記する。
