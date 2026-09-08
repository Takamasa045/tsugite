# PixVerse CanvasをTsugiteから操作する

Tsugite内に公式PixVerse CLI **1.4.0** を任意導入し、Canvasの全コマンドを呼び出せる。グローバルの古いCLIには依存しない。版と依存関係は `adapters/pixverse/runtime/package.json` と `package-lock.json` に固定する。

## 導入と確認

Node.js 22.12以上を使い、リポジトリのルートで実行する。導入はnpmへのアクセスを伴うが、生成やログインを自動実行しない。

```sh
npm run pixverse:install
npm run --silent pixverse -- --version
npm run --silent pixverse -- canvas --help
npm run --silent pixverse -- capabilities --json
```

JSONを保存するときは `--silent` を付けてnpmの見出しを除く。引数、stdin、stdout、stderr、終了コードは公式CLIへそのまま引き継ぐ。未導入時は導入コマンドを表示して停止する。既存のグローバルCLIを更新・置換しない。

必要に応じ、利用するアカウントで `npm run --silent pixverse -- auth login` を実行する。ログイン・workspace・課金先をエージェントが勝手に選ばない。workspaceを指定する場合は、以下の全操作へ `--workspace-id <選択済みID>` を同じ値で付ける（0は個人）。

## Canvasの操作順

以下の `<...>` は対象から取得した実値へ置き換える。IDは文字列として保持する。

1. 既存案件は対象のCanvas project IDを確認する。新規作成を依頼された場合は空のプロジェクトを作り、返されたproject IDを記録する。

   ```sh
   npm run --silent pixverse -- canvas project create --name "制作案件名" --json
   ```

2. 現行のcapabilities・node schema・graphを読み、edit versionを記録する。Canvasのcapabilities取得とdry-runもリモートAPIへアクセスする。`--help`やローカルのcapabilities表示だけとは区別する。

   ```sh
   npm run --silent pixverse -- capabilities canvas --node-type image_generate --selector text_to_image --model qwen-image --json
   npm run --silent pixverse -- canvas node schema --node-type image_generate --json
   npm run --silent pixverse -- canvas graph get --project-id <PROJECT_ID> --json
   ```

3. durable projects homeの対象案件内にpatchを作り、同じ内容をdry-runしてからapplyする。patchのschemaは現行capabilitiesに従い、古い見本のモデル制約を固定しない。競合時はgraphを読み直してpatchを再作成し、versionだけを書き換えて再送しない。

   ```sh
   npm run --silent pixverse -- canvas patch dry-run --project-id <PROJECT_ID> --patch <案件内のpatch.json> --json
   npm run --silent pixverse -- canvas patch apply --project-id <PROJECT_ID> --patch <案件内のpatch.json> --json
   ```

4. applyの `diff.executable_node_ids` と最新edit versionを確認する。生成を明示承認された対象ノードだけdispatchし、同じ対象の状態を取得する。

   ```sh
   npm run --silent pixverse -- canvas dispatch --project-id <PROJECT_ID> --node-ids <承認済みノードID列> --edit-version <EDIT_VERSION> --json
   npm run --silent pixverse -- canvas graph status --project-id <PROJECT_ID> --node-ids <同じノードID列> --json
   ```

`canvas node versions / version / version apply / rerun / extract-audio`、`canvas graph invalid-nodes / reconcile`、`canvas dispatch rebind`も同じ入口から使える。実行前に各コマンドの `--help` を確認する。バージョン適用やrebindも変更操作で、rerun・reconcileは再生成し得る。dispatch planを使う場合はrebindが返したedit versionと承認対象を一致させる。

## Tsugiteの承認・成果物との関係

これはエージェントが操作する**外部Canvas入口**で、`pipeline run` のCanvas backendではない。ラッパー自体はGateの認可を強制しない。既存の制作案件ではCoordinatorが対象project・review・Gate承認を確認して使い、Gateを迂回しない。

- 読み取り・remote dry-run・patch適用・生成開始を区別する。patch適用を生成承認とみなさない。
- dispatch / rerun / reconcileなど生成し得る操作は、人間による対象・費用・素材送信の明示承認後にCoordinatorが実行する。今回の開発検証だけで生成承認を得たとみなさない。
- project ID、workspace、edit version、承認済みnode IDs、適用patch、実行結果を案件内へ記録する。認証情報を記録しない。
- Canvasの成果物は既存のmanual import経路で案件へ取り込み、manifest・QA・Gate 3で確認する。Canvas成功をTsugiteの完成やGate承認へ自動変換しない。

## 検証範囲と更新

導入済み実CLIでバージョン・Canvas各サブコマンドのhelp・ローカルcapabilitiesを検証する。remote projectの作成、patch適用、生成、結果の取り込みは別の実案件検証であり、この入口のテスト成功では証明しない。

更新時は `npm install --prefix adapters/pixverse/runtime --save-exact pixverse@<確認した最新版>` でpackageとlockを更新し、上記の実CLI確認・関連テスト・全体checkを実行する。グローバルへの `npm install -g` だけではこのリポジトリの版は変わらない。

公式仕様: [PixVerseAI/cli](https://github.com/PixVerseAI/cli#canvas)。
