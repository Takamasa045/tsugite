# Tsugite Desktop

> 状態: 一般配布終了。macOS / Windows向けインストーラーの新規公開・更新・利用者サポートは行いません。通常利用はGitHubのリポジトリをCodex / Claude Codeで開き、ブラウザ版のローカルランチャー／Viewerを使ってください。

Tsugite Desktop は、ローカルの Tsugite workspace を開く Electron 版ランチャーの開発用ソースです。機能検証のためコードとテストは残しますが、配布アプリとしては扱いません。

## Workspace

ランチャーは、次の優先順位で workspace root を決めます。

1. 起動引数 `--workspace <absolute-path>` または `--workspace=<absolute-path>`
2. 環境変数 `TSUGITE_WORKSPACE_ROOT`
3. パッケージ版で以前選択した workspace
4. 開発時は Tsugite repository root
5. パッケージ版の初回起動ではフォルダ選択画面を表示し、キャンセル時は Electron user-data directory 配下の `workspace`

workspace の中で主に使うディレクトリは次の2つです。

```text
<workspace>/
├── projects/
│   └── <job>/project.yaml
└── templates/
    └── <template>/template.yaml
```

`projects/` は各動画の project、プロンプト、state、出力を保持する private 領域です。`templates/` はその workspace で管理する再利用用テンプレート用です。project 検出は選択した workspace root を基準にしますが、`project.yaml` の manifest や asset の相対 path はその config directory から解決します。

Desktopで制作案件が0件の場合は、空の制作棚に現在のworkspace名と「workspaceを選び直す」を表示します。OSのフォルダ選択で専用フォルダを選ぶと、`projects/`と`templates/`を安全に用意できることを検証し、設定へ保存してからDesktop全体を再起動します。ブラウザ版のランチャーにはこの操作を表示しません。

filesystem root、home directoryそのもの、パッケージ版のapplication resourcesはworkspaceにできません。AI CLIや制作処理が実行中の場合も切替を開始しないため、先に画面上で停止してから選び直してください。保存済みworkspaceを利用できず検証に失敗した場合、次回起動時に選択画面へ戻り、検証に成功した代替先だけを保存します。

## 起動と終了

開発版はrepository rootから起動します。workspaceを固定する場合は`--workspace`または`TSUGITE_WORKSPACE_ROOT`を使います。起動したターミナルで`Ctrl+C`を押すと終了します。生成処理やAI CLIの実行中は確認後に停止して終了できます。

## 安全境界

Desktop開発版は、案件一覧、テンプレート、制作記録の更新、3D Viewerの閲覧に加え、インストール済みのCodex CLIまたはClaude Codeを開く内蔵端末を提供します。画面では、作業場所を次の3つから選べます。

1. **いつものAIで作業**: CodexやClaudeの外部アプリを、Tsugiteの確認画面と並べて使います。
2. **このアプリでAIと作業**: 内蔵端末で、PCに導入済みのCodex CLIまたはClaude Codeを選んで起動します。最初に起動できる対象をこの2つに限定した端末です。
3. **確認だけする**: AIを起動せず、案件の状態や3D Viewerだけを見ます。

内蔵端末は、Codex CLIやClaude Code本体を同梱・インストールしません。各CLIのloginや契約は、それぞれの公式手順で事前に済ませてください。Tsugite DesktopへAPI keyやtokenを貼り付ける必要はありません。また、Codex / Claudeの認証・契約と、PixVerseなど生成providerのAPI利用料・creditsは別です。生成に使うproviderはprojectごとに選び、そのprovider側の認証・利用権限・残高を`doctor`で確認します。

起動対象はCodex CLI / Claude Codeの2種類に限定しています。起動後のAI CLIは、それぞれに設定した通常の権限・承認ルールに従い、選択したworkspaceのファイル読書き、command実行、network接続を行うことがあります。内蔵端末はこれらの操作をTsugite独自のsandboxへ閉じ込めるものではありません。各CLIの承認画面を確認し、必要な権限だけを許可してください。TsugiteのGateは動画制作の`run` / `render`を守る仕組みであり、AI CLIによる一般的なファイル操作の承認設定を置き換えません。

動画・画像を生成する2Dノード操作画面は後続リリースへ延期しています。Desktopのボタンや内蔵端末を開くだけで`run`、`render`、Gate判定が始まることはありません。

- 制作の実行は、従来どおりCLIまたは承認済みのCoordinator作業から行います。
- `run`、`render`、Gate判定のCLI前提条件と明示承認は変わりません。
- AIが提案を表示しても、Gateは自動承認されません。人が内容を確認し、明示的に判断します。
- Desktop UIを開いただけでは、provider creditsの消費、外部送信、動画生成、Gate変更は行いません。

アプリが起動できることと、CLIで個別 project を実行できることは別の診断です。同梱 Node.js 22 runtime、FFmpeg / `ffprobe`、選択した provider CLI、認証、entitlement、credits は project ごとに `doctor` で確認してください。Electron と Node runtime はアプリに同梱しますが、FFmpeg や optional provider の実行環境と認証は同梱・自動設定しません。Electron が起動したことや provider catalog に項目があることは、これらの ready を意味しません。

## 開発

repository root で依存を入れ、Viewer と Desktop の依存も入れます。

```sh
npm ci
npm --prefix apps/workflow-viewer ci
npm --prefix apps/desktop ci
npm --prefix apps/desktop start -- --workspace "/absolute/path/to/workspace"
```

環境変数を使う例です。

```sh
TSUGITE_WORKSPACE_ROOT="/absolute/path/to/workspace" npm --prefix apps/desktop start
```

```powershell
$env:TSUGITE_WORKSPACE_ROOT = "D:\Tsugite Workspace"
npm --prefix apps/desktop start
```

開発時は repository の `build/` と `apps/workflow-viewer/dist/` を使います。パッケージ版は `resources/runtime/tsugite/` の実行コードと `resources/runtime/viewer/` の Viewer bundle を使います。adapter / backend 探索を安定させるため child process の cwd は runtime root に固定し、project config は absolute path で渡します。

## 開発者向けパッケージ検証

ローカル確認用の unsigned build は次で作成します。出力先は `apps/desktop/out/` です。

```sh
npm --prefix apps/desktop run test
npm --prefix apps/desktop run security:audit
npm --prefix apps/desktop run package
npm --prefix apps/desktop run test:packaged-workspace
```

`test:packaged-workspace` は作成済みの実アプリを起動し、空のworkspaceから再選択、設定保存、再起動後の案件表示までを検証します。OSの選択画面だけをPlaywrightからElectron main process上で一時的に置き換えるため、製品ASARには試験用環境変数やtest hookを含めません。unsigned buildは開発者のローカル確認だけに使い、配布しません。

GitHub ActionsのDesktop workflowは手動実行だけです。macOS Arm64とWindows x64でdependency audit、Desktop test、開発者向けpackage smokeを行いますが、インストーラーやActions artifactは公開しません。リリースタグでも自動実行しません。

`v0.6.0-beta.1`の配布物は過去の試験記録として残しますが、サポート対象外であり、公式LPから案内しません。再公開、差し替え、新規インストーラー追加は行いません。

Desktop runtime は tracked な実行コードと必要 resource の allowlist から作成します。workspace や repository の `projects/`、private `templates/`、`media/`、`output/`、`tmp/`、`.env` は梱包しません。内蔵端末のpreload bridgeだけをDesktop sourceのallowlistへ加え、native PTY moduleは対象OS / architectureに必要なbinaryとhelperだけをASAR外へ展開します。ビルド前後の package test で、必要 runtime resource、native module、禁止 pathを確認します。

Desktop 固有 CI は [`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml) を参照してください。
