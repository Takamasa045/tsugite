# Production Orchestration v1

**状態:** 設計確定。実装前。

**設計レビュー:** 2026-08-11に階層/runtime安全性、MV/H3/metrics、現行Launcher描画の3観点で再監査し、残存P0/P1なし。

**基点:** Tsugite `v0.9.0` + Identity Lock Phase A–E (`main@f2e127f`)

**目標:** `v0.10.0-alpha.*` で段階導入し、全 exit criteria 通過後に `v1.0.0` 候補とする。

## 1. North Star

利用者が「この曲でMVを作る」「このシリーズを3本続けて作る」のように一つの目的を渡すと、Tsugite がそれを依存関係のある Task Tree に分解し、必要な専門能力を起動し、失敗した枝だけを安全にやり直し、数日後でも同じ状態から再開できるようにする。

階層化の単位は**無制限に自己増殖するagent process**ではなく、Coordinatorが所有する durable な Mission / Task / Artifact である。専門役割は、型付き入力から型付き成果物を返す stateless capability として扱う。

## 2. 現行との差

現行は単一 `RunState` と Gate 1–3 を中心とする線形フローである。Identity Lock、H3 lineage、generation job、feedback は存在するが、相互に一つの Mission Tree として束ねられていない。

次期版では次が新しくなる。

1. `project.yaml` から immutable な `ProductionContractV1` を compile する。
2. Project の下に Mission、Mission の下に Task Tree、Task の下に Attempt / Artifact / generation job を持つ。
3. Music、Identity、Story、Visual、Generation、Edit、Critic を必要な案件だけ起動する。
4. 失敗した task と、その出力に依存する下流だけを `stale` にする。
5. Gate 1 で承認された小さな変更・回数・費用の範囲だけ、自動回復を許可できる。
6. `submission_unknown`、未知価格、model / connection変更、Identity変更、方向転換は自動回復しない。
7. Launcher は固定8ノードではなく、Mission Tree、待ち理由、承認待ち、回復履歴を表示する。
8. feedbackからrule候補を作り、fixture / replay / shadow実験を通したpending proposalだけを人間へ提示する。

Gate 1 / Gate 3 の人間承認、現行の限定的 Gate 2 auto-pass、明示 render、finalize の完成宣言条件は維持する。

現行Launcherの中央3D無表示は、Canvas失敗を可視化できないことまでは確認済みだが、WebGL、GPU、scene例外のどれが直接原因かは未確定である。PO-0Aでは一原因へ決め打ちせずfailure classを診断し、CLI生成bundleとpackaged Desktop bundleを別々に検証する。

## 3. 文書構成

| 文書 | 内容 |
| --- | --- |
| [architecture.md](./architecture.md) | 全体構造、役割、状態階層、truth、代表フロー |
| [contracts.md](./contracts.md) | Production / Task / Artifact / Identity / Music / Lyrics / Recovery の型 |
| [mv-workflow.md](./mv-workflow.md) | MVを第一級ユースケースにする制作・同期・QA契約 |
| [h3-prompt-v3.md](./h3-prompt-v3.md) | `video_prompt v2` と H3 grammar/compiler workflow v3 |
| [runtime-and-recovery.md](./runtime-and-recovery.md) | single writer、branch invalidation、resume、generationJobs接続 |
| [launcher-and-visualization.md](./launcher-and-visualization.md) | 現行3D無表示の診断、可視fallback、次期Mission Tree表示 |
| [learning-loop.md](./learning-loop.md) | feedbackからrule候補、実験、承認済みrevisionへ進む学習ループ |
| [observability-and-evaluation.md](./observability-and-evaluation.md) | 人間介入、自動回復、一貫性、品質/credit、MV同期の評価 |
| [migration-and-release.md](./migration-and-release.md) | 後方互換、導入順、release / rollback 方針 |
| [implementation-plan.md](./implementation-plan.md) | 実装単位、主な変更先、テスト、完了条件 |

### 要件対応

| 要件 | 正本 |
| --- | --- |
| 階層的な専門分業 | architecture / contracts |
| shared state | immutable artifact + Coordinator projection |
| 条件付き自動回復 | contracts / runtime-and-recovery |
| 数日〜数週間の中断・再開 | architecture / runtime-and-recovery |
| Identity Lock統合 | contracts / MV workflow / H3 prompt |
| MV制作 | mv-workflow / H3 prompt |
| H3 / MiniMax H3 prompt改善 | h3-prompt-v3 |
| Launcher 3D無表示の修復 | launcher-and-visualization / implementation-plan PO-0A |
| 学びの候補化・実験・昇格 | learning-loop |
| 測定可能な改善 | observability-and-evaluation |
| 導入順と次version | migration-and-release / implementation-plan |

## 4. Truth の優先順位

設計と実装が食い違った場合は、次の順で判断する。

1. 現在選択された `project.yaml` と pinned source asset
2. 既存 Gate / run `state.json`
3. provider job の durable store
4. immutable contract / artifact と digest chain
5. Coordinator の `coordination-state.json` projection
6. Launcher の表示
7. advisory knowledge / story / prompt catalog

`coordination-state.json` と Launcher は projection であり、Gate、provider job、pinned artifact を上書きしない。

## 5. 維持する安全境界

- `project.yaml` を入口として残す。
- Coordinator だけが coordination state を更新する。
- actual `run` / `render` は Coordinator だけが、人間承認後に行う。
- model と connection と capability を分け、別接続へ自動 fallback しない。
- prompt catalog は advisory。adapter・認証・価格・残高の証明にしない。
- POST の結果不明は `submission_unknown` とし、再送しない。
- 未知価格は実行を止める。
- MIME / SHA-256 / ffprobe / atomic pin を通過した provider output だけ採用する。
- Identity の固定文了承と、生成結果による verification を分ける。
- feedback は append-only。共有ルールへの昇格は人間承認を必要とする。
- final output、QA、manifest参照素材、state、run log、completion recordを保持する。

## 6. 非目標

- agent同士の自由会話を製品価値として見せること。
- roleごとに常駐processを置くこと。
- shotごとに無制限な子agentをspawnすること。
- Gate、費用、外部送信、公開、最終承認をAIへ移すこと。
- provider固有仕様をcore schemaへ直書きすること。
- H3公式 `Context-IR` と TsugiteのCreative IRを同じものとして扱うこと。
- 既存 `h3` requestを一括変換して壊すこと。

## 7. v1.0.0 Exit Criteria

以下をすべて満たすまでは `v1.0.0` としない。

- legacy `project.yaml` が明示 migration なしで validate / plan / review / run可能。
- Mission / Task Treeを中断・再開して同じdigest chainを復元できる。
- 依存枝だけのstale化と再実行が決定的テストで証明される。
- generationJobsの`submission_unknown` no-resubmitとpinned-only採用が維持される。
- Gate 1 approval digestがProductionContract、選択task成果物、connection、予算、recovery policyへ結合される。
- MV fixtureでmaster音源、section、beat、lyrics、caption、Identity optionalityがend-to-end検証される。
- H3 legacy goldenが不変で、`video_prompt v2`の新goldenが追加される。
- feedbackから実験済みproposalを作れても、人間承認なしに共有ruleが変わらない。
- Launcherがtree / stale / awaiting-human / blocked理由を、secretやpromptを出さず表示する。
- 3Dを初期化できない環境でも空白にせず、同じ工程を選択できる可視fallbackと公開診断codeを表示する。
- [observability-and-evaluation.md](./observability-and-evaluation.md) の最低指標がrun artifactとして残る。
- 固定build/test、Windows smoke、security/path adversarial testsがすべてgreen。
