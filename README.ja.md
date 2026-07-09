# tsugite

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [한국어](README.ko.md)

生成アダプタと編集バックエンドを、単一の manifest 契約で接続するベンダー中立の動画パイプラインです。

動画 job ごとに `project.yaml` を持ちます。配布用 repo として、コピー可能なサンプルは `examples/` に置き、ユーザー作業用の `projects/` は git 管理から外します。安全な基本フローは次の通りです。

1. project と manifest を検証する。
2. 実行計画を作成する。
3. Gate 1 で人間の承認を待つ。
4. Coordinator 承認後にだけ生成または組み立てを実行する。
5. Gate 2 で出力 QA を行う。
6. Gate 2 承認後にだけ render する。
7. Gate 3 で最終動画 QA を行う。

## 現在のスコープ

- manifest 検証とローカル素材チェック。
- `cli`、`mcp-agent`、`mcp-client` 形式のアダプタ registry。
- PixVerse / Kling 向け CLI generation adapter wrapper。
- Topview 向け MCP-agent generation adapter 契約。
- OpenClaw 向け optional CLI bridge と Hermes 向け analysis handoff adapter。
- local-media / generated-media を `dist/<run-id>/` に組み立てる処理。
- manifest と media probe による Gate 2 QC report 生成。
- Remotion / HyperFrames backend 契約。
- Coordinator role と Gate 承認を要求する guarded `run` / `render`。

## コマンド

```sh
npm ci
npm run check
cp -R examples/local-fixture projects/my-first-run
bin/pipeline validate --config projects/my-first-run/project.yaml --json
bin/pipeline plan --config projects/my-first-run/project.yaml --json
bin/pipeline run --config projects/my-first-run/project.yaml --dry-run --json
```

`run` と `render` は意図的に Gate で保護されています。

```sh
bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-1 --decision approve --json
bin/pipeline run --config projects/my-first-run/project.yaml --actor coordinator --json
bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-2 --decision approve --json
bin/pipeline render --config projects/my-first-run/project.yaml --actor coordinator --json
```

明示的な人間承認なしに、非 dry-run の `run` や `render` を実行しないでください。

## project ファイル

`examples/local-fixture/project.yaml` で使っている最小の local-media project:

```yaml
slug: local-fixture
run_id: local-fixture-run
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
```

生成を含む project では `generation` section を追加します。

```yaml
generation:
  adapter: pixverse
  requests:
    - id: shot-001
      prompt: short prompt
      model: v4.5
      duration: 5
      aspect: "16:9"
      params: {}
```

OpenClaw / Hermes の optional adapter は、配布時に必要な人だけが追加する
opt-in 機能です。base install では不要で、`project.yaml` が該当 adapter を
選んだ場合だけ adapter 固有の setup を行います。詳しくは
[Optional Adapters](docs/optional-adapters.md) を参照してください。

## パイプラインの育て方

Tsugite は、動画をたくさん生成するだけで自動的に自分好みになるわけではありません。出力を見て、やり直し理由や好みを言語化し、それを repo のルール、テンプレ、チェックに戻していくことで育ちます。

基本ループは次の通りです。

1. `projects/` に project を作る。
2. Gate 承認後にだけ生成または組み立てを実行する。
3. 出力を見て、良かった点、失敗した点、やり直した理由を書く。
4. 一回限りのメモはその project 内に残す。
5. 繰り返し使う教訓だけを examples、templates、adapter/backend constraints、validate/doctor、tests/fixtures、運用ルール、公開契約に昇格する。

昇格の目安:

```text
一回限りの好み        -> projects/<job>/notes.md
何度も使う好み        -> examples/ or templates/
機械的に防げる失敗    -> constraints.yaml / validate / doctor + tests/fixtures
判断系の運用ルール    -> LESSONS.md -> SKILL.md / CLAUDE.md / AGENTS.md
QA の判定ルール       -> Gate 2 / Gate 3 checks + report schema/tests
公開契約の変更        -> README / manifest/schema.md / docs/requirements.md
```

昇格時は、失敗の再現 fixture とテスト、または人間が読む運用ルールのどちらかを必ず残します。Gate 2 / Gate 3 の判定を増やす場合は、report の形とテストも一緒に更新します。

このループによって、配布用 repo としての安全性を保ったまま、自分好みの制作パイプラインに育てていけます。ローカル案件は `projects/` 配下で git 管理外にし、再利用できる改善だけを本体へ commit します。

## リポジトリルール

- core code はベンダー中立に保つ。ベンダー固有の挙動は `adapters/` または `backends/` に閉じ込める。
- adapter directory には `constraints.md` を必ず置く。
- `mcp-agent` adapter には `SKILL.md` を必ず置く。
- ユーザー作業は `projects/` に置き、`examples/` はコピー可能でリセットしやすい状態に保つ。
- 再利用できるルールが生まれる失敗は `LESSONS.md` に記録する。

## 本番運用メモ

- `examples/local-fixture/project.yaml` は fixture style のローカル検証 config です。編集前に `projects/` へコピーしてください。
- `projects/*` は git ignore されるため、ローカル prompt、media、manifest、`dist/`、run state は配布用 commit に混ざりません。
- npm 11 では、platform-specific parent が skip されても optional wasm child package が lockfile に残るため、`npm ci` 後に `npm ls` が `@emnapi/runtime` を extraneous と表示する場合があります。`npm ci`、`npm audit`、build、tests、`validate`、`plan`、`run --dry-run` がすべて通っている場合のみ non-blocking と扱います。
- この workspace path には `*` が含まれるため、Vite が警告する場合があります。現在この path でも tests は通りますが、運用上ノイズになる場合は `*` を含まない path に repo を移してください。
