# HyperFrames 公式 catalog（参考一覧）

継手ランチャーのテンプレート最終確認画面にある「表現のヒントを探す」は、HyperFrames 公式 CLI の catalog を**読み取り専用**で表示します。

実行候補の presentation preset（見出し: 「仕上げ構成（実行候補）」）とは別枠です。

## 位置づけ

- 実行用の presentation preset（`GET /api/presets`）とは別物です。
- 参考情報であり、利用可能・導入済み・render 可能を保証しません。
- 制作依頼本文へ自動追加しません。
- preset へ変換しません。
- 自動 install しません。

## API

```http
GET /api/reference-catalogs/:catalogId
```

例: `GET /api/reference-catalogs/hyperframes`

### 認証

ローカル CLI を起動するため、次を満たす必要があります。未認証は `403` / `viewer_launcher.forbidden` です。

- `Host` は launcher origin と一致必須（ランチャー共通）
- `x-tsugite-token: <session token>` は必須
- `Origin` がある場合は launcher origin と一致必須
- 同一 origin の通常ブラウザ GET は `Origin` を送らないため、`Host` 照合 + token で許可する
- 外部 Origin / token 欠落・不一致 / Host 不一致は拒否

### 実行契約（vendor: backends/hyperframes/catalog.mjs）

- `process.execPath` + repo-local の検証済み CLI entrypoint を**絶対 path**で起動
- `npx` / `PATH` 解決 / 起動 cwd 依存は使わない
- `shell: false`
- 固定 `cwd`（repo root）
- 必要最小限の env
- 引数は固定（`catalog --json`。リクエスト値を渡さない）
- timeout 5 秒
- stdout 最大 1MiB
- timeout / 出力超過時は CLI 本体と子孫プロセスを停止し、終了を確認
- stderr / path / env / secret は API 応答に含めません

### 同時実行とキャッシュ

- catalog 単位で同時実行は 1 件
- 短期キャッシュあり
- 過剰な同時要求は `429` / `reference_catalog.busy`
- 失敗しても既存の preset 選択・制作依頼コピーは壊しません

### 安定 issue code（汎用 catalog 境界）

| code | HTTP |
| --- | --- |
| `reference_catalog.not_found` | 404 |
| `reference_catalog.busy` | 429 |
| `reference_catalog.output_too_large` | 413 |
| `reference_catalog.unavailable` | 503 |
| `reference_catalog.timeout` | 504 |
| `reference_catalog.invalid_json` | 502 |
| `reference_catalog.schema_unsupported` | 502 |
| `reference_catalog.command_failed` | 502 |

成功時は `advisoryOnly: true` と `capabilityVerified: false` を必ず返します。

## UI

- 初期状態は閉じた `details`
- 開いた時だけ API を 1 回取得（`x-tsugite-token` を明示付与）
- 検索 / type / Tsugite 推定分類 / タグ / 12 件ずつ追加 / 詳細 / ID コピー
- 内部 ID は技術情報として控えめに表示
- Tsugite 推定分類は tags からの推定で、公式 category ではありません
- 取得エラーは仕上げ構成（実行候補）や制作依頼コピーを壊しません
- 再読込失敗時は前回成功一覧を残します
