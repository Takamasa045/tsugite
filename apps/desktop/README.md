# Tsugite Desktop app

Electron で Tsugite のローカルランチャーを開く Desktop shell です。利用者向けの workspace、Gate、診断、署名と配布の説明は [`docs/desktop.md`](../../docs/desktop.md) を参照してください。

> Status: public distribution discontinued. The source remains for local development and verification, but macOS / Windows installers are no longer published or supported. Use the repository with Codex / Claude Code and the browser-based local launcher for normal workflows.

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

`build:runtime` は root CLI と Viewer をビルドし、パッケージ用 runtime を準備します。`package` は Electron Forge で開発者向けの unsigned app を `apps/desktop/out/` に作成します。`test:packaged-workspace` はその実アプリを起動し、空のworkspaceから再選択・設定保存・再起動後の案件表示までを検証します。OSの選択画面はPlaywrightのmain-process stubへ置き換え、製品コードに試験用フックは同梱しません。

GitHub ActionsのDesktop workflowは手動実行だけです。dependency audit、Desktop test、macOS Arm64とWindows x64の開発者向けpackage smokeを行いますが、インストーラーやActions artifactは公開しません。リリースタグからの自動起動も行いません。

package runtime は `process.resourcesPath/runtime/tsugite/` と `process.resourcesPath/runtime/viewer/` に配置します。実行コードは runtime root を cwd とし、workspace の config は absolute path で渡します。

`projects/`、private `templates/`、`media/`、`output/`、`tmp/`、`.env` は runtime に含めません。package test は runtime allowlist とこれらの禁止 path を検査します。
