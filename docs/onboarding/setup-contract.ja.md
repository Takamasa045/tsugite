# Tsugite 初回セットアップ契約

対象: Tsugite v0.9.0
入口: `scripts/bootstrap.mjs`

この文書は、公式Bootstrap、Codex・Claude Codeなどで使うセットアップ依頼文、Bootstrapテストに共通する安全仕様です。

## 適用範囲

- 公式リポジトリは `https://github.com/Takamasa045/tsugite` とする。
- Bootstrapはクローン済みのTsugiteリポジトリルートで実行する。
- クローン前の作業先確認と`git clone`は、セットアップを担当するコーディングエージェントが行い、Bootstrapは担当しない。
- 作業先が空でない、同名の`tsugite`がある、または既存ファイルと衝突する場合、コーディングエージェントはクローン前に停止する。
- Bootstrapが書き込める範囲は、実行中のTsugiteリポジトリ内だけとする。

## 自動実行してよい操作

- OS、CPU、shell、Git、Node.js、npm、FFmpeg、ffprobeの読み取り専用確認。
- 公式リポジトリルートと、`origin`が`Takamasa045/tsugite`を指すことの確認。
- ルートの`npm ci`。
- `npm --prefix apps/workflow-viewer ci`。
- `examples/quickstart-local/`から`projects/my-first-tsugite/`への初回コピー。
- サンプル案件に対する`doctor`、`validate`、`plan`。
- `.tsugite/setup-report.json`へのローカル結果保存。
- `--open`が明示された場合の、`127.0.0.1`専用ランチャー起動。

`npm ci`はリポジトリ内のローカル依存だけを変更する。グローバルパッケージやOS設定は変更しない。

## 必ず人間の承認を取る操作

- Homebrew、winget、aptなどによるシステムソフトの導入・更新。
- PATH、shell設定、OS設定の変更。
- グローバルnpmパッケージの導入。
- 外部サービスへのログイン、認証、契約変更。
- APIキー、トークン、Cookie、credentialの設定。
- クレジット購入、課金を伴う生成、外部送信。
- 非dry-runの`run`、`render`、Gate 1〜3の判断。
- commit、push、PR作成、公開。

不足を検出した場合は、必要な理由、候補コマンド、変更範囲を説明し、承認前には実行しない。

## 絶対に実行しない操作

- 既存ファイルや既存案件の上書き・削除。
- Tsugiteリポジトリ外への書き込み。
- secretのチャット、設定ファイル、ログ、レポートへの平文保存。
- Providerの自動選択、自動ログイン、自動課金、別Providerへの自動フォールバック。
- `run`、`render`、Gate変更のBootstrapからの呼び出し。
- 利用状況、プロンプト、素材、診断結果の外部送信。
- 常駐プロセス、独自デスクトップ通知、ブラウザ通知権限の追加。

## 対応OSと処理の分離

共通処理:

- Node.js標準モジュールだけでBootstrapを起動する。
- shell文字列ではなく、実行ファイルと引数配列を分けてコマンドを起動する。
- Git、Node.js、npm、FFmpeg、ffprobeを同じ基準で診断する。
- 依存導入、サンプルコピー、`doctor`、`validate`、`plan`を同じ順で実行する。

OS固有処理:

- Windowsでは`git.exe`と`npm.cmd`を使用し、PowerShellやcmd.exeで安全に扱える引数配列を維持する。
- macOS、Linuxでは通常の`git`と`npm`を使用する。
- 不足ソフトの案内文だけをOS別に変える。システムインストール自体は実行しない。

対応対象はmacOS、Windows、Linuxとする。Windowsの実機リリース判定は、Windows上の手動確認を別途必要とする。

## 必須環境

- Git。
- Node.js 22.12以上、23未満。
- npm 10以上。
- FFmpegとffprobe。
- 公式Tsugiteリポジトリ一式。
- `origin`がHTTPSまたはSSHの公式GitHubリポジトリを指すGit checkout。

Provider CLI、Provider認証、APIキー、契約、クレジットは基本セットアップの必須条件ではない。

## 実行順

1. リポジトリルートと必須環境を読み取り専用で確認する。
2. `projects/my-first-tsugite/`の衝突を確認する。
3. ルート依存を導入する。
4. Workflow Viewer依存を導入する。
5. 課金不要サンプルを初回だけコピーする。
6. サンプル案件の`doctor`を実行する。
7. `validate`を実行する。
8. `plan`を実行する。
9. 結果を保存する。
10. `--open`指定時だけランチャーを起動する。

途中で失敗した場合は後続工程を実行しない。

## 成功条件

- すべての必須環境チェックが成功している。
- ルートとViewerの依存導入が成功している。
- `projects/my-first-tsugite/project.yaml`が存在する。
- `doctor`、`validate`、`plan`が終了コード0で完了している。
- `.tsugite/setup-report.json`に各コマンド、終了コード、マスキング済み診断が保存されている。
- `run`、`render`、Gate変更、外部認証、課金が行われていない。

`--check`は読み取り専用であり、レポートや案件を作成しない。`--open`を付けない通常の`setup`はランチャーを起動しない。

## 停止条件

- 公式リポジトリルートを確認できない。
- Gitの`origin`が公式`Takamasa045/tsugite`を指していない。
- Node.jsまたはnpmのバージョンが範囲外。
- Git、FFmpeg、ffprobeのいずれかがない。
- `projects/my-first-tsugite/`がBootstrap管理外のファイルまたはディレクトリとして存在する。
- `npm ci`、Viewer依存導入、`doctor`、`validate`、`plan`のいずれかが失敗する。
- コピー先が競合する、またはリポジトリ内に安全に書き込めない。

## 再実行

- 同じBootstrap管理サンプルが存在する場合は再コピーせず、ユーザーの変更を保持する。
- 同じlockfileで依存導入済みと確認できる工程は再利用できる。
- lockfileが変わった、依存導入の証拠がない、または前回失敗した工程は再実行する。
- 前回レポートは再開判断に使うが、必須環境チェックは毎回やり直す。
- 同名案件がBootstrap管理外の場合は、自動採用・移動・削除をせず停止する。

## secretと診断情報

- 環境変数の一覧や値をレポートへ保存しない。
- secretを示す環境変数名に対応する値と、token、API key、Cookie、password、Authorization形式を診断出力からマスキングする。
- レポートはリポジトリ内の`.tsugite/setup-report.json`へ権限`0600`で保存し、Git管理対象外とする。
- 人間向け出力と`--json`出力のどちらにもsecretを含めない。
