# Tsugite Desktop

Tsugite Desktop は、ローカルの Tsugite workspace を開く Electron 版ランチャーです。macOS / Windows 向けの配布物に Electron runtime を同梱するため、利用者が Electron や npm package を別途インストールする必要はありません。`npm ci` はソースから開発・ビルドする人だけが実行します。

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

## 起動と終了

配布版は通常のアプリと同様に起動します。初回だけ workspace の保存先を選び、次回からその場所を再利用します。workspace を起動ごとに固定したい場合はターミナルから次のように開きます。path に空白がある場合は引用符で囲みます。

```sh
# macOSの例
open -a "Tsugite" --args --workspace "/Users/me/Tsugite Workspace"
```

```powershell
# Windowsの例
& "<install-directory>\Tsugite.exe" --workspace "D:\Tsugite Workspace"
```

環境変数を使う場合は、起動前に `TSUGITE_WORKSPACE_ROOT` を absolute path で設定します。開発版は起動したターミナルで `Ctrl+C` を押して終了します。パッケージ版は macOS で `Cmd+Q`、Windows でウィンドウを閉じるか `Alt+F4` を使います。終了時はローカルランチャーの停止を待ってからアプリを閉じます。

## 安全境界

今回の Desktop 配布版は、案件一覧、テンプレート、制作記録の更新、3D Viewerの閲覧を提供します。動画・画像を生成する2Dノード操作画面は後続リリースへ延期しており、Desktop UIから`run`、`render`、Gate判定は実行しません。

- 制作の実行は、従来どおりCLIまたは承認済みのCoordinator作業から行います。
- `run`、`render`、Gate判定のCLI前提条件と明示承認は変わりません。
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

## パッケージと公開

ローカル確認用の unsigned build は次で作成します。出力先は `apps/desktop/out/` です。

```sh
npm --prefix apps/desktop run test
npm --prefix apps/desktop run package
```

unsigned build は開発者のローカル確認用です。macOS Gatekeeper や Windows SmartScreen の警告が表示されるため、そのまま公開配布しないでください。インストーラー等の配布形式は `npm --prefix apps/desktop run make` で作成します。

公開時はバージョンを固定し、macOS では Developer ID Application による code signing と Apple notarization、Windows ではコードサイン証明書による署名を行います。署名と notarization の credential は CI secret で管理し、repository、ログ、配布物に含めません。PR / 通常 push の Desktop CI は secret なしの unsigned package smoke のみを行い、GitHub Releaseへは公開しません。

Desktop CI はmacOS Arm64のDMG/ZIPとWindows x64のSquirrelインストーラーを作成し、GitHub Actionsのrun artifactとして14日間保持します。これは動作確認用の未署名成果物です。対象runのArtifacts欄から、`tsugite-macos-arm64-<sha>` または `tsugite-windows-x64-<sha>` を取得してください。

Desktop runtime は tracked な実行コードと必要 resource の allowlist から作成します。workspace や repository の `projects/`、private `templates/`、`media/`、`output/`、`tmp/`、`.env` は梱包しません。ビルド前後の package test で、必要 runtime resource と禁止 path の両方を確認します。

Desktop 固有 CI は [`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml) を参照してください。
