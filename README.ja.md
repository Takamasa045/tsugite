# tsugite

[English](README.md) | [日本語](README.ja.md)

生成アダプタと編集バックエンドを、単一の manifest 契約で接続するベンダー中立の動画パイプラインです。

実行入口は `project.yaml` です。安全な基本フローは次の通りです。

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
- local-media / generated-media を `dist/<run-id>/` に組み立てる処理。
- manifest と media probe による Gate 2 QC report 生成。
- Remotion / HyperFrames backend 契約。
- Coordinator role と Gate 承認を要求する guarded `run` / `render`。

## コマンド

```sh
npm ci
npm run check
bin/pipeline validate --config project.yaml --json
bin/pipeline plan --config project.yaml --json
bin/pipeline run --config project.yaml --dry-run --json
```

`run` と `render` は意図的に Gate で保護されています。

```sh
bin/pipeline gate --config project.yaml --actor coordinator --gate gate-1 --decision approve --json
bin/pipeline run --config project.yaml --actor coordinator --json
bin/pipeline gate --config project.yaml --actor coordinator --gate gate-2 --decision approve --json
bin/pipeline render --config project.yaml --actor coordinator --json
```

明示的な人間承認なしに、非 dry-run の `run` や `render` を実行しないでください。

## project ファイル

最小の local-media project:

```yaml
slug: local-fixture
run_id: local-fixture-run
manifest: fixtures/manifests/minimal.valid.json
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

## リポジトリルール

- core code はベンダー中立に保つ。ベンダー固有の挙動は `adapters/` または `backends/` に閉じ込める。
- adapter directory には `constraints.md` を必ず置く。
- `mcp-agent` adapter には `SKILL.md` を必ず置く。
- 再利用できるルールが生まれる失敗は `LESSONS.md` に記録する。

## 本番運用メモ

- checked-in の `project.yaml` は fixture style のローカル検証 config であり、実本番 job ではありません。
- npm 11 では、platform-specific parent が skip されても optional wasm child package が lockfile に残るため、`npm ci` 後に `npm ls` が `@emnapi/runtime` を extraneous と表示する場合があります。`npm ci`、`npm audit`、build、tests、`validate`、`plan`、`run --dry-run` がすべて通っている場合のみ non-blocking と扱います。
- この workspace path には `*` が含まれるため、Vite が警告する場合があります。現在この path でも tests は通りますが、運用上ノイズになる場合は `*` を含まない path に repo を移してください。

