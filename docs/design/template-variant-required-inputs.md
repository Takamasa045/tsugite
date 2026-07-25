# 設計メモ: パターン（variant option）別 required_inputs 調整

**状態:** 設計のみ（Phase 4・MVP 非実装）  
**対象:** `template.yaml` の schema / ランチャー API 透過  
**正本参照:** `src/viewer/launcher.ts`（`templateVariantSchema` / `templateMetadataSchema`）

---

## 1. 現状（Phase 3 済み時点）

- `required_inputs` は **テンプレート単位** のみ。各項目は `{ type, label, required }`。
- `variants[].options[]` は `{ id, label, description }` のみ。option によって入力必須が変わらない（→ Phase 4 で拡張予定）。
- ランチャー API（Phase 3）は **全入力を透過**し、`required` フラグを載せる:

```ts
requiredInputs: metadata.required_inputs.filter((i) => i.required).map((i) => i.label) // 互換: 必須 label のみ
requiredInputDetails: metadata.required_inputs.map((i) => ({ type, label, required: i.required }))
```

- UI の準備チェックリストは `required` で必須/任意を振り分ける。
- 実テンプレ（例: `commerce-showcase`）では「使い方実演」で実写 video が実質必須でも、template 全体では `video.required: false` のまま（パターン別昇格は Phase 4）。

---

## 2. 提案フィールド（後方互換）

`schema_version: 1` のまま、**option に optional フィールドを追加**する。未知フィールド拒否（`.strict()`）は実装時にスキーマ拡張で解く。

| フィールド | 位置 | 意味 |
|---|---|---|
| `required_inputs_add` | `variants[].options[]` | base の任意入力のうち、この option 選択時に **必須へ昇格**する label 一覧 |
| `required_inputs_remove`（任意・将来） | 同上 | base 必須を緩和。MVP 設計では **使わない**（誤用で必須欠落しやすい） |

```yaml
required_inputs:
  - type: image
    label: 商品写真
    required: true
  - type: video
    label: 開封・利用の実写素材
    required: false   # base は任意

variants:
  - id: story
    label: 訴求構成
    default_option: benefit-first
    options:
      - id: benefit-first
        label: 価値先行
        description: ...
        # required_inputs_add なし → base のまま
      - id: usage-demo
        label: 使い方実演
        description: 開封、準備、使い方、結果を実物で見せます。
        required_inputs_add:
          - 開封・利用の実写素材   # label 参照で必須昇格
```

**制約案（実装時）:**

- `required_inputs_add` の各要素は、同一 template の `required_inputs[].label` と一致すること。
- 参照先が base で既に `required: true` でも **冪等**（エラーにしない）。
- 存在しない label は metadata 無効（`template_metadata.invalid`）。

既存 YAML にフィールドが無くても現状どおり動く。

---

## 3. 解決アルゴリズム

選択中 option 集合を `S` とする（variant ごとに 1 option。未選択時は `default_option`、無ければ先頭）。

```
resolved = []
for each input in required_inputs (宣言順):
  effective_required =
      input.required
      OR (input.label ∈ ∪ option.required_inputs_add for option in S)
  resolved.push({ type, label, required: effective_required })
```

**例（commerce-showcase 想定）:**

| 選択 | video「開封・利用の実写素材」 |
|---|---|
| story=価値先行 | 任意（base） |
| story=使い方実演 | **必須**（add で昇格） |
| story=使い方実演 + format=15秒ショート | **必須**（他 option は触らない） |

複数 variant の add は **和集合**。必須は一度昇格したら下がらない（remove 無し前提）。

表示用:

- `requiredInputs`: `resolved` のうち `required === true` の label
- 任意も含めて見せる UI は `resolved` 全体（`required` フラグ付き）を使う

---

## 4. API 透過（Phase 3 前提）

Phase 4（option 別 add）の前に、**Phase 3** で次を満たす:

1. `required: false` を捨てない。`requiredInputDetails` に **全** `required_inputs` を載せる。
2. 各 detail に `required: boolean` を載せる（現状の `{ type, label }` を拡張）。

```ts
// 現状
type LauncherTemplateInput = { type; label }

// Phase 3 以降
type LauncherTemplateInput = { type; label; required: boolean }
```

3. `requiredInputs: string[]` は互換のため **必須 label のみ** のまま維持してよい。
4. UI は `required` を見て「必須 / あるとよい」を区別できる。option 選択 UI が無い間は template 単位の base 値だけを表示。

Phase 4 では、クライアントまたはサーバで選択 option に対し §3 を適用し、同じ shape の `resolved` を返す／計算する。option 上の raw `required_inputs_add` を UI にそのまま晒す必要はない。

---

## 5. 非目標（今回・MVP）

- **実装しない**（スキーマ変更・API・UI・テンプレ YAML 更新すべて Phase 4 以降）。
- option ごとの入力 **追加定義**（base に無い type/label を option だけで新設）はしない。
- `required_inputs_remove` / 必須緩和、option 別 label 差し替え、実行時 Gate 検証との連動は対象外。
- schema_version 上げや engine 固有フィールドは入れない。
- カタログが実行能力・利用権を証明する表示にはしない（既存方針維持）。

---

## 実装時の着手順（参考）

1. Phase 3: filter 撤廃 + `required` フラグ透過 + UI 表示区別  
2. Phase 4: option に `required_inputs_add`、label 参照 validation、解決関数、選択 UI 連動  
3. テンプレ YAML へ必要な option だけ add を追記（例: usage-demo → video）
