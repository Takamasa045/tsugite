# 設計メモ: テンプレート演出指針（direction）

**状態:** 提案1 実装（MVP）  
**対象:** `template.yaml` の optional `direction` / ランチャー API 透過 / 制作ブリーフ  
**正本参照:** `src/viewer/launcher.ts`（`templateDirectionSchema` / `mapTemplateDirection`）、`apps/workflow-viewer/src/components/template/templateShelfModel.ts`（`buildTemplateBriefMarkdown`）

---

## 1. 問題

コピーされる制作ブリーフには型名・選択 option・用意する素材・向かない用途・音声メモが入るが、**どう見せるか（演出）** が無い。貼り付け先のモデルが演出を全部埋め、等間隔カット・同じカメラワーク・フックなし導入に収束しやすい。

## 2. 提案1（本実装）

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

## 3. 非目標（MVP 外・後続）

| 提案 | 内容 | 着手条件 |
|---|---|---|
| 2 | option ごとの `direction_add`（base + 選択の和集合） | Phase 4 `required_inputs_add` と同型で |
| 3 | `knowledge/video-models/*/prompt-guide.yaml` の documented チェックリストをブリーフへ | 生成エンジン選択がフローに入った時点 |
| 4 | ショットリスト単調さ lint（尺分散・同カメラ連続・フック欠落） | 出口側で独立実装可 |
| 5 | option に good / monotonous 具体例 | 提案1安定後 |

## 4. 安全

- ブリーフ用メタデータのみ。`run` / `render` / Gate を起動しない
- モデル別ガイドの有無を実行能力とみなさない（提案3でも同じ）
