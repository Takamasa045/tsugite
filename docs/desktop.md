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

Desktopで制作案件が0件の場合は、空の制作棚に現在のworkspace名と「workspaceを選び直す」を表示します。OSのフォルダ選択で専用フォルダを選ぶと、`projects/`と`templates/`を安全に用意できることを検証し、設定へ保存してからDesktop全体を再起動します。ブラウザ版のランチャーにはこの操作を表示しません。

filesystem root、home directoryそのもの、パッケージ版のapplication resourcesはworkspaceにできません。AI CLIや制作処理が実行中の場合も切替を開始しないため、先に画面上で停止してから選び直してください。保存済みworkspaceを利用できず検証に失敗した場合、次回起動時に選択画面へ戻り、検証に成功した代替先だけを保存します。

## 起動と終了

配布版は通常のアプリと同様に起動します。初回に workspace の保存先を選び、次回からその場所を再利用します。後から変更する場合は空の制作棚にある再選択ボタンを使えます。workspace を起動ごとに固定したい場合はターミナルから次のように開きます。path に空白がある場合は引用符で囲みます。

```sh
# macOSの例
open -a "Tsugite" --args --workspace "/Users/me/Tsugite Workspace"
```

```powershell
# Windowsの例
& "<install-directory>\Tsugite.exe" --workspace "D:\Tsugite Workspace"
```

環境変数を使う場合は、起動前に `TSUGITE_WORKSPACE_ROOT` を absolute path で設定します。開発版は起動したターミナルで `Ctrl+C` を押して終了します。パッケージ版は macOS で `Cmd+Q`、Windows でウィンドウを閉じるか `Alt+F4` を使います。生成処理やAI CLIの実行中は確認後に停止して終了できます。workspaceの更新処理中は安全に完了するまで終了を開始せず、完了後にもう一度終了します。

## 安全境界

今回の Desktop 配布版は、案件一覧、テンプレート、制作記録の更新、3D Viewerの閲覧に加え、インストール済みのCodex CLIまたはClaude Codeを開く内蔵端末を提供します。画面では、作業場所を次の3つから選べます。

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

## パッケージと公開

ローカル確認用の unsigned build は次で作成します。出力先は `apps/desktop/out/` です。

```sh
npm --prefix apps/desktop run test
npm --prefix apps/desktop run security:audit
npm --prefix apps/desktop run package
npm --prefix apps/desktop run test:packaged-workspace
```

`test:packaged-workspace` は作成済みの実アプリを起動し、空のworkspaceから再選択、設定保存、再起動後の案件表示までを検証します。OSの選択画面だけをPlaywrightからElectron main process上で一時的に置き換えるため、製品ASARには試験用環境変数やtest hookを含めません。unsigned build は原則として開発者のローカル確認用です。macOS Gatekeeper や Windows SmartScreen の警告が表示されます。インストーラー等の配布形式は `npm --prefix apps/desktop run make` で作成します。

正式版の公開時はバージョンを固定し、macOS では Developer ID Application による code signing と Apple notarization、Windows ではコードサイン証明書による署名を行います。署名と notarization の credential は CI secret で管理し、repository、ログ、配布物に含めません。PR / 通常 push の Desktop CI は secret なしの unsigned package smoke のみを行い、GitHub Releaseへは自動公開しません。

`v0.6.0-beta.1` は、この通常方針の例外として未署名のまま限定公開するベータ版です。GitHub prereleaseと公式LPの両方で、コード署名なし、macOS notarization未実施、対応architecture、初回起動時の警告、生成ランチャー／生成ノード非搭載を明示します。利用者には公式GitHub Releaseからのみ取得し、同じReleaseの`SHA256SUMS.txt`と照合するよう案内します。OSの保護機能を常時無効にする案内は行いません。

ベータ版のassetは、mainへmergeした同一sourceをtag付けした後、レビュー済みの成果物だけを`Tsugite-0.6.0-macos-arm64.dmg`、`Tsugite-0.6.0-windows-x64-setup.exe`へリネームして手動公開します。LPはこの固定asset名を参照します。tag、Release、asset、SHA-256、LPの公開は別の状態として検証します。

Desktop CI はmacOS Arm64とWindows x64で実パッケージE2Eを実行した後、macOSのDMG/ZIPとWindowsのSquirrelインストーラーをGitHub Actionsのrun artifactとして14日間保持します。これは動作確認用の未署名成果物です。対象runのArtifacts欄から、`tsugite-macos-arm64-<sha>` または `tsugite-windows-x64-<sha>` を取得してください。Actions artifactの一時URLは公開LPから参照しません。

Desktop runtime は tracked な実行コードと必要 resource の allowlist から作成します。workspace や repository の `projects/`、private `templates/`、`media/`、`output/`、`tmp/`、`.env` は梱包しません。内蔵端末のpreload bridgeだけをDesktop sourceのallowlistへ加え、native PTY moduleは対象OS / architectureに必要なbinaryとhelperだけをASAR外へ展開します。ビルド前後の package test で、必要 runtime resource、native module、禁止 pathを確認します。

Desktop 固有 CI は [`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml) を参照してください。
