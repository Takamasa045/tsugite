# Blog dialogue 60s template

ブログ記事を、初心者役と解説役の60秒掛け合い動画へ変換するテンプレートです。

## 固定仕様

- 60秒 / 1920×1080 / 30fps / 16:9
- 左に初心者、右に解説役、中央に記事図解
- 2人ともImageGenで同じ画風に生成し、口閉じ／半開き／開きの3枚を約8fpsで切り替える
- `dialogue_60s.json` がセリフ・字幕・話者切替・中央図解の正本
- `build-manifest.mjs` が `video.json` と台本から `manifest.json` を決定的に生成
- 音声・BGM未提供時は字幕付き無音ドラフト

## 使い方

```sh
cp -R templates/blog-dialogue-60s projects/my-article-dialogue
cd projects/my-article-dialogue
```

1. 記事の出典と、動画で守るべき主張を `source.md` に書く。
2. `dialogue_60s.json` を Hook 0〜10秒 / Core 10〜45秒 / CTA 45〜60秒で編集する。
3. `video.json` のタイトル、出典URL、キャラクター、音声スロットを更新する。
4. 参照画像をgit管理外で用意し、`source/imagegen-mouth-sheet-prompt.md` を使って2人×3口形のシートをImageGenで作る。
5. シートを6枚のPNGへ等分し、`mouth_frames` を「閉じ／半開き／開き」の順で指定する。
6. manifestを更新する。

```sh
node build-manifest.mjs .
```

リポジトリrootへ戻り、安全な確認だけを実行します。

```sh
bin/pipeline validate --config projects/my-article-dialogue/project.yaml --json
bin/pipeline plan --config projects/my-article-dialogue/project.yaml --json
bin/pipeline run --config projects/my-article-dialogue/project.yaml --dry-run --json
```

`run` と `render` はCoordinatorの明示承認後だけ実行します。

## 台本JSON

各segmentには次を持たせます。

- `id`: `s01` のような一意ID
- `speaker`: `video.json` の話者ID
- `text`: 字幕に表示する自然な文章
- `tts_text`: 読み上げ用。固有名詞や数字の発音を調整
- `start` / `end`: 秒。0秒から60秒まで隙間・重複なし
- `pose`: 口パクを使わない場合のpose画像。なければ `neutral` へフォールバック
- `emphasis`: 字幕内で話者色にする語句
- `visual`: 中央の `kicker` / `headline` / `detail` / `badges`

`text` は1セリフ48文字以内です。Remotion側でも最大2行に制限し、1920×1080基準の全体レイアウトを他の16:9解像度へ比例縮小します。

## 素材方針

- オリジナル柴犬とイトパンは、1枚のImageGenシート内で同じ線・塗り・構図にそろえる。
- 各行は同じキャラ・同じ姿勢を維持し、変えるのは口だけ。列順は `closed` / `half` / `open`。
- 添付された参照画像そのものは再配布せず、git管理外にする。生成した公開用キャラ差分だけを動画素材にする。
- 白〜淡色背景は角丸ポートレート枠で表示し、無理な背景除去で輪郭を壊さない。
- 発話中だけ3枚を `closed → half → open → half` で循環し、聞き手は口閉じで固定する。
- 音声は1セリフ1ファイル、BGMは任意。字幕用 `text` と読み上げ用 `tts_text` を分ける。

## QA

- 主題を一文で説明できる。
- 0秒から60秒まで字幕に隙間・重複がない。
- 記事の主張と字幕・中央図解が矛盾しない。
- 重要語が2行以内で読め、キャラと字幕が重ならない。
- 各キャラの3枚で顔・髪・服・体格・画角が一致し、口以外が跳ねて見えない。
- 完成音声を追加したらSTTで読みを確認する。
- 承認後の最終出力は、60秒±0.5秒 / 1920×1080 / 30fps、黒フレーム・意図しない無音・CTA切れなしを確認する。
