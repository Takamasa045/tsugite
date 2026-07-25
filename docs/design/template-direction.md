# 設計メモ: テンプレート演出指針（direction）と周辺

**状態:** 提案1–5 実装  
**対象:** template ブリーフ入口 + review 出口の単調さ検出  
**正本参照:**

- `src/viewer/launcher.ts`（direction / direction_add / examples / prompt_guide_catalog）
- `apps/workflow-viewer/.../templateShelfModel.ts`（`buildTemplateBriefMarkdown`）
- `src/orchestrator/shotlistMonotony.ts` + `review.ts` 警告合流

---

## 問題

制作ブリーフに「どう見せるか」が無いと、コピペ先が等間隔カット・同カメラ連続・フックなし導入に収束しやすい。出口（review）でも単調さを早めに証拠として出したい。

## 実装済み

| 提案 | 内容 |
|---|---|
| 1 | template `direction` → ブリーフ `## 演出指針` |
| 2 | option `direction_add` → base との和集合（上書きしない） |
| 3 | template/option `prompt_guide_catalog` → documented チェックリストを `## 生成プロンプトの書式` |
| 4 | `lintShotlistMonotony` → review 警告 `[単調さ]`（Gate 自動操作なし） |
| 5 | option `examples.good` / `examples.monotonous` → ブリーフ `## 具体例` |

### 提案3の方針

- エンジン選択 UI はテンプレ棚に増やさない
- option（例: 生成を計画して使う）または template が catalog id を宣言したときだけ載せる
- `common.checklist` のうち `evidence: documented` のみ
- disclaimer 必須: カタログは実行能力を証明しない

### 提案4の検出

| code | 条件（既定） |
|---|---|
| `shotlist.duration_low_variance` | 3ショット以上かつ (max-min)/mean < 0.12 |
| `shotlist.camera_repeat` | 正規化カメラ/モーションが3連続 |
| `shotlist.missing_early_hook` | 尺が2秒超なのに冒頭2秒内に短い境界・hook 役割が無い |

カメラ信号は review の motion preset を代理に使う。警告は `warnings[]` へ追記するだけで Gate を拒否しない。

## 安全

- テンプレ棚は閲覧・ブリーフコピーのみ。`run` / `render` / Gate を起動しない
- prompt-guide catalog は能力証明に使わない
- 単調さ lint は証拠提示のみ
