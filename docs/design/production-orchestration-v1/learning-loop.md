**状態:** implemented (PO-7 / T08). Paths: `src/productionControl/learning/*`, `src/productionControl/metrics.ts`, `src/productionControl/publicProjection.ts`, `src/productionControl/finalizeRetention.ts`.

# Learning and Rule Promotion Loop

## 1. 目的

案件の失敗・成功を記録するだけで終わらせず、再利用できるルール候補を作り、再現可能な実験で検証し、人間承認後だけ共有ルールへ反映する。

既存の正本は維持する。

- 案件固有の観測: append-only `feedback.jsonl`
- 人間が承認した再利用知識: append-only `LESSONS.md`
- proposal decision: 既存feedback promotion API

新control planeはこれらを置換せず、typed artifactとexperiment evidenceを追加する。

## 2. 自然言語での流れ

1. 完成宣言後、Learning capabilityが今回の失敗・成功・回復履歴を読む。
2. 症状、原因、変更、結果を既存feedback keyへ正規化する。
3. 過去に同じkeyがあれば`recurring`候補にする。意味が似ているだけの判定は参考情報に留める。
4. 反映先、最小変更、壊してはいけない契約、検証方法が揃う場合だけLearningCandidateを作る。
5. deterministic fixture、過去run replay、shadow比較の順で実験する。
6. 安全違反0、対象指標改善、既存golden非退行を満たせばPromotionProposalを作る。
7. 人間がproposalと差分を承認した場合だけ、新しいrule revisionまたは`LESSONS.md`追記を行う。
8. 次のMissionは承認済みrevisionをsnapshot参照する。進行中Missionへ暗黙適用しない。
9. 採用後も再発率と副作用を計測し、悪化時は旧revisionへ戻す新decisionを作る。

「AIが学んだ」は、proposalを作った時点ではなく、承認済みrule revisionが次のMissionに明示bindされた時点を指す。

## 3. State Machine

```text
observed
  → candidate
  → awaiting-experiment
  → experimenting
  → validated | rejected | inconclusive
  → awaiting-human
  → approved | declined
  → applied
  → monitored
```

- `validated`は自動適用を意味しない。
- `inconclusive`を成功へ丸めない。
- `declined` / `rejected`もappend-only evidenceとして残す。
- shared ruleをin-place editせず、新revisionまたは追記を作る。

## 4. LearningCandidateV1

```ts
type LearningCandidateV1 = {
  schema_version: 1;
  candidate_id: string;
  feedback_keys: string[];
  recurrence: {
    exact_key_count: number;
    related_observation_ids: string[];
    semantic_matches_advisory: string[];
  };
  observation_refs: TypedDigestRef[];
  symptom: string;
  hypothesized_cause: string;
  proposed_rule: {
    target_kind:
      | "validator"
      | "compiler"
      | "template"
      | "prompt-guide"
      | "runbook"
      | "lesson";
    target_ref: string;
    scope: string;
    minimal_change: string;
  };
  invariants: string[];
  experiment_requirements: string[];
  produced_by: "learning";
  digest: Sha256;
};
```

作成条件:

- observationのsourceとdigestが存在する。
- 症状と原因仮説を分ける。
- 反映先と最小変更が具体的である。
- 検証方法と停止条件がある。
- secret、prompt全文、個人情報、絶対pathを含まない。

条件不足ならfeedback記録だけを残し、proposalへ昇格しない。

## 5. LearningExperimentV1

```ts
type LearningExperimentV1 = {
  schema_version: 1;
  experiment_id: string;
  candidate_digest: Sha256;
  mode: "fixture" | "replay" | "shadow" | "live-approved";
  baseline_ref: TypedDigestRef;
  candidate_ref: TypedDigestRef;
  fixture_refs: TypedDigestRef[];
  success_criteria: Array<{
    metric_id: string;
    comparator: "eq" | "lte" | "gte";
    threshold: number;
  }>;
  safety_invariants: string[];
  authority?: HumanDecisionRef;
  result?: {
    status: "validated" | "rejected" | "inconclusive";
    metric_evidence_refs: TypedDigestRef[];
    safety_violations: string[];
    regression_refs: TypedDigestRef[];
  };
  digest: Sha256;
};
```

実験順序:

1. pure validator / compiler fixture
2. pinned historical artifact replay
3. current runのread-only shadow
4. 必要な場合だけ、別の人間承認を持つlive experiment

`live-approved`は通常制作のGate・接続・価格・外部送信境界を継承する。LearningCandidateやPromotionProposalをlive実行権限として使わない。

## 6. PromotionProposalV1

```ts
type PromotionProposalV1 = {
  schema_version: 1;
  proposal_id: string;
  candidate_digest: Sha256;
  experiment_digests: Sha256[];
  proposed_patch_digest: Sha256;
  target_ref: string;
  compatibility_impact: "none" | "additive" | "breaking";
  rollback_ref: string;
  status: "pending-human" | "approved" | "declined" | "applied";
  decision?: HumanDecisionRef;
  applied_rule_revision?: TypedDigestRef;
  digest: Sha256;
};
```

人間reviewには次を表示する。

- どの失敗または成功から生まれたか
- 同じkeyの再発回数
- 何を1箇所だけ変えるか
- baseline / candidateの比較
- safety / compatibility結果
- 適用範囲とrollback

## 7. 自動化してよい範囲

自動でよい:

- feedback keyのexact照合
- LearningCandidate draft
- fixture / replay / shadow experiment
- metric投影
- pending proposal作成

人間が必要:

- semantic matchを`recurring`として確定すること
- live provider experiment、課金、外部送信
- shared validator / compiler / template / prompt guideの変更
- `LESSONS.md`への共有rule追記
- rule revisionのactive化とrollback

Learning capability、Critic、Coordinatorのいずれも、自分のproposalを承認できない。

## 8. Long-horizon / Branch Invalidation

ProductionContractは利用する`rule_set_digest`と各rule revisionを固定する。

- pending / validated proposalはTask入力に使えない。
- approved revisionは新Missionのcompile時にだけ既定採用できる。
- 進行中Missionへ採用する場合は明示RevisionIntentを作る。
- ruleが影響するTaskだけをdependency indexからstale化する。
- GateBundleに含まれるcompiler、template、prompt guide、validator digestが変わればGate 1をstaleにする。
- rule rollbackも新revisionとして扱い、履歴を消さない。

シリーズ制作では、前作の未承認feedbackではなく、承認済みrule revisionと作品固有contractだけを次作へ渡す。

## 9. Metrics

- candidate creation rate
- exact-key recurrence count
- experiment validated / rejected / inconclusive rate
- human approval / decline rate
- time from observation to decision
- adopted ruleの再発率before / after
- regression escape count
- rollback count
- pending proposal age

候補数を成果指標にしない。最重要は、safety invariantを壊さず対象症状の再発が減ったかである。

## 10. Acceptance Tests

- 同一feedback keyの2回目をrecurring候補にする。
- semantic similarityだけではrecurring確定しない。
- observation不足ではproposalを作らない。
- fixture failureは`rejected`、計測不能は`inconclusive`になる。
- `validated`だけではrule storeも`LESSONS.md`も変更されない。
- human approval digest不一致でapplyを拒否する。
- applied revisionだけが新Missionのrule setへ入る。
- 進行中Missionへのrevision変更で依存枝とGate 1がstaleになる。
- live experimentは通常のGate / pricing / connection条件を迂回できない。
- secret / prompt / absolute pathをpublic proposalへ出さない。
- replay後もproposal / decision / rule revisionのdigest chainが一致する。

## 11. 実装先

```text
src/productionControl/learning/
├── candidate.ts
├── experiment.ts
├── promotion.ts
├── ruleSet.ts
└── publicProjection.ts
```

既存`src/feedback/` APIを経由してfeedbackとpromotion decisionを扱う。新実装から`feedback.jsonl`や`LESSONS.md`へ直接writeしない。
