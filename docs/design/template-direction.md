# 設計メモ: テンプレート演出指針（direction）

**状態:** 提案1・提案2 実装  
**対象:** `template.yaml` の optional `direction` / option `direction_add` / ランチャー API 透過 / 制作ブリーフ  
**正本参照:** `src/viewer/launcher.ts`（`templateDirectionSchema` / `mapTemplateDirection`）、`apps/workflow-viewer/src/components/template/templateShelfModel.ts`（`resolveDirectionLines` / `buildTemplateBriefMarkdown`）

---

## 1. 問題

コピーされる制作ブリーフには型名・選択 option・用意する素材・向かない用途・音声メモが入るが、**どう見せるか（演出）** が無い。貼り付け先のモデルが演出を全部埋め、等間隔カット・同じカメラワーク・フックなし導入に収束しやすい。

## 2. 提案1（実装済み）

`schema_version: 1` のまま、任意ブロック `direction` を追加する。未知フィールド拒否はスキーマ拡張で解く（`.strict()`）。

```yaml
direction:
  pacing: ...
  camera: ...
  light_color: ...
  motif: ...
  transitions: ...
  audio_sync: ...
```

- 全フィールド optional、ただしブロックがあるなら **1つ以上必須**
- 各値は `descriptionText`（1〜600文字）
- API は camelCase（`lightColor` / `audioSync`）で透過
- `buildTemplateBriefMarkdown` が `## 演出指針` を出力
- カタログは閲覧専用・実行能力を証明しない方針を維持

## 3. 提案2（実装済み）

Phase 4 の `required_inputs_add` と同型で、option に任意 `direction_add` を付ける。

```yaml
variants:
  - id: format
    options:
      - id: short-15
        label: 15秒ショート
        description: ...
        direction_add:
          pacing: フックは0.5秒以内、最長カット2秒
```

### 解決アルゴリズム

選択中 option 集合を `S` とする（variant ごとに 1 option。未選択はスキップ）。

```
lines = []
for each field in direction field order:
  if base.direction[field]: lines.push({ label, text: base, source: undefined })
for each option in S (variant 宣言順):
  for each field in direction field order:
    if option.direction_add[field]:
      lines.push({ label, text: add, source: option.label })
```

- **上書きしない**（和集合・追記）。同じキーでも base と option は別行。
- option 由来はブリーフで `**テンポ（15秒ショート）**: ...` のように source を括弧付け。
- `direction_add` の形状・制約は `direction` と同じ。
- API は `options[].directionAdd` として透過。raw の未解決 add を UI がそのまま必須表示する必要はない。

## 4. 非目標（後続）

| 提案 | 内容 | 着手条件 |
|---|---|---|
| 3 | `knowledge/video-models/*/prompt-guide.yaml` の documented チェックリストをブリーフへ | 生成エンジン選択がフローに入った時点 |
| 4 | ショットリスト単調さ lint（尺分散・同カメラ連続・フック欠落） | 出口側で独立実装可 |
| 5 | option に good / monotonous 具体例 | 提案1–2 安定後 |

`required_inputs_add` 本体（Phase 4）は本メモの対象外。同型パターンとして参照するだけ。

## 5. 安全

- ブリーフ用メタデータのみ。`run` / `render` / Gate を起動しない
- モデル別ガイドの有無を実行能力とみなさない（提案3でも同じ）
