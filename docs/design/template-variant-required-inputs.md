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
