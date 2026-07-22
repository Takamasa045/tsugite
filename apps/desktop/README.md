# Tsugite Desktop app

Electron で Tsugite のローカルランチャーを開く Desktop shell です。利用者向けの workspace、Gate、診断、署名と配布の説明は [`docs/desktop.md`](../../docs/desktop.md) を参照してください。

## Development

repository root から実行します。

```sh
npm ci
npm --prefix apps/workflow-viewer ci
npm --prefix apps/desktop ci
npm --prefix apps/desktop start -- --workspace "/absolute/path/to/workspace"
```

`--workspace=<path>` も使えます。指定がない場合は `TSUGITE_WORKSPACE_ROOT`、パッケージ版で以前選択した workspace、開発時の repository root の順で選択されます。パッケージ版の初回起動はフォルダ選択を開き、キャンセル時は user-data 配下の workspace を使います。制作案件が0件なら、Desktopの空棚からworkspaceを選び直せます。選択先の検証・保存後にアプリ全体を再起動し、実行中の制作処理やAI CLIがある間は切替を拒否します。終了は開発ターミナルで `Ctrl+C` を使います。

## Checks and packaging

```sh
npm --prefix apps/desktop run test
npm --prefix apps/desktop run security:audit
npm --prefix apps/desktop run build:runtime
npm --prefix apps/desktop run package
npm --prefix apps/desktop run test:packaged-workspace
```

`build:runtime` は root CLI と Viewer をビルドし、パッケージ用 runtime を準備します。`package` は Electron Forge で unsigned app を `apps/desktop/out/` に作成します。`test:packaged-workspace` はその実アプリを起動し、空のworkspaceから再選択・設定保存・再起動後の案件表示までを検証します。OSの選択画面はPlaywrightのmain-process stubへ置き換え、製品コードに試験用フックは同梱しません。`make` は配布形式を作ります。正式版の公開にはmacOS code signing / notarizationとWindows code signingが別途必要です。未署名で限定公開する`v0.6.0-beta.1`の例外条件と利用者向け注意は[`docs/desktop.md`](../../docs/desktop.md)を参照してください。

GitHub ActionsのDesktop workflowは、macOS Arm64とWindows x64の両方で実パッケージE2Eを通した`make`成果物を、未署名の検証用artifactとして14日間保持します。GitHub Releaseへは自動公開せず、ベータ公開時もmain/tagとの一致、asset名、SHA-256を手動確認します。

package runtime は `process.resourcesPath/runtime/tsugite/` と `process.resourcesPath/runtime/viewer/` に配置します。実行コードは runtime root を cwd とし、workspace の config は absolute path で渡します。

`projects/`、private `templates/`、`media/`、`output/`、`tmp/`、`.env` は runtime に含めません。package test は runtime allowlist とこれらの禁止 path を検査します。
