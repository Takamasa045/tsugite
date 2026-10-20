# v2 第三者試用キット（alpha.5）

作者以外の3人（macOS / Windows / Linux を1人ずつ）が、課金なしで最初の結果まで進むための短い手順です。品質比較や有料サービス確認ではありません。個人情報・APIキー・自宅パス・私有メディアは記録にも issue にも載せないでください。

対象の配布は [v2.0.0-alpha.5](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5) です。npm レジストリからは入れません。既存の `project.yaml` 案件は触らないでください。

詳しい画面説明は [はじめての継手](first-video.ja.md) を正本にします。このキットは時間計測と報告だけを固定します。

## 入れるもの（計測の前）

次が使えることを、計測を始める前に確認します。導入そのものは10分に含めません。

- Node.js 22.12 以上の 22.x、npm 10 以上
- FFmpeg と FFprobe（`libx264` があること）
- ブラウザ（確認ページを開くため）
- 配布ファイルを置く、空の作業フォルダ

```sh
node --version
npm --version
ffmpeg -version
ffprobe -version
ffmpeg -hide_banner -encoders
```

最後の一覧に `libx264` があることを確認します。無い場合は、その OS の導入方法を先に済ませてから試用を始めてください。

## 10分タイマー

1. Node / npm / FFmpeg の確認が終わったあと、タイマーを開始します。
2. 配布の取得・照合・ローカル導入・`init` / `check` / `plan` / 承認後の `make` / `export`・最初に再生できる `final.mp4` までを計測します。
3. 確認ページで人が内容を読んでいる時間はタイマーを止めます。承認ボタンを押したあと、再開します。
4. 最初の結果は「再生できる `my-video/out/final.mp4` があること」です。作品の出来栄えは見ません。
5. 10分を超えても最後まで進めて構いません。超えた事実と、最初に詰まった点を記録します。
6. 外部生成、ログイン、クレジット消費、既存案件の変更はしません。

## alpha.5 の手順（この順だけ）

作業フォルダは新しく、空のものを使います。リポジトリの `projects/` には書きません。

1. [alpha.5 の Assets](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5) から `tsugite-2.0.0-alpha.5.tgz` と `SHA256SUMS` を保存する。
2. 照合する。`SHA256SUMS` に tarball 以外の行がある場合、未取得ファイルで失敗します。取得した tarball の行だけを照合します（いまの alpha.5 は tarball 1行です）。

macOS:

```sh
grep 'tsugite-2.0.0-alpha.5.tgz$' SHA256SUMS | shasum -a 256 -c
```

Linux:

```sh
grep 'tsugite-2.0.0-alpha.5.tgz$' SHA256SUMS | sha256sum -c
```

Windows PowerShell:

```powershell
Get-FileHash .\tsugite-2.0.0-alpha.5.tgz -Algorithm SHA256
Select-String -Path .\SHA256SUMS -Pattern 'tsugite-2.0.0-alpha.5.tgz$'
```

3. 導入してサンプルを作る。

```sh
npm install --prefix ./tsugite-local --ignore-scripts ./tsugite-2.0.0-alpha.5.tgz
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs init ./my-video
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs check --project ./my-video
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs plan --project ./my-video
```

4. `plan` のターミナルは動かしたまま、表示された `http://127.0.0.1:...` を同じパソコンのブラウザで開く。内容を確認して **Approve plan** を自分で押す。
5. 別ターミナルで同じ作業フォルダから:

```sh
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs make --project ./my-video
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs export --project ./my-video
```

6. `my-video/out/final.mp4` を再生する。確認ページで素材・完成の承認も自分で行う。エージェントに承認操作を任せない。

コマンドの意味と失敗時の見方は [はじめての継手](first-video.ja.md) にあります。

## 記録シート（個人情報なし）

次だけをメモします。氏名、メール、会社名、自宅パス、動画の中身、APIキーは書かないでください。パスは `~/video` や `C:\work` のように短く置き換えてください。

| 項目 | 記入 |
| --- | --- |
| OS（macOS / Windows / Linux と版） | |
| Node.js と npm の版 | |
| FFmpeg の版（`libx264` の有無） | |
| 最初の結果までの分数（確認ページの閲覧時間を除く） | |
| 10分以内に `final.mp4` を再生できたか | はい / いいえ |
| 最初に詰まった点（手順番号と短い事実） | |
| 詰まった直後に見えた赤色を消したエラー文 | |
| 確認ページは開いたか | はい / いいえ |
| 使ったのは公開 alpha.5 か、手元のリポジトリか | |

## 結果の送り方

GitHub の [v2 trial report フォーム](https://github.com/Takamasa045/tsugite/issues/new?template=v2-trial-report.yml) から送ります。ひな型の定義は [v2-trial-report.yml](../../../.github/ISSUE_TEMPLATE/v2-trial-report.yml) です。公開 issue を自分で作れない場合は、記録シートをメンテナへ渡し、メンテナが同じ項目で issue を作ります。

- ラベルの目安: `v2` / `trial`（メンテナが付与してよい）
- 動画・スクリーンショットに私有メディアやパスが写らないこと
- CI の成功だけでは、この3人試用の完了にはなりません
