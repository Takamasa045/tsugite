# UI 言語と用語集（提案）

v1 の既定言語は **ja** のままです。英語表示は明示的に選んだときだけ使います。

## 言語の切り替え

優先順位は次のとおりです。上にある指定が勝ちます。

1. CLI `--lang ja|en`
2. 環境変数 `TSUGITE_LANG=ja|en`
3. ユーザー設定 `~/.config/tsugite`（または `$XDG_CONFIG_HOME/tsugite`）の `lang`
4. `project.yaml` の任意フィールド `lang:`
5. 既定 `ja`

未対応の `lang:`（例: `fr`）は案件全体の検証を落とさず無視し、次の解決元 / 既定へ進みます。明示エラーは CLI の `--lang` だけです。

ユーザー設定の例:

```yaml
# ~/.config/tsugite/config.yaml
lang: en
```

JSON でも読めます（`config.json` または `~/.config/tsugite` がファイルのとき）。

```json
{ "lang": "en" }
```

`t(key, params)` は env を自動では読みません。呼び出し側が上の順で言語を解決して渡します。指定言語に無いキーは **ja にフォールバック**します。

v2 の既定は現行の英語確認画面を維持する予定です（PR3）。解決順は同じで、何も指定しないときの fallback だけ v1 と異なります。

## 用語の扱い

- **未翻訳**: 画面でも英語UIでもそのまま出す語。
- **提案**: 英語UIで使う案。確定ではない。
- **要判断**: オーナー確認が必要。このPRでは決めない。

コマンド名・キー名・ファイル名は訳しません。

| 日本語 / 現行表示 | 提案英語 | 扱い | 備考 |
| --- | --- | --- | --- |
| 継手 | Tsugite | 未翻訳（ローマ字併記可） | 製品名。`継手 / Tsugite` は現行どおり残してよい。 |
| Tsugite | Tsugite | 未翻訳 | |
| Gate / Gate 1 / Gate 2 / Gate 3 | Gate 1 / Gate 2 / Gate 3 | 未翻訳 | 既存英語READMEも Gate。 |
| 確認画面 | confirmation page | 提案 | ランチャーやCLIの「確認画面」。review HTML のページ名でも使う。 |
| Creative Review | Creative Review | 未翻訳 | 確認画面の英語見出し。jaでも併記されている。 |
| 案件 / 制作案件 | project | 提案 | 既存 glossary は Production / `project`。UIでは project で揃える案。 |
| 工程 | step | 提案 | 確認画面の「工程: N段階」。stage との使い分けが要判断。 |
| 素材 | asset / footage | 要判断 | 生成物・参照画像・manifest のメディアが混在。footage は映像寄り。 |
| 承認 | Approve / approval | 提案 | ボタン・判断ラベル。動詞は Approve、名詞は approval。 |
| 適用予定 | Will apply | 要判断 | 解析レビューのカット状態。Scheduled は予約の意味が強い。 |
| 保持 | Keep | 要判断 | 適用しない候補。Retain も候補。 |
| 一部指定 | Partial | 要判断 | モーション設計ステータス。 |
| 未指定 | Unspecified | 提案 | モーション設計ステータス。 |
| 未生成 | Not generated | 要判断 | digest / 解析成果物。Pending は進行中に読める。 |
| 絵コンテ | storyboard | 提案 | 確認画面の映像の流れ。 |
| カット | shot | 提案 | SHOT は現行英語ラベルのまま。 |
| 尺 | duration | 提案 | `N秒` → `Ns`。 |
| 目標尺 | target duration | 提案 | |
| 編集エンジン | edit engine / backend | 提案 | 既存 glossary は Edit engine。ID自体は backend。 |
| 生成リクエスト | generation request | 提案 | |
| 予想される生成費用 | estimated generation cost | 提案 | credits は未翻訳で併記可。 |
| 最終確認 | Final check | 提案 | Gate 1 の判断ブロック。 |
| ここを直したい | I want this changed | 要判断 | 口語。Revise だけだと冷たい。 |
| 中止 | Abort | 提案 | コマンド名 abort と揃える。 |
| 解析レビュー | Analysis review | 提案 | |
| 構成案比較 | Composition comparison | 提案 | |
| 動き・アニメーション設計 | Motion / animation plan | 提案 | |
| キャラクターシート | Character sheet | 提案 | |
| 制作条件 | Production conditions | 提案 | |
| 音響設計 | Sound design | 提案 | |
| 生成音声 | Generated speech | 提案 | |
| 背景・舞台 | Background / setting | 提案 | |
| ネイティブ編集仕様 | Native edit spec | 提案 | |
| 確認ポイント | Review notes | 要判断 | warnings 見出し。Checkpoints は Gate と紛らわしい。 |
| 適用予定 / 保持（解析カット） | Will apply / Keep | 要判断 | 対で決める。 |
| 画面左 / 画面右 | Screen left / Screen right | 提案 | |
| 入場 / 強調 / 退場 / 次カットへの遷移 | Entrance / Emphasis / Exit / Transition to next | 提案 | |
| 全体・カット指定済み | Specified for film and shots | 要判断 | 長い。Declared は内部 status 名。 |
| Coordinator | Coordinator | 未翻訳 | 役割名。 |
| adapter / backend / manifest | adapter / backend / manifest | 未翻訳 | コード上の正式名。 |
| credits | credits | 未翻訳 | 課金単位。 |

## 要判断のまとめ

次はオーナー確認があるまで英語案を仮置きし、確定訳にしない。

1. **素材** — asset か footage か、文脈で分けるか。
2. **工程** — step か stage か。
3. **適用予定 / 保持** — 解析カットの対訳。
4. **一部指定 / 未生成** — ステータス語。
5. **ここを直したい** — 口語をどこまで残すか。
6. **確認ポイント** — warnings 見出し。
7. **全体・カット指定済み** — 短い英語ラベル。
8. **案件** — project に寄せるか Production を残すか（既存英語 glossary との差）。
