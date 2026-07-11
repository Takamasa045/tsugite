# Q&A dialogue template

FAQ / ヘルプ向けの **Q&A 掛け合い解説** テンプレートです。
`qa.json` の質問リストから、Remotion `article-dialogue-16x9` 用の manifest を決定的に生成します。

## 固定仕様

- 16:9 / 30fps
- 尺は Q&A 件数から自動計算。`video.json` の `duration_seconds` がある場合は末尾をパディングして合わせる（既定サンプルは背景60秒に合わせて60）
- 左: 質問役、右: 回答役（デフォルトはしば / イトパン）
- 中央カード: `QUESTION` → `ANSWER` の kicker 切替
- 字幕は1セリフ48文字以内
- 音声未提供時は `presentation.draft: true` の無音ドラフト

## 使い方

```sh
cp -R templates/qa-dialogue projects/my-faq
cd projects/my-faq
```

1. `qa.json` の `title` と `qa_list` を編集する。
2. 必要なら `video.json` のキャラクター・ブランディングを差し替える。
3. manifest を再生成する。

```sh
node build-manifest.mjs .
```

リポジトリ root へ戻り、安全確認だけ実行する。

```sh
bin/pipeline validate --config projects/my-faq/project.yaml --json
bin/pipeline plan --config projects/my-faq/project.yaml --json
bin/pipeline run --config projects/my-faq/project.yaml --dry-run --json
```

`run` / `render` は Coordinator の明示承認後だけ。

## 入力スキーマ（qa.json）

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `title` | yes | 動画タイトル（ヘッダー / intro visual） |
| `qa_list` | yes | Q&A 配列（1件以上） |
| `qa_list[].q` | yes | 質問字幕（48文字以内） |
| `qa_list[].a` | a か a_lines | 回答字幕（48文字以内） |
| `qa_list[].a_lines` | a か a_lines | 長い回答を複数字幕に分割 |
| `qa_list[].detail` | no | 回答カードの補足文 |
| `qa_list[].highlights` | no | バッジ表示（最大4想定） |
| `qa_list[].duration` | no | その Q&A の秒数（既定は `duration_per_qa`） |
| `duration_per_qa` | no | 1問あたり秒数（既定 10） |
| `question_ratio` | no | Q に使う時間比率（既定 0.35） |
| `roles.questioner` / `roles.answerer` | no | 話者 ID |
| `intro` / `outro` | no | 前後の掛け合い。`false` で省略 |

### 最小例

```json
{
  "title": "ツール導入FAQ",
  "qa_list": [
    { "q": "何が楽になるの？", "a": "手作業の確認が自動化されるよ" }
  ]
}
```

### ベンダー向けのイメージ

```json
{
  "template": "qa-dialogue",
  "title": "OpenClawの始め方",
  "qa_list": [{ "q": "...", "a": "..." }],
  "characterStyle": "shiba",
  "durationPerQA": 8
}
```

このテンプレでは `template` / `characterStyle` は直接は読まない。
`qa.json` + `video.json` に正規化してから `build-manifest.mjs` を通す。

## 生成される流れ

```text
qa.json + video.json
  → build-manifest.mjs
  → manifest.json（captions / chapters / presentation）
  → bin/pipeline validate | plan | run | render
```

各 Q&A は概ね次のパターンになる。

1. 質問カード登場（QUESTION + 質問役）
2. 回答ハイライト（ANSWER + 回答役、任意で複数行）
3. バッジ / detail で実務ポイントを残す

## 素材

- `media/characters/*`: 口閉じ / 半開き / 開きの3枚 × 2キャラ
- `media/background.mp4`: フル尺以上の無音背景
- 音声は任意（`media/audio/`）

## QA チェックリスト

- 主題を一文で説明できる
- 字幕に隙間・重複がない（builder が保証）
- 各字幕が48文字以内
- Q と A の主張が矛盾しない
- 無音ドラフトでは `draft: true` のまま
- 承認後の最終出力は duration / 1920×1080 / 30fps を Gate 3 で確認
