# 設計メモ: パターン（variant option）別 required_inputs 調整

**状態:** Phase 4 実装済み  
**対象:** `template.yaml` の schema / ランチャー API 透過 / チェックリスト UI / 制作ブリーフ  
**正本参照:** `src/viewer/launcher.ts`（`required_inputs_add`）、`apps/workflow-viewer/.../templateShelfModel.ts`（`resolveRequiredInputDetails`）

---

## 1. 背景

- `required_inputs` はテンプレート単位。
- option によって「実写が実質必須」などが変わる（例: 使い方実演）。
- Phase 3 で `required` フラグ透過は済み。Phase 4 で option 別昇格を実装。

## 2. フィールド

| フィールド | 位置 | 意味 |
|---|---|---|
| `required_inputs_add` | `variants[].options[]` | base の任意入力のうち、この option 選択時に **必須へ昇格**する label 一覧 |

- `required_inputs_remove` は使わない（誤用で必須欠落しやすい）。
- schema_version 1 のまま optional 拡張。

## 3. 解決

選択 option 集合 `S`（未選択は default / 先頭）について:

```
effective_required = (input.required !== false) OR (label ∈ ∪ option.requiredInputsAdd)
```

- 和集合。必須は一度昇格したら下がらない。
- UI の必須/任意とブリーフの「用意するもの」はこの resolved を使う。

## 4. 検証

- `required_inputs_add` の各 label は `required_inputs[].label` に存在すること。無いと `template_metadata.invalid`。
- base で既に必須でも冪等。

## 5. 安全

- テンプレ棚は閲覧・ブリーフコピーのみ。生成・Gate を起動しない。
- option だけの type/label 新設はしない。

## 6. 任意拡張: `ai_can_propose` / API `aiCanPropose`

**状態:** schema_version 1 の optional 拡張（後方互換）

| フィールド | 位置 | API | 意味 |
|---|---|---|---|
| `ai_can_propose` | `template.yaml` ルート | `aiCanPropose` | AI が初案を出してよい項目（非空文字列 1〜12） |

### 契約

- **YAML / API**: `ai_can_propose` → `aiCanPropose`（任意フィールド）。
- **件数・型**: 非空文字列 1〜12 件。空配列・空文字・非配列・13件超は `template_metadata.invalid`（fail closed）。
- **未指定**: 既存テンプレートは無効にならない。UI の「AIに任せられること」節、コピー範囲説明の「AIに任せること」文言、閲覧専用注記の AI 委任説明、制作依頼 Markdown の `## AIに任せること` をいずれも省略する（コピー対象に AI 項目があると誤認させない）。
- **指定あり**: 制作依頼に `## AIに任せること` を載せ、チェックリスト主要画面で「最低限渡すもの」と「AIに任せられること」を分離表示する。コピー範囲・閲覧専用注記にも AI 委任の扱いを含める。**生成・実行・Gate 更新は行わず、制作依頼の初案範囲だけを示す。**
- **重複**: trim 後に同一の `ai_can_propose` 項目が複数あると `template_metadata.invalid`（fail closed）。エラー文に重複 label を含める。
- **必須との競合**（fail closed）:
  - base `required_inputs` で `required: true` の label と trim 後完全一致 → invalid
  - いずれかの variant option の `required_inputs_add` が参照する label と trim 後完全一致 → invalid
  - optional（`required: false` かつどの `required_inputs_add` にも出てこない）との一致は許可（任意提供 + 未指定時 AI 提案）
- **防御層**（schema 通過後・直呼び）: prompt builder / `resolveAiCanPropose` / `TemplateChecklist` は trim→一意化のうえ、**現在の選択で必須になった label** と一致する AI 候補を必須優先で除外し、矛盾指示を出さない。コピー範囲説明と閲覧専用注記の AI 委任文言も `aiCanPropose.length > 0` のときだけ表示する。
- **未指定時の運用**: AI 委任項目の欠落を必須不足として止めない。正本素材と選択設定から初案を提案し、提案であることを明示する。事実・実績・権利情報・正本素材は創作しない。CTA 等の創作文言自体は禁じない。
- 生成・Gate・実行境界は変えない。任意素材の非コピー、表現候補の別コピー、prompt guide の詳細扱いも維持する。
