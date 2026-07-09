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
   計画 → 承認 → 実行 → QC まで自走できる契約（SKILL.md）を備える
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
- `bin/pipeline` CLI（doctor / validate / plan / run / render）
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
- 学習ループ（LESSONS.md、constraints.md、validate への昇格手順）
- エージェント契約（SKILL.md 正本、CLAUDE.md / AGENTS.md 両入口）

### 2.2 やらないこと（out of scope）

- PixVerse 公式リポ（shotpack / character-pipeline）への変更
- 動画生成エンジン自体の実装（アダプタは既存 CLI / MCP のラッパーに徹する）
- 素材のアップロード・SNS 投稿などの配信工程（既存の別パイプラインの責務）
- GUI / Web UI（エージェント対話と CLI が唯一のインターフェース）
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
                    project.yaml が唯一の実行入口
```

### 3.1 ディレクトリ構成

```
tsugite/
├── SKILL.md               # オーケストレータ契約（正本）
├── CLAUDE.md              # Claude Code 入口ガイド
├── AGENTS.md              # Codex / OpenAI 系入口ガイド（SKILL.md のミラー）
├── LESSONS.md             # ミス台帳（症状/原因/ルール、追記専用）
├── project.yaml           # 実行入口（案件ごとに project.<slug>.yaml）
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
  - `captions[]`: テキスト・タイミング（バックエンドが対応する場合のみ）。
    話者ラベル（speaker）を任意フィールドとして予約
  - `chapters[]`: チャプター定義（title、start、end）。将来枠として予約
  - `provenance[]`: 各クリップの生成元（engine、model、params、消費クレジット）
- スキーマ検証は `pipeline validate` が実行（スキーマ違反は実行前に拒否）
- スキーマ変更は `manifest/schema.md` の更新と CHANGELOG 追記をセットで行う

### FR-2: `bin/pipeline` CLI

全サブコマンドで `--config <project.yaml>` を受け取り、`--json` 出力に対応する。

| コマンド | 責務 |
|---------|------|
| `doctor` | 環境検査（依存 CLI の存在、認証状態、バックエンドの動作確認） |
| `validate` | project.yaml / manifest のスキーマ検証 + constraints 由来の機械チェック |
| `plan` | 実行計画の提示（カット一覧、工程、推定クレジット、推定尺 vs 目標尺） |
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

**class 軸（kind と直交する分類）:**

| class | 出力 | 例 |
|-------|------|----|
| `generation` | 新規クリップ（dist/ のローカルファイル） | kling、pixverse、Topview |
| `analysis` | manifest メタデータ（captions[] / chapters[] / カット点提案） | 文字起こし、無音・シーン検出 |

- analysis アダプタはクレジット見積もり・Gate 2 QC の対象外とできる
  （メディアファイルを新規生成しないため）。ただし出力メタデータの
  スキーマ検証は generation と同様に validate が行う

### FR-4: 編集バックエンド契約

バックエンドは `backends/<name>/` に自己完結で置く。

- 入力: manifest + dist/ 上の素材ファイル
- 出力: 最終 MP4 + レンダーレポート（実尺、解像度、fps、警告）
- **capabilities.yaml** を必ず持つ:
  - 対応機能の宣言（captions、transitions、audio-mix、vertical、対応 fps、
    audio-reactive など）
  - 実行前チェックは `checks.render_preflight[]` に `name` と `command[]` で宣言する
  - `validate` は「manifest が要求する機能 ⊆ 選択バックエンドの capabilities」を
    実行前にチェックし、不一致なら拒否する
- バックエンド固有の検証コマンドを組み込む:
  - remotion: TypeScript コンパイル + composition props 検証
  - hyperframes: `npx hyperframes lint --json`
- バックエンド選択は `project.yaml` の `edit.backend: remotion | hyperframes`

### FR-5: Gate（人間承認ポイント）

各 Gate で停止し、承認・修正指示・中止を受け付ける。状態保存により再開可能。

| Gate | タイミング | 提示内容 | 選択肢 |
|------|-----------|---------|--------|
| Gate 1 | plan 直後 | カット一覧、工程、推定クレジット、推定尺 vs 目標尺 | approve / revise / abort |
| Gate 2 | 生成完了後 | クリップ一覧、QC 結果、実績クレジット | approve_all / retry_specific / abort |
| Gate 3 | render 完了後 | 最終 MP4、レンダーレポート、尺・音・カット順の検査結果 | approve / re-render / abort |

- Gate 2 の QC は asset-qc 相当（ffprobe + manifest 整合）を機械実行してから提示
- Gate 3 の QC は video-qa 相当（カット順・音・尺ズレ検出）を機械実行してから提示

### FR-6: 学習ループ（同じミスを繰り返さない仕組み）

3段階の昇格構造を repo の仕組みとして持つ。

1. **捕獲**: 失敗発生時、`LESSONS.md` に1行追記（形式: 日付 / 症状 / 原因 / ルール）。
   追記専用・削除しない。書くコストを最小化する
2. **実行チェックへ昇格**: コードで判定できるルールは
   `pipeline validate` / `doctor` のチェックとして実装し、
   LESSONS.md の該当行に `→ validate済` を付記する
   （例: 「モデル X は 10 秒非対応」→ validate が実行前に拒否）
3. **契約文書へ昇格**: コード化できない判断ルール（演出・構成系）は
   SKILL.md / CLAUDE.md の運用ルール節へ転記する

- エンジン固有の教訓は `adapters/<engine>/constraints.md`、
  バックエンド固有の教訓は `backends/<name>/constraints.md` に隔離する
- 昇格手順は `references/lessons-graduation.md` に文書化する
- 月次で LESSONS.md を棚卸しし、昇格漏れを確認する（運用ルール）

### FR-7: エージェント運用契約

- `SKILL.md` を正本とし、`AGENTS.md` は Codex 向けミラー（既存2リポと同型）
- サブエージェント分担（character-pipeline の型を踏襲）:
  - Coordinator: project.yaml の所有者。最終 `run` / `render` を実行できる唯一の役割
  - Planner / Reviewer: validate / plan / dry-run 担当。読み取り専用
  - Output QA: manifest・成果物・尺の検査担当。読み取り専用
- レビュー配線（SKILL.md に明記する）:
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
  LESSONS 記入の一次資料とする

---

## 6. Non-Negotiable Rules

1. **公式ショーケース入りしたリポ（pixverse-shotpack / pixverse-character-pipeline）
   に他社エンジンのコード・名前を持ち込まない。エンジン統合は本リポのアダプタで行う**
2. コア（src/、manifest/、SKILL.md）に特定ベンダー名・ベンダー固有コードを置かない。
   ベンダー固有物は adapters/ と backends/ の中に完全に閉じ込める
3. 依存は一方通行: 公式リポ → manifest → 本リポ。逆参照ゼロ
4. 生成アダプタの成果物は必ずローカルファイル（ffprobe 通過）として dist/ に置く
5. `run` / `render` は明示的な指示と Gate 承認なしに実行しない
6. manifest の RenderManifest 互換を破壊する変更をしない
   （破壊的変更が必要な場合はバージョンフィールドで区別する）
7. 外部 CLI 呼び出しには機械可読出力オプション（`--json` 等）を必ず付ける

---

## 7. テスト方針

- **ユニットテスト**: manifest スキーマ検証、capabilities 照合、plan 計算、
  exit-code 正規化、state.json の遷移。カバレッジ 80% 以上（コア src/ 対象）
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
  - ディレクトリ構成、SKILL.md / CLAUDE.md / AGENTS.md、LESSONS.md（空で設置）
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
  - kling アダプタ + constraints.md、Gate 2 QC、クレジット見積もり
  - 完了条件: AC-3、AC-5
- **Phase 3: backends/hyperframes**
  - hyperframes バックエンド（lint 統合、capabilities 宣言）
  - 完了条件: AC-2
- **Phase 4: MCP アダプタ**
  - mcp-agent 型を 1 ベンダーで試験導入 → 必要になったら mcp-client 昇格
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
