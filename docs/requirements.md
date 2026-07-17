# tsugite（仮称）要件定義書

エンジン非依存の動画編集パイプライン。
生成アダプタ（CLI / MCP）と編集バックエンド（Remotion / HyperFrames）を、
manifest（EDL）という単一の契約で接続する「砂時計型」アーキテクチャ。

- 版: v0.2（2026-07-09）
- 状態: ドラフト（Phase 0 骨格は Codex により実装着手済み）
- リポ名「tsugite（継手）」は仮称。確定後にディレクトリごとリネームする
- v0.2 変更点: 解析アダプタ（class: analysis）追加、非クリエイティブ用途を
  スコープに明記、manifest に chapters[] / 話者ラベルを予約、
  MCP 試験導入ベンダーとして Topview を選定

### 現在の実装メモ

- `guides` は config 不要・副作用なしでモデル別prompt knowledgeを一覧・解決する。カタログの存在はadapterや実行権限を意味しない。
- `plan` / `run --dry-run` はrequestの `input_mode` と `prompt_guide.catalog` に応じた `prompt_guidance` を返すが、prompt自体は変更しない。
- `doctor --config` はNode 22、npm 10以上、ffprobe、project validation、選択backend runner、backend/adapterが宣言したsetup check、preflight executableを副作用なしで確認する。不足時はplatform別の`remediation`を返し、機械検査できないhandoff/認証は`status: manual`としてready扱いしない。
- Gate 2 は `approve_all` を実装済み。`retry_specific` は対象clipの差し替え契約が未実装のため、曖昧に成功させず明示エラーにする。
- Gate 3 は `approve` / `re-render` / `abort` を実装済み。`re-render` はGate 1 / 2承認を維持する。
- Gate 3 QCは最終MP4のprobe、映像/音声stream、尺、解像度、fpsを検査する。カット順・黒画面・無音区間の検査は今後の拡張対象。
- `analyze` はCoordinatorの明示実行で、元素材を変更せず `dist/<run-id>/analysis/` にraw analysis、editorial proposal、agent handoffを生成する。既定の`local`はAPI-freeで、request単位の複数offline adapter、FFmpeg無音検出、明示済みローカル`.pt`による文字起こし・フィラー候補・章・抽出的要約・英訳字幕を扱う。任意の`hybrid`は低信頼transcript segmentだけ、`cloud`は選択source mediaだけを宣言済みonline adapterへ渡せるが、Coordinatorに加えて実行ごとの外部送信許可が必須。削除やmanifest反映は行わない。

---

## 1. 背景と目的

### 1.1 背景

- 既存の `pixverse-shotpack` / `pixverse-character-pipeline` は PixVerse 公式に
  ショーケースとして掲載されているため、Kling 等の他社エンジンを組み込めない
- 一方で、生成エンジン（Kling、PixVerse、今後登場する CLI / MCP ベンダー）と
  編集手段（Remotion、HyperFrames）はどちらも増え続けることが確実
- 運用で得た教訓（モデル制約、fps、同時実行数など）が repo ごとに散在し、
  同じ失敗を繰り返すリスクがある

### 1.2 目的

1. **ベンダー中立の編集パイプライン**を独立リポとして確立する
   （コア部分に特定エンジン・特定ベンダーの名前もコードも持ち込まない）
2. 生成エンジン N 個 × 編集バックエンド M 個の組み合わせを、
   **N+M 個のアダプタ実装**で吸収する（N×M の統合地獄を避ける）
3. 失敗を「LESSONS 台帳 → 実行チェック昇格 → 契約文書昇格」の
   **3段階学習ループ**で機械化し、同じミスを構造的に繰り返さない
4. エージェント（Claude Code / Codex）が自然言語依頼から
   計画 → 承認 → 実行 → QC まで自走できる契約（`.agents/skills/tsugite/SKILL.md`）を備える
5. 本リポの本質は「manifest（EDL）駆動の動画処理基盤」であり、
   クリエイティブ生成は入力の一形態にすぎない。文字起こし→テロップ、
   データ駆動の定型動画量産などの**非クリエイティブ用途も第一級のユースケース**とする

### 1.3 既存リポとの関係

```
pixverse-shotpack ──┐ manifest（RenderManifest互換）
                    ├──────────────→ tsugite が編集入力として受け取れる
pixverse-character- ┘
pipeline
```

- 依存は**一方通行**。公式 PixVerse リポは tsugite を一切参照しない
- 接続はコード依存ではなく「manifest 互換」という文書化された契約のみ
- 公式リポには今後も他社エンジン関連の変更を加えない

---

## 2. スコープ

### 2.1 やること（in scope）

- manifest（EDL）スキーマの定義と検証
- `bin/pipeline` CLI（doctor / validate / plan / analyze / review / feedback / run / render。Shitate連携時のみ任意の `shitate-import`）
- 生成アダプタ機構（kind: cli / mcp-agent / mcp-client）
  - 初期実装: `adapters/kling/`、`adapters/pixverse/`
- 解析アダプタ機構（class: analysis — 出力がクリップではなく manifest メタデータ）
  - 候補実装: 文字起こし（ElevenLabs MCP speech_to_text / whisper）、
    無音・シーン検出によるカット点提案
- 非クリエイティブ用途のサポート
  - 文字起こし→テロップ焼き込み、横→縦リフレーミング、長尺の切り出し・チャプター化、
    データ駆動の定型動画量産、多言語展開（翻訳+TTS+字幕差し替え）、
    音声コンテンツの動画化、アーカイブの一括QC
  - **クリップ生成ゼロでも project として成立する**
    （最小構成 = 手持ち動画 + テロップ入れのみ）
- 編集バックエンド機構（capabilities 宣言つき）
  - 初期実装: `backends/remotion/`、`backends/hyperframes/`
- Gate（人間承認ポイント）と再開可能な実行状態管理
- 学習ループ（ローカル `feedback.jsonl`、LESSONS.md、constraints.md、validate への人間承認付き昇格手順）
- エージェント契約（`.agents/skills/tsugite/SKILL.md` 正本、Codex / Claude Code 両skill入口、CLAUDE.md / AGENTS.md 常時ガイド）

### 2.2 やらないこと（out of scope）

- PixVerse 公式リポ（shotpack / character-pipeline）への変更
- 動画生成エンジン自体の実装（アダプタは既存 CLI / MCP のラッパーに徹する）
- 素材のアップロード・SNS 投稿などの配信工程（既存の別パイプラインの責務）
- コア実行系へ統合されたGUI / 編集UI（実行入口は引き続きエージェント対話とCLIのみ）。読み取り専用の可視化は独立した `apps/workflow-viewer/` として分離する
- ffmpeg 直接編集（編集は Remotion / HyperFrames バックエンド経由。
  ffprobe による検証利用は可）

---

## 3. 全体アーキテクチャ

```
生成アダプタ（可変）            中立コア                 編集バックエンド（可変）
adapters/kling      ─┐                              ┌─ backends/remotion
adapters/pixverse   ─┼→  dist/ clips + manifest ────┼─ backends/hyperframes
adapters/<future>   ─┘   （EDL・唯一の正本契約）      └─ backends/<future>
                              ↑
                    bin/pipeline が全工程を統括
                    （doctor/validate/plan/run/render）
                              ↑
                    各 project.yaml が唯一の実行入口
```

### 3.1 ディレクトリ構成

```
tsugite/
├── .agents/skills/tsugite/SKILL.md # Codex / 共通オーケストレータ契約（正本）
├── .claude/skills/tsugite/SKILL.md # Claude Code skill入口
├── SKILL.md               # 旧ツール向け互換入口
├── CLAUDE.md              # Claude Code 常時ガイド
├── AGENTS.md              # Codex / OpenAI 系常時ガイド
├── LESSONS.md             # ミス台帳（症状/原因/ルール、追記専用）
├── examples/              # 配布用のコピー可能な project サンプル
│   └── local-fixture/
│       ├── project.yaml
│       ├── manifest.json
│       └── media/
├── projects/              # ユーザー作業用（projects/* は git 管理外）
├── bin/
│   └── pipeline           # CLI エントリポイント
├── src/                   # コア実装（TypeScript）
│   ├── manifest/          # スキーマ・検証・変換
│   ├── orchestrator/      # 工程管理・Gate・状態保存
│   ├── adapters/          # アダプタ読み込み・共通契約
│   └── backends/          # バックエンド読み込み・共通契約
├── manifest/
│   └── schema.md          # manifest スキーマ正本（RenderManifest 互換）
├── adapters/
│   ├── kling/             # kind: cli（constraints.md 同梱）
│   └── pixverse/          # kind: cli（constraints.md 同梱）
├── backends/
│   ├── remotion/          # capabilities.yaml + constraints.md
│   └── hyperframes/       # capabilities.yaml + constraints.md
├── knowledge/
│   └── video-models/      # 出典・鮮度付きのT2V/I2V prompt knowledge（実行能力とは分離）
├── skills/                # 役割別 skill（editor / qc / assembler）
├── references/
│   ├── exit-codes.md      # 終了コード・リトライ契約
│   └── lessons-graduation.md  # LESSONS → validate 昇格手順
├── fixtures/              # テスト用の小さな素材・manifest サンプル
└── dist/                  # 実行成果物（git 管理外）
```

---

## 4. 機能要件（FR）

### FR-1: manifest（EDL）スキーマ

manifest は生成側と編集側の**唯一の合意点**。

- 形式: JSON（`dist/<run-id>/manifest.json`）
- 既存の RenderManifest と互換を維持する（shotpack の出力を無変換で受け取れる）
- 最低限のフィールド:
  - `meta`: aspect（16:9 / 9:16）、fps、target_duration_seconds、slug
  - `clips[]`: id、src（ローカルパス必須）、in/out、duration、fps、resolution、
    audio 有無
  - `audio`: bgm / narration / sfx のトラック定義
  - `images[]`: ID参照できるローカル画像素材。clip/audioと同様に安全な相対path、存在、run directoryへの事前copy、decode、alpha要件、SHA-256、Gate 2再開整合を検査
  - `speakers[]`: 話者ID、表示名、左右配置、色、poseからimage IDへの対応
  - `presentation`: backendがcapabilitiesで宣言するpresetと出典metadata
  - `captions[]`: テキスト・タイミング（バックエンドが対応する場合のみ）。
    話者ラベル（speaker）に加え、pose、強調語、中央図解metadataを任意で保持
  - `chapters[]`: チャプター定義（title、start、end）。将来枠として予約
  - `provenance[]`: 各クリップの生成元（engine、model、params、消費クレジット）
- analysis付きprojectでは `edit.editorial` の明示選択とGate 1承認後に、source/output対応・削除範囲・digestを持つ `editorial-edl.json` を生成し、編集済みmanifestの `clips[]` / `captions[]` / `chapters[]` へ決定的に反映する
- EDL未選択候補は保持し、全編削除、未知ID、未承認digest、EDL／編集manifest改ざん、外部audioの不確実な再配置、generationとの未対応な併用はfail closedとする
- Gate 2は字幕・章を含む編集manifest、EDL、run log、QC、backendの承認digestをstateへ保持し、render直前に再検査する
- スキーマ検証は `pipeline validate` が実行（スキーマ違反は実行前に拒否）
- スキーマ変更は `manifest/schema.md` の更新と CHANGELOG 追記をセットで行う

### FR-2: `bin/pipeline` CLI

projectを扱うサブコマンドは `--config <project.yaml>` を受け取り、全サブコマンドが `--json` 出力に対応する。`guides` だけはproject非依存の読み取り専用コマンドなのでconfig不要。

| コマンド | 責務 |
|---------|------|
| `doctor` | 副作用なしの環境検査（Node 22、npm 10以上、ffprobe、project validation、選択backend runner、宣言済みsetup/version/environment/preflight検査）。不足時は`remediation`を返す。認証や実プロバイダー疎通は行わず、手動確認を`status: manual`で返す |
| `guides` | モデル別prompt knowledgeの一覧・モデル/T2V/I2V解決。実行可否は判定せず、外部APIを呼ばない |
| `validate` | project.yaml / manifest のスキーマ検証 + constraints 由来の機械チェック |
| `shitate-import`（任意） | Shitateの選定済みrunとanchorをproject内のSHA-256 lock付きsnapshotへコピーし、manifestと任意のI2V requestへ安全に割り当てる。通常のTsugite利用には不要で、生成・Gate更新・外部送信はしない |
| `plan` | 実行計画の提示（カット一覧、工程、推定クレジット、推定尺 vs 目標尺） |
| `review` | 検証済みproject / manifest / planからGate 1前の静的HTML・ReviewDocument JSON・参照画像copyを生成。外部生成、Gate更新、state書き込みは行わない。Gate 1承認はcanonicalなreview artifactを検査する |
| `viewer` | 検証済みproject / planと現在のstate・run-log・review・Gate QC成果物から、読み取り専用の3D Workflow Viewer静的HTML / JSONを生成する。run-logの実行サマリーと生成リクエストをノード詳細へ表示し、完全な履歴がない場合は工程順からtimelineを決定的に再構成する |
| `feedback` | `key`、分類、`prefer / avoid / keep` signal、学習状態、要約と任意の相対evidenceを検証し、project直下の `feedback.jsonl` へ1件追記する。prompt、template、check、運用ruleは変更しない |
| `run --dry-run` | 生成・編集を実行せず、全工程の手順とコストを出力 |
| `run` | 生成アダプタ実行 → QC → manifest 構築（Gate で停止・再開可能） |
| `render` | 選択された編集バックエンドで最終 MP4 を出力 |

- `run` / `render` は**明示的なコマンド実行でのみ**動く。
  エージェントが承認なしに生成・レンダリングへ自動遷移することを禁止する
- 実行状態は `dist/<run-id>/state.json` に保存し、中断からの再開を可能にする
- 同一 run-id に対する生成の多重実行を防ぐ（冪等性）

### FR-3: 生成アダプタ契約

アダプタは `adapters/<engine>/` に自己完結で置く。

**共通契約（全 kind 共通）:**
- 入力: 生成リクエスト（prompt、model、duration、aspect、seed、その他 params）
- 出力: `dist/<run-id>/` 配下のローカルファイル + メタデータ JSON
  （engine、model、実パラメータ、消費クレジット、所要時間）
- 成果物は **ffprobe が通るローカルファイル**であることをアダプタの責務とする
  （URL や非同期ジョブ ID を返すベンダーの場合、ダウンロード完了までがアダプタ内）
- エラーは `references/exit-codes.md` の正規化コードに変換する
- リトライポリシー（回数・対象コード）をアダプタ定義で宣言する
- `constraints.md` を必ず同梱（モデル制約・失敗パターン・料金の教訓置き場）

**kind 別の要件:**

| kind | 実行主体 | 用途 |
|------|---------|------|
| `cli` | bin/pipeline が直接実行 | バッチ・自動リトライ・dry-run 見積もり可 |
| `mcp-agent` | エージェントが skill.md の手順で MCP ツールを呼ぶ | 新ベンダーの試験導入（導入コスト最小） |
| `mcp-client` | bin/pipeline 内の MCP SDK クライアント | 常用化した MCP ベンダーの決定的実行 |

- 昇格ルート: `mcp-agent` で試験導入 → 常用経路になったら `mcp-client` へ実装昇格
- `validate` は kind を見て「dry-run 見積もり可能か」「バッチ可能か」を判定する
- `cli` アダプタは `adapter.yaml` の `command` で `stdin-json` wrapper を宣言する。
  wrapper は `{ request, run_id, run_dir }` を受け取り、外部 CLI の戻り値を
  Tsugite 標準の `{ request_id, credits, clips[], metadata }` JSON に正規化する。
  実 CLI の仕様差分は adapter 配下に閉じ込め、core へ漏らさない。

**class 軸（kind と直交する分類）:**

| class | 出力 | 例 |
|-------|------|----|
| `generation` | 新規クリップ（dist/ のローカルファイル） | kling、pixverse、Topview |
| `analysis` | source timestamp付きtranscript / subtitle track / summary / chapters / カット点提案 | 文字起こし、無音・フィラー検出、英訳字幕、抽出的整理 |

- analysis アダプタはクレジット見積もり・Gate 2 QC の対象外とできる
  （メディアファイルを新規生成しないため）。ただし出力メタデータの
  スキーマ検証は generation と同様に validate が行う
- online analysis adapterは `offline: false` と `network.input_scope` を必須とし、credentialは宣言した環境変数だけを受け取る。`local`はonline adapterを拒否し、`hybrid`はoffline transcriptに依存する低信頼segment補正だけを許可する。実送信は `--allow-external-analysis` がない限り開始しない

### FR-3.1: モデル別 prompt knowledge

- 実行adapterとモデル知識を分離し、`knowledge/video-models/<catalog>/prompt-guide.yaml` に置く。
- 各catalogは `model` / alias、`input_mode`、T2V/I2V template、checklist、avoid、negative方針、公式source、確認日、再確認期限を持つ。
- requestの `input_mode` は `text-to-video | image-to-video` を明示する。coreは `params` から推測しない。
- 実行adapterとcatalogが異なる場合だけ `prompt_guide.catalog` を指定する。未指定時はadapter名と同じcatalogを探索する。
- `plan.prompt_guidance` は `matched` / `catalog-missing` / `model-unmatched` / `input-mode-unset` / `input-mode-unsupported` を明示し、別モデルのrecipeへ黙ってfallbackしない。
- guidanceはGate 1前の助言であり、promptの自動書き換え、adapter可用性の保証、実行承認を行わない。
- `verified_at` と `review_after` から鮮度を示し、staleは警告扱いとして人間またはPlannerが公式資料を再確認する。
- adapterは対応 `input_modes` と各modeのrequired/forbidden paramsを宣言できる。明示 `input_mode` と実行parameterが矛盾するrequestはクレジット消費前にvalidateで拒否する。

### FR-4: 編集バックエンド契約

バックエンドは `backends/<name>/` に自己完結で置く。

- 入力: manifest + dist/ 上の素材ファイル
- 出力: 最終 MP4 + レンダーレポート（実尺、解像度、fps、警告）
- **capabilities.yaml** を必ず持つ:
  - 対応機能の宣言（captions、transitions、audio-mix、vertical、対応 fps、
    audio-reactive、presentation preset など）
  - 実行前チェックは `checks.render_preflight[]` に `name` と `command[]` で宣言する
  - `validate` は「manifest が要求する機能 ⊆ 選択バックエンドの capabilities」を
    実行前にチェックし、不一致なら拒否する
- バックエンド固有の検証コマンドを組み込む:
  - remotion: TypeScript コンパイル + composition props 検証
  - hyperframes: manifest から最小 `index.html` を生成し、
    `npx --no-install hyperframes lint --json` → `npx --no-install hyperframes render --output final.mp4`
- バックエンド選択は `project.yaml` の `edit.backend: remotion | hyperframes`

### FR-5: Gate（人間承認ポイント）

各 Gate で停止し、承認・修正指示・中止を受け付ける。状態保存により再開可能。

| Gate | タイミング | 提示内容 | 選択肢 |
|------|-----------|---------|--------|
| Gate 1 | plan / review 直後 | 一枚絵コンテHTML、ReviewDocument JSON、カット一覧、工程、推定クレジット、推定尺 vs 目標尺 | approve / revise / abort |
| Gate 2 | 生成完了後 | クリップ一覧、QC 結果、実績クレジット | approve_all / revise / abort（retry_specific は未実装） |
| Gate 3 | render 完了後 | 最終 MP4、レンダーレポート、尺・解像度・fps・映像/音声stream・黒画面・長い無音の検査結果 | approve / re-render / abort |

- Gate 2 の QC は asset-qc 相当（ffprobe + manifest 整合）を機械実行してから提示
- Gate 3 の現行 QC は最終MP4に対して、映像/音声stream、尺、解像度、fpsに加え、1秒以上の黒区間と3秒以上の無音区間を機械検査してから提示する。内容解析を実行できない場合も承認不可とする。意味的なカット順の検査は今後の拡張対象

### FR-6: 学習ループ（同じミスを繰り返さない仕組み）

捕獲、分類、昇格、検証の構造を repo の仕組みとして持つ。生成回数だけを学習とは扱わない。

1. **捕獲**: `pipeline feedback` で、案件ごとの構造化記録を
   `projects/<job>/feedback.jsonl` にローカル追記する。同じ好みには案件をまたいで同じ
   `key` を付ける。失敗から再利用ルールが生まれた場合は `LESSONS.md` にも1行追記する
   （形式: 日付 / 症状 / 原因 / ルール）。どちらも追記専用とし、書くコストを最小化する
2. **状態**: feedbackは `observed`（初回記録）→ `recurring`（同じ `key` の反復）→
   `promoted`（共有先へ反映済み）→ `verified`（後続出力で改善確認）として追跡する。
   `recurring` の昇格案は `pending`（承認待ち）→ `approved`（承認済み・反映待ち）または
   `rejected`（見送り）を別軸で持つ。反復検出と承認記録だけでは自動昇格しない
3. **分類**: 一回限りの好みは `projects/<job>/notes.md` と `feedback.jsonl`、再利用する好みは
   `examples/` または `templates/`、公開契約の変更は README / `manifest/schema.md` /
   `docs/requirements.md` に置く
4. **昇格承認**: 反映先、変更内容、検証方法が揃った時点で昇格案を作り、ランチャーに
   「昇格承認待ち」として表示する。人は根拠と案を確認して承認または見送りを記録する。
   承認は実装開始の許可であり、template、rule、check、Gate、stateを自動変更しない
   ランチャー起動中は、利用者がブラウザ通知を許可した場合に30秒間隔で承認待ちを確認し、
   未通知の提案IDが増えた時だけデスクトップ通知する。待ち件数は「好み・学び」タブにも表示する。
   通知済みIDはブラウザのローカルストレージに最大128件保持し、同じ提案を繰り返し通知しない
5. **実行チェックへ昇格**: 人間の承認後、コードで判定できるルールは
   `pipeline validate` / `doctor` のチェックとして実装し、
   LESSONS.md の該当行に `validate済` / `doctor済` / `qa済` / `documented` を付記する
   （例: 「モデル X は 10 秒非対応」→ validate が実行前に拒否）
   再発防止の fixture とテストも同時に追加する
6. **QA へ昇格**: Gate 2 / Gate 3 で判定すべきルールは check、report schema、
   fixtures、tests を同時に更新する
7. **契約文書へ昇格**: コード化できない判断ルール（演出・構成系）は
   `.agents/skills/tsugite/SKILL.md` / CLAUDE.md の運用ルール節へ転記する
8. **検証**: 昇格後の出力で同じ問題が再発しないことを確認し、根拠を持つ記録だけを
   `verified` とする

- エンジン固有の教訓は `adapters/<engine>/constraints.md`、
  バックエンド固有の教訓は `backends/<name>/constraints.md` に隔離する
- 昇格手順は `references/lessons-graduation.md` に文書化する
- 月次で LESSONS.md を棚卸しし、昇格漏れを確認する（運用ルール）
- ランチャーの「好み・学び」棚は `projects/*/feedback.jsonl` を読み取り専用で横断集計する。
- ランチャーは最大128案件を対象に、各案件の最新記録・診断を公平に配分して合計1000項目以内で表示する。上限到達時は診断として明示する。
- デスクトップ通知はブラウザの明示許可とランチャーの起動を必要とし、常駐サービスや外部通知先は使わない。
  prompt、template、check、運用ruleを書き換える権限は持たない

### FR-7: エージェント運用契約

- `.agents/skills/tsugite/SKILL.md` をCodexとClaude Codeの共通正本とし、`.claude/skills/tsugite/SKILL.md` はdirectory symlinkに依存しない薄い入口にする
- `AGENTS.md` と `CLAUDE.md` には常時必要な承認境界と入口だけを置き、詳細手順を重複させない
- generationを計画するエージェントは `guides` と `plan.prompt_guidance` を確認し、適用したcatalog/model/input modeをGate 1で提示する
- サブエージェント分担（character-pipeline の型を踏襲）:
  - Coordinator: project.yaml の所有者。最終 `run` / `render` を実行できる唯一の役割
  - Planner / Reviewer: validate / plan / dry-run 担当。読み取り専用
  - Output QA: manifest・成果物・尺の検査担当。読み取り専用
- レビュー配線（`.agents/skills/tsugite/SKILL.md` に明記する）:
  - パイプラインのコード変更後 → code-reviewer
  - Gate 2 のクリップ検品 → asset-qc
  - Gate 3 のレンダー検査 → video-qa
  - 企画フェーズ → video-director
- 協調ルール: project.yaml を編集できるのは Coordinator のみ。
  並列ワーカーは read-only / dry-run のみ

---

## 5. 非機能要件（NFR）

- **NFR-1 決定性**: ルーティング・リトライ・変換・検証はすべてコードで行う。
  モデル（エージェント）の判断に委ねるのは創作判断と例外対応のみ
- **NFR-2 冪等性・再開性**: 全工程は run-id 単位で状態保存し、
  中断・再実行しても二重生成（二重課金）が起きない
- **NFR-3 クレジット保護**: クレジットを消費する工程の前に必ず
  見積もり提示（plan / dry-run）と Gate 承認を挟む
- **NFR-4 エラー処理**: 全レベルで明示的に処理し、沈黙の失敗を作らない。
  スキップした工程は「完了」と報告しない
- **NFR-5 秘密情報**: API キー・認証情報はコード・設定ファイルに
  ハードコードしない。環境変数または各 CLI の認証機構に委譲する
- **NFR-6 コード規約**: immutable パターン、1ファイル 200〜400 行目安（最大 800）、
  関数 50 行以内、境界での入力検証（既存グローバル規約に準拠）
- **NFR-7 ログ**: 各 run の実行ログを `dist/<run-id>/run-log.md` に残し、
  レビューHTML/JSONの相対パスとともに LESSONS 記入の一次資料とする

---

## 6. Non-Negotiable Rules

1. **公式ショーケース入りしたリポ（pixverse-shotpack / pixverse-character-pipeline）
   に他社エンジンのコード・名前を持ち込まない。エンジン統合は本リポのアダプタで行う**
2. コア（src/、manifest/、`.agents/skills/tsugite/SKILL.md`）に特定ベンダー名・ベンダー固有コードを置かない。
   ベンダー固有の実行物は adapters/ と backends/、出典付き助言データは knowledge/video-models/ に閉じ込める
3. 依存は一方通行: 公式リポ → manifest → 本リポ。逆参照ゼロ
4. 生成アダプタの成果物は必ずローカルファイル（ffprobe 通過）として dist/ に置く
5. `run` / `render` は明示的な指示と Gate 承認なしに実行しない
6. manifest の RenderManifest 互換を破壊する変更をしない
   （破壊的変更が必要な場合はバージョンフィールドで区別する）
7. 外部 CLI 呼び出しには機械可読出力オプション（`--json` 等）を必ず付ける

---

## 7. テスト方針

- **ユニットテスト**: manifest スキーマ検証、capabilities 照合、plan 計算、
  prompt guide schema/解決、exit-code 正規化、state.json の遷移。カバレッジ 80% 以上（コア src/ 対象）
- **統合テスト**: fixtures/ の小さな素材と manifest サンプルを使い、
  `validate → plan → run --dry-run` をアダプタのモックで通す。
  バックエンドは fixtures 素材で実レンダー（数秒の MP4）まで検証する
- **E2E（手動 Gate 込み）**: 実案件1本を Phase ごとの受け入れ基準として使う
  （クレジット消費を伴うため CI には含めない）
- TDD で進める: スキーマ検証・plan 計算など決定的ロジックはテスト先行

---

## 8. 受け入れ基準（成功条件）

| # | 基準 | 検証方法 |
|---|------|---------|
| AC-1 | ローカル素材のみの project.yaml から validate → run → render（remotion）で MP4 が出る | E2E 実行 |
| AC-2 | AC-1 と同じ manifest を `edit.backend: hyperframes` に切り替えてレンダーできる | E2E 実行 |
| AC-3 | kling アダプタで 生成 → QC（Gate 2）→ 編集 → 最終 MP4 まで通る | E2E 実行（実クレジット） |
| AC-4 | shotpack が出力した既存 manifest を無変換で受け取り render できる | fixtures に実 manifest を置いて統合テスト |
| AC-5 | validate が constraints 由来の機械チェックを 3 件以上実装している | テストコードで確認 |
| AC-6 | capabilities 不一致（例: captions 非対応バックエンドに captions 要求）を validate が実行前に拒否する | ユニットテスト |
| AC-7 | コアに対するベンダー名の grep がゼロ件（adapters/ backends/ を除く） | `grep -ri` を CI チェック化 |
| AC-8 | 実運用で発生した失敗 1 件が LESSONS.md → validate 昇格まで 1 周している | LESSONS.md と該当テストの存在 |
| AC-9 | mcp-agent 型アダプタ 1 つが skill.md 定義のみで動作する | E2E 実行 |

---

## 9. 実装フェーズ

各フェーズ完了時に「やったこと / 検証済みのこと / 残り」を要約してから次へ進む。

- **Phase 0: 骨格 + manifest**
  - ディレクトリ構成、Codex / Claude Code skills、CLAUDE.md / AGENTS.md、LESSONS.md（空で設置）
  - manifest スキーマ定義 + 検証実装（テスト先行）
  - `pipeline doctor` / `validate`
  - 完了条件: AC-7 の CI チェックが通る、スキーマ検証のユニットテストが green
- **Phase 1: backends/remotion + ローカル素材 E2E**
  - remotion バックエンド（capabilities 宣言込み）、`plan` / `run` / `render`
  - 生成なし・手持ち素材のみで 1 本通す
  - E2E 実案件の推奨: **手持ち動画への文字起こしテロップ入れ**
    （クレジット消費ゼロで manifest → Gate → render の全経路を検証できる）
  - 完了条件: AC-1、AC-4、AC-6
- **Phase 2: adapters/kling（kind: cli）**
  - kling / pixverse アダプタ + constraints.md、stdin-json wrapper、Gate 2 QC、クレジット見積もり
  - 完了条件: AC-3、AC-5
- **Phase 3: backends/hyperframes**
  - hyperframes バックエンド（lint 統合、manifest 由来 HTML 生成、render CLI 呼び出し、capabilities 宣言）
  - 完了条件: AC-2
- **Phase 4: MCP アダプタ**
  - Topview を mcp-agent 型で試験導入 → 必要になったら mcp-client 昇格
  - 完了条件: AC-9
- **Phase 5: 学習ループの実証**
  - 実案件で出た失敗を LESSONS → validate 昇格まで 1 周
  - 完了条件: AC-8

Phase 0〜1 が最小の価値単位（既存素材の編集リポとして自立）。
Phase 2 以降は独立に前後可能。

---

## 10. リスク

| リスク | 影響 | 対応 |
|--------|------|------|
| RenderManifest 互換の解釈ズレ（shotpack 側の暗黙仕様） | AC-4 失敗 | Phase 0 で shotpack の実 manifest を fixtures 化し、スキーマを実物から逆算する |
| HyperFrames の composition 生成が manifest から自動化しきれない | Phase 3 遅延 | capabilities を狭く宣言して部分対応から始める（全機能対応を初期要件にしない） |
| Kling の CLI 経路（初期は PixVerse CLI 経由想定）の仕様変更 | Phase 2 手戻り | アダプタ契約で隔離済み。乗り換え時もアダプタ内の書き換えで完結 |
| MCP ベンダーの非同期ジョブ・URL 失効の癖 | 成果物取りこぼし | 「ローカルファイル化までがアダプタ責務」の契約で吸収。癖は constraints.md へ |
| 学習ループが形骸化する（書かれない台帳） | 本来の目的が未達 | 記入形式を1行に固定、run-log.md を一次資料化、月次棚卸しを運用ルール化 |

---

## 11. 未決事項

| # | 事項 | 現時点の仮置き |
|---|------|--------------|
| 1 | リポ名の確定 | tsugite（継手）仮称。cutlab / edit-forge も候補 |
| 2 | Kling を叩く初期経路 | PixVerse CLI の Kling 対応を私的リポ内で利用（専用 CLI / API への乗り換えはアダプタ内で吸収） |
| 3 | Phase 4 の MCP 試験導入ベンダー | **Topview に決定**（2026-07-09 に topview-skill / topview-mcp / Codex プラグインを導入済み。mcp-agent 型アダプタ第1号の実装対象） |
| 4 | GitHub リモート（public / private） | private 前提。public 化する場合は AC-7（ベンダー名 grep）を再確認 |
| 5 | `Projects/作品/Pixverse-Workflow`（3週間古い重複クローン）の扱い | 本リポとは別件だが、混乱防止のため同期または撤去を推奨 |
