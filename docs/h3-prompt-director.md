# H3 Prompt Director

H3 Prompt Director は、日本語の企画を **H3 Creative IR v1** に落とし、コードが決定的に英語プロンプトへ compile / validate する Tsugite の versioned contract です。

重要:

- H3 の structured section 文法（`integrated_multimodal_description:` など）は **Tsugite 内部の versioned contract** です。公式 PixVerse / MiniMax の provider 仕様そのものではありません。
- core が通常の手書き prompt を自動書換えする一般機構ではありません。
- 独自 adapter / 独自 Gate はありません。実 run 時だけ既存 PixVerse adapter に final prompt と operation / asset fields を渡します。
- 課金を伴う actual `run` / Gate 承認は、この文書の手順には含めません。

関連:

- モデル別プロンプト知識（advisory）: [prompt-guides.md](./prompt-guides.md)
- 最小 example: [`examples/h3-prompt-director/`](../examples/h3-prompt-director/)
- 追加 fixture（first-frame / first-last / reference）: [`test/fixtures/h3/`](../test/fixtures/h3/)

## 責務境界

```text
日本語企画 / brief
        │
        ▼
  agent（IR authoring）
  · target / mode / subjects / assets / shots / sound を H3 Creative IR v1 にする
  · dialogue / lyrics / on-screen text は原文のまま置く
        │
        ▼
  code（決定的 compile + validate）
  · section 順固定の renderer
  · ラベル番号付け（利用者が <Picture N> / @imageN を手管理しない）
  · H3-E* / PV-E* / H3-W* の静的検証
  · lineage hash（取得不能な hash は書かない）
        │
        ▼
  Gate 1 前の確認
  · validate / plan / review / run --dry-run
  · h3_compilations, prompt, validation, lineage
        │
        ▼
  明示承認後の actual run のみ
  · 既存 PixVerse adapter へ final prompt + operation + asset fields
```

| 担当 | やること | やらないこと |
| --- | --- | --- |
| agent | 日本語企画 → Creative IR、shot / camera / dialogue の設計 | 完成 H3 英語プロンプトの自由作文を最終 intermediate にする |
| code | IR → canonical / adapter prompt の決定的 render、validate、lineage、run artifact | 手書き prompt の一般自動 rewrite |
| prompt guide catalog | matched / unmatched などの助言 | 実行能力の証明、prompt の自動書換え |
| PixVerse adapter | 既存 route で final prompt と media fields を実行 | H3 専用 Gate / 独自 CLI ラッパの新設 |

手書き prompt だけの既存 request は、そのまま後方互換で動きます。`request.h3` が無い request は H3 compiler を通りません。

## H3 Creative IR v1 authoring

`generation.requests[].h3` に置きます。schema 正本は `src/h3/schema.ts` です。

### `version` / `target`

```yaml
h3:
  version: 1
  target:
    model: minimax-h3   # 別名なし。未知 model の fallback なし
    mode: text-to-video # text-to-video | first-frame | first-last | reference
    duration: 10
    quality: "768p"
    aspect: "16:9"
    audio: true
```

- `model` は **`minimax-h3` のみ**（alias / 未知 model fallback なし）。
- `mode` は 4 値だけ。`last-frame-only` は v1 未対応。
- `quality` / `aspect` / `duration` は schema 上モデル一般の受け皿を持ちますが、**実行 route 検証は別**です（後述）。

### `creative`（任意）

意図・トーン・must_include / avoid など。reference renderer の `summary` などに使います。

### `subjects`

```yaml
subjects:
  - id: hero
    description: Japanese man
    speaker_id: S1
    source_asset: character_image   # optional, asset id
    voice:
      description: calm, slightly low voice
      source_asset: voice_audio     # optional
    preservation:
      identity: strict
      clothing: strict
      hairstyle: strict
```

- `speaker_id` は `S1` 形式。
- `source_asset` / `voice.source_asset` は同じ IR 内の asset id を指します。

### `assets`

```yaml
assets:
  - id: character_image
    type: image                 # image | video | audio
    path: assets/hero.png       # 安全な相対 path のみ
    role: subject_reference
```

| role | 用途 |
| --- | --- |
| `first_frame` | first-frame / first-last の開始画像 |
| `last_frame` | first-last の終了画像 |
| `subject_reference` | reference の人物・物体 |
| `motion_reference` | reference の動き |
| `voice_reference` | reference の声 |
| `environment_reference` / `style_reference` / `other` | その他参照 |

path 制約（schema）:

- 相対 path のみ
- `/` 始まり、Windows root、`..`、`\` を拒否

`text-to-video` では実行 asset を置かない（compiler: `H3-C003`）。

### `shots`

```yaml
shots:
  - id: shot_1
    start_ms: 0
    end_ms: 5000
    visual: "Live-action, cinematic. A medium-wide shot frames..."
    camera:
      type: push_in          # push_in/out, zoom_in/out, pan, truck, arc, track, static, hold
      amplitude: small       # small | medium | large
      speed: slow            # slow | medium | fast
      direction: right       # optional
      sentence: "..."        # optional 完全文 override
  - id: shot_2
    start_ms: 5000
    end_ms: 10000
    transition: cut          # cut | none
    visual: "a close-up of his face..."
    camera:
      type: static
    dialogue:
      speaker: hero
      language: Japanese
      text: AIと自然が、やっと同じ場所で動き始めた。
      lock_text: true
      voiceover: false
    on_screen_text: "DAY 01" # 不変
    lyrics: "..."            # 不変
```

ルール:

- Shot 1 は `start_ms: 0`。rendered prompt でも **時刻なし**。
- Shot 2 以降は `start_ms` が **ms 昇順**。render 時は `At 00:05.000, ...` 形式。
- `end_ms > start_ms`。
- dialogue は `speaker` または `speaker_id` が必要。
- `lock_text: true`（default）のとき、rendered `<d>[Language]...</d>` は原文 byte-for-byte。
- `voiceover: true` のとき、off-screen voiceover と **lips remain completely closed** を付与。
- dialogue / lyrics / on-screen text は翻訳・正規化しない。

### `sound`

```yaml
sound:
  soundscape: Soft wind moves through the trees...
  music:
    enabled: false
    # enabled: true のときは description 必須
    # description: Sparse acoustic guitar notes...
```

- `music.enabled: false` → rendered `non_diegetic_music:` は **`N/A`**。

### 最小 T2V 例（概念）

```yaml
generation:
  adapter: pixverse
  connection: pixverse          # validate / plan / review / dry-run 契約に必須
  requests:
    - id: lakeside-t2v
      prompt: ""                 # 空。compiler 出力が single source of truth
      model: minimax-h3
      duration: 10
      aspect: "16:9"
      input_mode: text-to-video
      prompt_guide:
        catalog: pixverse
        model: minimax-h3
      params: {}
      h3:
        version: 1
        target:
          model: minimax-h3
          mode: text-to-video
          duration: 10
          quality: "768p"
          aspect: "16:9"
          audio: true
        subjects:
          - id: hero
            description: Japanese man
            speaker_id: S1
        assets: []
        shots:
          - id: shot_1
            start_ms: 0
            end_ms: 5000
            visual: "..."
            camera: { type: push_in, amplitude: small, speed: slow }
          - id: shot_2
            start_ms: 5000
            end_ms: 10000
            transition: cut
            visual: "..."
            dialogue:
              speaker: hero
              language: Japanese
              text: 原文セリフ
              lock_text: true
              voiceover: true
        sound:
          soundscape: Soft wind...
          music: { enabled: false }
```

完全な parse 可能 example: [`examples/h3-prompt-director/project.yaml`](../examples/h3-prompt-director/project.yaml)。

## Renderer 契約

### Base renderer（3 sections）

対象 mode: `text-to-video` / `first-frame` / `first-last`

順序固定:

1. `integrated_multimodal_description`
2. `overall_soundscape`
3. `non_diegetic_music`

first-frame / first-last では description 冒頭に:

```text
For the target video, at 0.00 seconds into the target video,
<Picture 1> (from [Shot 1]) is fully referenced.
```

### Reference renderer（6 sections）

対象 mode: `reference`

順序固定:

1. `subject_definitions`
2. `summary`
3. `retention_analysis`
4. `detailed_description`
5. `overall_soundscape`
6. `non_diegetic_music`

手動の numbered section override（`<Picture 1>` を利用者が書く full section）は schema が受け付けません。

### ラベル（利用者が番号を手管理しない）

`src/h3/assetLabels.ts` が asset id と **type 内の宣言順**から決定します。

| asset type | H3 label | PixVerse label |
| --- | --- | --- |
| image | `<Picture N>` | `@imageN` |
| video | `<Video N>` | `@videoN` |
| audio | `<Audio N>` | `@audioN` |
| subject | `<Subject N>` | — |

IR 上は `source_asset: character_image` のように id だけを持ち、番号は compiler が付けます。

### セリフ / VO / 音楽

- 通常: `...(S1) says:` + `<d>[Japanese]原文</d>`
- voiceover: `says in an off-screen voiceover:` + tag + `while his lips remain completely closed.`
- music off: `non_diegetic_music:` → `N/A`
- dialogue / lyrics / on-screen text は不変

## mode → generation request mapping

| H3 mode | `operation` | `input_mode` | asset fields |
| --- | --- | --- | --- |
| `text-to-video` | `video` | `text-to-video` | （なし） |
| `first-frame` | `video` | `image-to-video` | `first_frame` |
| `first-last` | `transition` | `transition` | `input_images: [first, last]`（role 順） |
| `reference` | `reference` | `reference` | `input_images` / `input_videos` / `input_audios`（type ごと宣言順） |

compile 後:

- `prompt` = 決定的 render 結果（canonical と pixverse は v1 では同文。将来の label dialect 用に別 field で保持）
- `params.quality` / `params.audio` は IR target から埋まる
- raw `h3` は project digest / Gate 整合用に request 上へ残る
- adapter へ渡す payload は raw `h3` と advisory `prompt_guide` を除く（`toAdapterGenerationRequest`）

author 側の `prompt` / `operation` / asset fields が IR と食い違う場合は compile が拒否します（`H3-C001` / `H3-C002` など。format/route の E/W 表とは別レイヤ）。

## Gate 1 前に確認できること

次は **課金なし**で使えます。

```sh
node bin/pipeline validate --config examples/h3-prompt-director/project.yaml --json
node bin/pipeline plan --config examples/h3-prompt-director/project.yaml --json
node bin/pipeline review --config examples/h3-prompt-director/project.yaml --state-dir <temp>/state --json
node bin/pipeline run --config examples/h3-prompt-director/project.yaml --state-dir <temp>/state --dry-run --json
```

確認ポイント:

- `h3_compilations[]`
  - `canonical_prompt` / `adapter_prompt`
  - `validation`（errors / warnings / ok）
  - `lineage`（`workflow_id: h3-prompt-director`, `workflow_version: "1"`, IR/prompt hashes）
- `prompt_guidance` は advisory（catalog 存在 ≠ 実行能力）
- review HTML に **H3 section**（「H3プロンプト」）が出る
  - request ごとの validation 状態、lineage、canonical / adapter prompt
  - `dist/<run-id>/review/index.html` と `review-data.json`

既存の手書き prompt request は H3 なしのまま plan / review 可能です。

**この文書の手順は actual run・Gate 承認・課金を自動実行しません。**

## actual run 時の流れ

明示承認後の `run` のみ:

1. 再 compile（H3-E / PV-E / compiler 失敗は fail closed）
2. pin / verify 後に durable artifact を書く
3. 既存 PixVerse adapter に final prompt + operation + asset fields を渡す
4. manifest provenance に H3 参照を残す

独自 adapter / 独自 Gate は追加しません。

### run artifact

`dist/<run-id>/h3/<request-id>/`:

| file | 内容 |
| --- | --- |
| `creative-ir.json` | Creative IR |
| `prompt.canonical.txt` | 正規 prompt（末尾改行付き） |
| `prompt.<adapterId>.txt` | adapter 向け prompt（safe adapter id から動的生成。PixVerse project では `prompt.pixverse.txt`） |
| `validation.json` | 静的検証結果 |
| `lineage.json` | workflow / hashes |

lineage の要点:

- `creative_ir_hash` / `canonical_prompt_hash` / `adapter_prompt_hash` は必ず計算
- `prompt_guide_hash` は guide を load できたときだけ
- `asset_hashes` は pin できた regular file だけ（**取得不能 hash を偽装しない**）
- symlink 成分・run dir 外 path は拒否

manifest provenance（概念）:

```json
{
  "h3": {
    "workflow_version": "1",
    "creative_ir_hash": "...",
    "adapter_prompt_hash": "...",
    "artifacts_dir": "h3/<request-id>"
  }
}
```

## 安定エラー / 警告コード

正本は `src/h3/validate/` です。意味は実装から転記しています。

### H3 format errors（`H3-E001`..`H3-E008`）

| code | 意味（実装メッセージ） |
| --- | --- |
| `H3-E001` | 必須 section 不足、または section 順が不正 |
| `H3-E002` | Shot 1 に cut timestamp が付いている |
| `H3-E003` | shot 番号欠落 / 非連続、または shots が空 |
| `H3-E004` | 先頭 shot が 0 ms でない、または cut 時刻が昇順でない |
| `H3-E005` | shot の cut 時刻が target duration を超える |
| `H3-E006` | speaker_id を安定解決できない、または shot 間で変化する |
| `H3-E007` | `lock_text` 付き dialogue が rendered prompt で byte-for-byte 保持されていない |
| `H3-E008` | prompt 内の reference label（`<Picture N>` / `@imageN` など）が未定義 |

### Adapter route errors（`PV-E001`..`PV-E008`）

route の正本は **選択された generation adapter** の `constraints.yaml` 内 `h3_execution_route` です（例: `adapters/pixverse/constraints.yaml`）。
core（`src/h3/validate/adapterRoute.ts`）は provider-neutral な validator と `H3ExecutionRouteProfile` 型だけを持ち、具体 duration / aspect / quality / reference cap は持ちません。

pipeline は二段階です:

1. adapter 未解決前: format / render / asset mapping のみ（接続解決に必要な operation / model / mode を得る）
2. adapter 解決後: 選択 adapter の route profile を注入して **model 完全一致（`H3-C006`）** と `PV-E001`..`E008` を検証し、`h3_compilations.validation` へ merge

`h3_execution_route` を宣言しない adapter で H3 request を実行可能にはしません（`H3-C005` で fail closed）。
`h3_execution_route.model` は **必須 non-empty** で、Stage 2 では各 request の `generation.requests.<i>.h3.target.model` と profile.model を完全一致で照合します。不一致は `H3-C006` で fail closed（quality 用の `PV-E002` には流用しない）。model 欠落・空文字は constraints schema error として拒否し、未知 model へ silent fallback しません。codes の `PV-E*` 接頭辞は互換のため維持します。

PixVerse adapter の現行値（正本は yaml）:

| code | 意味（PixVerse `h3_execution_route`） |
| --- | --- |
| `H3-C006` | IR `target.model` が route profile `model` と完全一致しない |
| `PV-E001` | duration が route 許可値 `3, 5, 10` 秒以外 |
| `PV-E002` | quality が route 許可値 `768p, 1440p` 以外 |
| `PV-E003` | reference images が 9 を超える |
| `PV-E004` | reference videos が 3 を超える |
| `PV-E005` | reference audios が 3 を超える |
| `PV-E006` | audio-only reference（image/video なし） |
| `PV-E007` | first-last frame asset と reference asset の混在 |
| `PV-E008` | aspect が route 許可値 `16:9, 9:16` 以外 |

### warnings（`H3-W001`..`H3-W007`）

警告は hard-fail しません。

| code | 意味（実装） |
| --- | --- |
| `H3-W001` | 5 秒以下で 3 shot 以上 |
| `H3-W002` | 1 shot 内の主要 action 節が多すぎる |
| `H3-W003` | static/hold と push/zoom-in 言語の競合 |
| `H3-W004` | dialogue 長が duration に対して長い可能性 |
| `H3-W005` | subject 外見 cue が shot 間で変わって見える |
| `H3-W006` | music enabled なのに soundscape が完全無音指定 |
| `H3-W007` | first-last なのに中間 cut（複数 shot）がある |

compile 失敗や artifact path 安全系には別レイヤの `H3-C*` もあります（author field 衝突、mode asset 不足、symlink 拒否など）。Gate 1 前の format/route 表とは分けて扱ってください。

## model knowledge と execution route profile の分離

| 層 | 出典 | 役割 |
| --- | --- | --- |
| model-general guidance | `knowledge/video-models/pixverse/prompt-guide.yaml` の `minimax-h3` など | 助言。limits / notes / recipes。実行能力の証明ではない |
| adapter execution route | `adapters/<name>/constraints.yaml` の `h3_execution_route` | 実行前 hard check（必須 `model` + `PV-E*`）。adapter ごとの truth |
| core validator | `src/h3/validate/adapterRoute.ts` の `H3ExecutionRouteProfile` | profile を受けて検証するだけ。具体値の正本ではない |

例（PixVerse）:

- guidance: duration 5..15、aspect に `auto` / `4:3` など、quality 768p/1440p
- execution route (`h3_execution_route`): **model `minimax-h3`（必須）**、duration **3/5/10**、aspect **16:9 / 9:16**、quality **768p/1440p**、reference caps 9/3/3

guidance の性質:

- `scope: prompt-guidance-only`
- `execution_capability: not-evaluated`
- catalog 存在は adapter 契約・認証・クレジットの証明にならない
- 未知 model は `model-unmatched`（別 model recipe への silent fallback なし）
- route profile も同様に fail closed: 必須 `h3_execution_route.model` と各 IR `target.model` の完全一致（`H3-C006`）。typo / 別 model 宣言は通さない
- core は matched guidance でも prompt を自動書換えしない
- H3 request は選択 adapter が `h3_execution_route` を宣言している場合のみ実行可能

## 公式 PixVerse CLI 1.3.0 の確認事実

出典: local `pixverse@1.3.0` help（`pixverse create <op> --help`）および [PixVerseAI/cli](https://github.com/PixVerseAI/cli)

確認している事実（CLI help 文言ベース）:

- model id: `minimax-h3`
- create 系: `video` / `transition` / `reference`（ほか operation もある）
- **`create video --prompt <text>`**: help は *literal, a local file path, or `-` for stdin*
- **`create transition --prompt <text>`** / **`create reference --prompt <text>`**: help は *Prompt text* のみ。全 route が必ず file / stdin 対応と主張しない
- reference: image 最大 9（モデルにより上限差あり）/ video 最大 3 / audio 最大 3
- audio 単独 reference は不可（image または video と併用）

Tsugite 側の注意:

- H3 structured section 文法は **公式 provider 仕様と偽らない**
- 上記 CLI 事実と、本 repo の route 制約・Creative IR・renderer 契約は別物
- 実装の capability 判定は常に local constraints / 実 adapter を優先
- 現行 `adapters/pixverse/pixverseCli.mjs` は CLI の file/stdin 機構を使わず、**prompt 文字列を argv の値として渡す**

## safety

- asset path は safe relative path のみ
- pin / hash は regular file のみ
- symlink 成分は拒否
- adapter 起動は argv 配列（`cross-spawn` / shell concat しない）
- prompt は **ファイル化せず**、`buildPixverseCreateArgs` が `--prompt` の次に literal prompt を argv 配列の 1 要素として渡す（shell 文字列埋め込みなし）
- actual run / 課金 / Gate 更新は Coordinator と明示承認の既存境界を維持
- `run --dry-run` は実行せずに compile / plan 結果を確認する

## 後回し（未実装）

次は **未実装**です。実装済みのように扱わないでください。

- MiniMax direct API adapter
- last-frame-only mode
- Context-IR 比較
- より高度な semantic video QA（identity score 自動判定など）

## 実行例（dry のみ）

```sh
# schema + H3 compile + 静的検証（generation.connection: pixverse を明示済み）
node bin/pipeline validate --config examples/h3-prompt-director/project.yaml --json

# h3_compilations / prompt_guidance を確認
node bin/pipeline plan --config examples/h3-prompt-director/project.yaml --json

# review HTML の H3 section を生成
node bin/pipeline review --config examples/h3-prompt-director/project.yaml --state-dir <temp>/state --json

# adapter を呼ばない dry-run
node bin/pipeline run --config examples/h3-prompt-director/project.yaml --state-dir <temp>/state --dry-run --json
```

- actual `run`（課金）は書かない
- Gate 1/2/3 の自動承認はしない
- first-frame / first-last / reference の IR 形は `test/fixtures/h3/` を参照
