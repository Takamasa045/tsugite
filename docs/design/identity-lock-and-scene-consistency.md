# 設計メモ: アイデンティティ・ロックとシーン一貫性（長尺・ストーリー制作向け）

**状態:** Phase A–E 実装済み（branch `codex/identity-lock-scene-consistency` / PR #118）。M0 契約は `identity-lock-m0-contract.md`。
**対象:** キャラ一貫性の機械的固定 + シーン層の共有ブロック + プロンプト骨格カタログ + イテレーション規律
**正本参照:**

- `src/videoPromptDirector/schema.ts`（video_prompt IR: `subjects` / `shots` / `subject_expectations`）
- `src/videoPromptDirector/videoPromptCompile.ts` + `compile.ts`（Writer 相当）
- `src/videoPromptDirector/validation/`（Auditor 相当）
- `src/videoPromptDirector/lineage.ts`（プロンプト系譜）
- `src/project/schema.ts`（`generation.requests[]`）
- `knowledge/video-models/`（モデル別 advisory カタログ）
- `knowledge/story-frameworks/catalog.yaml`
- `docs/shitate.md`（キャラ資産のロック済み取り込み）

---

## 背景と問題

text-to-video 主体の長尺・複数ショット制作で崩れるのは主に 3 点。

1. **キャラのドリフト**: 声・外見・話し方の記述をショットごとに手で書く（または少し言い換える）と、モデルに記憶がないため別人化する。
2. **空間のテレポート**: ショット間でロケーション記述が揺れると、位置関係・アンカー・照明が毎回リセットされる。
3. **原因不明の劣化**: 一度に複数箇所を書き換えて再生成すると、どの変更が効いたか追えない。

外部の長編 AI 映画制作事例から抽象化できる構造的対策は「毎回すべてを記述する」「記述は固定して一字も変えない」「1 回に 1 つだけ変える」。本設計はこの 3 原則を Tsugite の既存層（IR / compile / validate / knowledge / lineage / QC）に機械チェック可能な形で載せる。事例固有の表現・プロットは持ち込まない（AGENTS.md の抽象化ルールに従う）。

## 提案一覧

| 提案 | 内容 | 主な変更先 |
|---|---|---|
| 1 | 固定ブロック（locked blocks）: verbatim 注入 + ハッシュ検証 | IR schema / compile / validate |
| 2 | subject の状態別バリアントと `locked` フラグ | IR schema / plan 警告 |
| 3 | シーン層: 共有ブロックの全ショット自動注入 | IR schema / compile / validation |
| 4 | プロンプト骨格カタログ（ブロック順・FOV・演技記法） | knowledge / model prompt profile |
| 5 | イテレーション規律: 1 変更 lint + ショット分割提案 | lineage / review 警告 |

---

## 提案1: 固定ブロック（locked blocks）

キャラの声・外見・演技マナーを **改変禁止の verbatim テキスト** としてプロジェクトに保存し、compile が毎ショットそのまま注入する。

### データモデル

`video_prompt` IR の subject に追加:

```yaml
subjects:
  - id: cal
    locked_blocks:
      voice:
        text: |
          （声の register / tempo / accent / manner を書いた固定文。以後一字も変えない）
        sha256: "…"        # text の sha256。validate が再計算して照合
      appearance:
        text: "…"
        sha256: "…"
      manner:               # 演技の癖。感情語ではなく身体動作で書く（提案4の記法）
        text: "…"
        sha256: "…"
```

### 振る舞い

- **compile**: 対話・登場があるショットの AUDIO / CHARACTER ブロックへ `locked_blocks` の `text` を無加工で連結する。要約・言い換え・省略はしない。
- **validate**: `sha256(text) !== sha256` を **エラー** にする。意図的な改稿は「text と sha256 を同時に更新する」明示操作のみ（CLI: `bin/pipeline lock-block --subject cal --field voice` が再計算して書き戻す。書き戻しは新オブジェクト生成で行い、既存 YAML の他フィールドは保持）。
- **lineage**: 固定ブロックの sha256 をショット生成レコードに記録し、「どの版の声で生成したか」を追跡可能にする。

### 判断根拠

ドリフトの主因は「善意の言い換え」。人間にもエージェントにも起こるため、注意書きではなくハッシュ照合で機械的に止める（LESSONS 昇格方針: machine-checkable な失敗は validate へ）。

## 提案2: 状態別バリアントと locked フラグ

同一人物の状態違い（清潔 / 濡れ / 負傷など）は 1 記述に混ぜると不安定になるため、**別アセットに分離** する。

```yaml
subjects:
  - id: cal
    locked: true            # 一貫性検証済み。false のまま本番生成に使うと plan が警告
    variants:
      - id: clean           # 既定
        source_asset: cal_sheet_clean
      - id: wet
        source_asset: cal_sheet_wet
shots:
  - id: s12
    cast:
      - subject: cal
        variant: wet        # 未指定は既定 variant
```

- **validate**: `variant` 参照先の存在、variant id の一意性、`source_asset` の定義済みチェック（既存の subject 検証と同型）。
- **plan**: `locked: false` の subject を含む生成計画に警告を出す。ストレステスト（複数条件で生成して同一性を目視確認）はクレジットを消費するため **自動実行しない**。人間が確認して `locked: true` を立てる運用とし、Tsugite の「計画から課金実行へ自動遷移しない」原則を守る。
- Shitate import 済みスナップショット（SHA-256 ロック済み）は `source_asset` の供給源としてそのまま使える。

## 提案3: シーン層と共有ブロック注入

ショットの上に **scene** を導入し、シーン不変の要素を全ショットへ compile 時に自動注入する。

```yaml
scenes:
  - id: boatyard_night
    location_map: |
      （アンカー基準の空間記述。「左」ではなく「ランプの前」「柱の脇」で書く）
    palette: "…"            # 世界観カラー。LIGHTING / STYLE へ展開
    active_subjects: [cal, horace]
shots:
  - id: s12
    scene: boatyard_night
```

- **compile**: `location_map` / `palette` を該当ショットの LOCATION / LIGHTING ブロックへ verbatim 注入。ショット側での上書きは不可、追記のみ可。
- **validation（Auditor 追加チェック 2 件）**:
  - `scene.location_map_mismatch`: 同一 scene のショット間で注入後の LOCATION ブロックが一致しない（上書き検出）。
  - `scene.undeclared_subject`: ショット本文・cast に scene の `active_subjects` 外の subject が出現。
- **story-frameworks カタログ追記（advisory）**: シーン冒頭に「広角・約 1 秒・セリフなしのマスターショットでブロッキングを固定する」推奨を追加。Gate は操作しない。

## 提案4: プロンプト骨格カタログ

ブロック順の骨格・FOV 指定・演技記法を `knowledge/` の advisory カタログとして追加する。エンジン非依存の構造は共通カタログへ、モデル固有の癖（安定 FOV 帯など）は `knowledge/video-models/<model>/` へ置く（コア中立の不可侵ルール）。

### 内容

- **ブロック骨格**: SCENE CONTEXT → ACTIVE REFERENCES → LOCATION MAP → FIRST FRAME / BLOCKING → OPTICS → CAMERA → ACTION TIMING → PHYSICS → LIGHTING → AUDIO → CHARACTER ACTING → STYLE → QUALITY → POSITIVE CONSTRAINTS の順序テンプレート。ネガティブ表現を使わず肯定形で書く方針を明記。
- **OPTICS**: FOV を度数で 1 ショット 1 値固定。モデル別の安定帯はモデル側カタログに記載。
- **演技記法**: 感情ラベル禁止・身体動作（筋肉・視線・呼吸）で記述・1〜2 秒ごとのマイクロイベント・目標と障害、を documented チェックリストとして提供。
- **compile テンプレート**: model prompt profile がこの骨格を宣言した場合、compile は IR の各フィールドを骨格順に整列して出力する。宣言がなければ従来出力（後方互換）。

カタログは能力証明に使わない（disclaimer 必須、`docs/prompt-guides.md` と同方針）。

## 提案5: イテレーション規律

| code | 条件（既定） | 出力先 |
|---|---|---|
| `iteration.multi_block_change` | 同一ショットの直前生成版とのプロンプト diff が 2 ブロック以上 | review 警告 |
| `iteration.retry_saturation` | 同一ショットの再生成が 10 回に達した | review 警告 + 「ショット分割・単純化」の提案文 |

- 判定は lineage レコードの決定的比較のみで行う（モデル判断を使わない）。
- 警告は証拠提示のみ。Gate 決定・再生成の自動化はしない。

---

## 実装フェーズ

| Phase | 範囲 | 完了条件 |
|---|---|---|
| A | 提案1（固定ブロック + ハッシュ検証 + verbatim 注入） | **完了** — `test/locked-blocks-phase-a.test.ts`。LOCK-E001 / verbatim 注入 / lineage / `lock-block` CLI / golden 不変 |
| B | 提案3（シーン層 + Auditor 2 チェック） | **完了** — `test/scenes-phase-b.test.ts`。LOCATION prepend / scene.* Auditor / scenes なし golden 不変 / story principle |
| C | 提案2（バリアント + locked 警告） | **完了** — `test/variants-phase-c.test.ts`。variants/cast 解決 + `identity.subject_unlocked` |
| D | 提案4（骨格カタログ + compile テンプレート） | **完了** — `test/skeleton-phase-d.test.ts` + `knowledge/prompt-skeletons/` |
| E | 提案5（lineage lint） | **完了** — `test/iteration-discipline-phase-e.test.ts` + lineage `block_digests` |

各 Phase は TDD（RED → GREEN → REFACTOR）で進め、スキーマ追加はすべて optional にして既存 `project.yaml` の後方互換を保つ。

## 安全・不変条件

- knowledge カタログは advisory。実行アダプタ・エンティトルメントの存在証明に使わない。
- 全チェックは validate / plan / review の警告・エラーとしてのみ働く。Gate の自動承認・自動再生成・課金実行は一切追加しない。
- ストレステストなどクレジット消費を伴う確認は人間の明示操作のみ。
- 外部事例からは構造的役割のみ抽象化し、固有の表現・プロット・実在人物の likeness は扱わない。
- 固定ブロックの書き戻しを含む YAML 更新は新オブジェクト生成で行い、無関係フィールドを変更しない。
