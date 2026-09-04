# テンプレートカタログ

ランチャーの「テンプレート」タブは、公開同梱の `bundled-templates/` と、workspace の `templates/` 直下にある `template.yaml` を読み取り専用で表示します。同じ `id` がある場合は workspace 側を優先します。メタデータは用途を比較するための説明であり、実行能力、利用権、Git公開可否を証明するものではありません。

公開同梱は `commerce-showcase` / `creative-short` / `explainer-talk` / `footage-editorial` の4件です。手元の `templates/` に同 ID がある場合、bundled の `direction` は見えなくなります。演出指針を残すなら workspace 側にも `direction` を書いてください。

## 配置

```text
bundled-templates/          # git 管理。Desktop / クローン直後の棚
└── commerce-showcase/
    └── template.yaml

templates/                  # workspace private。gitignore。同 ID はこちらが優先
└── my-template/
    ├── template.yaml
    ├── README.md
    └── project.yaml
```

フォルダ名と `id` は一致させ、小文字英数字とハイフンだけを使います。`template.yaml` がない補助フォルダはカタログ対象外です。

## schema version 1

```yaml
schema_version: 1
kind: tsugite-template
id: my-template
name: サンプルテンプレート
summary: 何を入力すると、どのような動画になるかを一文で説明します。
category: 記事を動画化
use_cases:
  - ブログ記事
output:
  duration:
    mode: fixed
    min_seconds: 60
    max_seconds: 60
    label: 60秒
  aspect_ratios:
    - "16:9"
  speaker_count: 2
required_inputs:
  - type: text
    label: 記事本文
    required: true
# ai_can_propose:
#   - タイトル案
#   - CTA文言
direction:
  pacing: 冒頭2秒以内にフック。カット尺は均等割りせず、見せ場前に短カットを密集させる
  camera: 1ショットにつきカメラの動きは1つ。隣接ショットで画角（引き/寄り）を交互にする
  light_color: 導入は低彩度→結論で彩度と光量を上げる
  motif: 反復モチーフは3回登場し、3回目は変化をつけて回収する
  transitions: 使うトランジションは2種類まで。意味のある場面転換にだけ使う
  audio_sync: カット点をBGMのビートまたはナレーションの句点に合わせる
tags:
  - 解説
audio:
  narration: optional
  bgm: optional
  silent_draft: true
  notes: 音声未指定時は無音ドラフトになります。
status: stable
distribution: local-only
```

`status` は `stable` / `experimental` / `deprecated`、`distribution` は `bundled` / `local-only` を指定します。`distribution` はランチャー上の表示区分であり、アクセス制御やGit公開判定には使用しません。

### `direction`（任意・schema_version 1）

制作ブリーフへ載せる**演出指針**です。何を作るか（summary / variants / required_inputs）に対し、どう見せるかをテンプレート作成時に固定します。未指定でも有効です。1つ以上のフィールドが必要です。各値は最大600文字です。

| YAML | API / ブリーフ表示 |
|---|---|
| `pacing` | `direction.pacing` / テンポ |
| `camera` | `direction.camera` / カメラ |
| `light_color` | `direction.lightColor` / 光と色 |
| `motif` | `direction.motif` / モチーフ |
| `transitions` | `direction.transitions` / トランジション |
| `audio_sync` | `direction.audioSync` / 音との同期 |

ランチャーの制作ブリーフ（コピー用 Markdown）に `## 演出指針` として出ます。生成・実行・Gate を起動する能力ではありません。

### `direction_add`（option 任意・schema_version 1）

`variants[].options[]` に付けられる演出の**追加行**です。テンプレート単位の `direction` を base とし、選択中 option の `direction_add` を**和集合**でブリーフへ並べます（上書きではなく追記。同じキーでも base と option を別行で出します）。

```yaml
variants:
  - id: format
    label: 尺と画面
    options:
      - id: short-15
        label: 15秒ショート
        description: 商品、価値、CTAだけを一つずつ見せます。
        direction_add:
          pacing: フックは0.5秒以内、最長カット2秒
      - id: short-30
        label: 30秒CM
        description: 課題または価値、実演、根拠、CTAをまとめます。
```

- フィールド形状は `direction` と同じ（1つ以上必須、各最大600文字）
- API では `directionAdd`（camelCase）として透過
- ブリーフでは option 由来の行に `（option ラベル）` を付けて区別する

### `examples`（option 任意）

選択 option の**良い例 / 単調な例**です。抽象指針より具体例のほうがコピペ先に効きます。

```yaml
examples:
  good:
    - 0.5秒で商品を出し、価値とCTAを各1カットに絞る
  monotonous:
    - 全カット3秒均等で同じズームを3連続させる
```

- `good` / `monotonous` は各1〜2件（どちらか一方だけでも可）
- ブリーフの `## 具体例` に載る

### `required_inputs_add`（option 任意・Phase 4）

base の `required_inputs` のうち **任意** を、この option 選択時に必須へ昇格する label 一覧です。

```yaml
required_inputs:
  - type: video
    label: 開封・利用の実写素材
    required: false
variants:
  - id: story
    options:
      - id: usage-demo
        label: 使い方実演
        description: ...
        required_inputs_add:
          - 開封・利用の実写素材
```

- label は同一 template の `required_inputs[].label` と一致必須（不一致は metadata 無効）
- 既に `required: true` でも冪等
- 複数 option の add は和集合。必須は下がらない
- API: `requiredInputsAdd`。UI / ブリーフは選択に応じて必須・任意を再計算

### `ai_can_propose`（template 任意・schema_version 1）

AI が**制作依頼の初案**として提案してよい項目の label 一覧です。生成・実行・Gate 更新は行わず、制作依頼 Markdown / チェックリスト UI の表示範囲だけを示します。

```yaml
ai_can_propose:
  - タイトル案
  - CTA文言
  - カット間のつなぎ
```

| 項目 | 契約 |
|---|---|
| YAML | `ai_can_propose`（template ルート） |
| API | `aiCanPropose`（camelCase） |
| 任意性 | 未指定可。既存テンプレートは無効にならない |
| 件数・型 | 非空文字列 1〜12 件 |
| 重複 | trim 後の重複は `template_metadata.invalid` |
| 必須競合 | base `required_inputs` の `required: true`、またはいずれかの `required_inputs_add` と **完全一致**すると invalid |
| 任意一致 | optional（`required: false` かつどの `required_inputs_add` にも出ない）との一致は許可 |
| 未指定時 | UI の AI 節・コピー範囲の「AIに任せること」文言・制作依頼の `## AIに任せること` を省略 |
| 指定時 | 制作依頼に `## AIに任せること` を載せ、チェックリストで「最低限渡すもの」と分離表示。**生成・実行・Gate 更新はしない** |

### `prompt_guide_catalog`（template または option 任意）

`knowledge/video-models/<id>/prompt-guide.yaml` の **documented** 共通チェックリストをブリーフへ載せるための catalog id です。

```yaml
prompt_guide_catalog: pixverse   # template 既定（任意）
# または option:
# prompt_guide_catalog: pixverse
```

- API は `promptGuideCatalog` と、解決済み要約 `promptGuides[]`（`catalogId` / `displayName` / `checklist` / `disclaimer`）を返す
- ブリーフの `## 生成プロンプトの書式` に disclaimer 付きで載る
- **カタログの存在は実行能力・利用権・接続状態を証明しない**（既存方針）

## 安全条件

- `template.yaml` は64 KiB以下の通常ファイルにし、symlinkを使用しない
- 未知フィールド、未知のschema version、ID不一致は無効として表示する
- APIはメタデータだけを返し、README全文、絶対パス、manifest、成果物を配信しない
- テンプレート棚からコピー、生成、`run`、`render`、Gate更新は行わない
