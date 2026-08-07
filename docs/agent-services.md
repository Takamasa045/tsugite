# Agent Service Registry（公開 Remote MCP）

Tsugite の **Agent Service Registry** は、公開 read-only の Remote MCP を安全に呼び出すための専用レジストリです。

- **生成サービスの課金経路**（`connections/catalog.yaml`）とは別系統です。混ぜません。
- **任意 URL は受け付けません。** endpoint は registry YAML からのみ解決します。
- **Public Data only（MVP）**: 問い合わせ送信・予約・購入・公開・push などの side-effect tool は登録しません。

## 登録済みサービス（MVP）

| id | display name | endpoint host | allowlisted tools | policy |
|---|---|---|---|---|
| `itopan-search` | itopan Search | `*.search.ai.cloudflare.com` | `search` | `read_public_data` / `approval=none` |
| `azumimusuhi-search` | azumimusuhi Search | `*.search.ai.cloudflare.com` | `search` | `read_public_data` / `approval=none` |
| `lab-search` | lab Search | `*.search.ai.cloudflare.com` | `search` | `read_public_data` / `approval=none` |
| `azumi-experience` | Azumi Experience | `azumi-experience-mcp.tkms045.workers.dev` | `search_experiences`, `get_experience`, `plan_experience` | `read_public_data` / `approval=none` |

正本: [`agent-services/registry.yaml`](../agent-services/registry.yaml)

Cloudflare 公式の公開 MCP URL 形式（`https://<public_endpoint_id>.search.ai.cloudflare.com/mcp`）および Workers 上の公開 endpoint は、公開情報として registry に記載しています。secret やアカウント情報は書きません。

## CLI

```sh
# レジストリ一覧（network なし）
node bin/pipeline services --json

# リモートの tool 一覧（network あり）。registry 未宣言 tool は observed だが callable=false
node bin/pipeline service-tools --service itopan-search --json

# tool 呼び出し（network あり）。allowlist + policy を通過したものだけ
node bin/pipeline service-call \
  --service itopan-search \
  --tool search \
  --arguments '{"query":"AIエージェント"}' \
  --json
```

安定 JSON フィールドの要点:

| field | 意味 |
|---|---|
| `network` | `services` は `false`。`service-tools` / `service-call` は `true` |
| `billing_action` | 常に `false`（Agent Service は生成課金経路ではない） |
| `side_effect` | tool policy が side-effect のとき `true` |
| `approval_decision` | `not_required` / `required` / `verified` |
| `secret_values_exposed` | 常に `false` |

## 安全境界

1. **Registry only**: CLI から `--url` 等で任意 endpoint を渡せません。
2. **HTTPS のみ**: username/password・query・hash・localhost・private/link-local・IP literal を拒否します。
3. **Host allowlist**: registry に載った host だけ。HTTP redirect は follow せず fail closed です。
4. **Tool allowlist**: remote の tool 一覧は observed として返しますが、呼べるのは registry 宣言分のみです。
5. **Write-like 名**: `send` / `submit` / `purchase` 等は `read_public_data` では登録・実行できません。
6. **Human Gate**: `approval=required` の tool は、service / tool / arguments digest / expiry / nonce を含む改ざん検知可能な approval artifact が必須です。単純な `--yes` では回避できません。
7. **エラー正規化**: remote の内部 URL・stack・secret は CLI 出力へ漏らさず、安定 issue code に正規化します。

## Approval artifact（将来の side-effect 用）

現在の 4 サービスはすべて `approval=none` です。将来 side-effect tool を追加する場合の契約:

```json
{
  "schema_version": 1,
  "purpose": "agent-service-tool-call",
  "service_id": "future-write",
  "tool": "submit_inquiry",
  "arguments_digest": "<sha256 of canonical JSON arguments>",
  "expires_at": "2026-08-07T12:00:00.000Z",
  "nonce": "unique-nonce-value",
  "approval_digest": "<sha256 of the payload without approval_digest>"
}
```

```sh
node bin/pipeline service-call \
  --service future-write \
  --tool submit_inquiry \
  --arguments '{"message":"..."}' \
  --approval-artifact ./approval.json \
  --json
```

期限切れ・別 tool/args・改ざん・replay はすべて実行前に拒否されます。

## 生成 connections との違い

| | Agent Service Registry | Generation connections |
|---|---|---|
| 正本 | `agent-services/registry.yaml` | `connections/catalog.yaml` |
| CLI | `services` / `service-tools` / `service-call` | `connections` |
| 用途 | 公開データの Remote MCP 参照 | 画像・動画・音声生成の課金経路 |
| auth | MVP は `none` のみ | subscription / api-key / local など |
| 課金 | しない | しうる |

## 現在の read-only 範囲

- 公開検索（`search`）
- 体験の検索・取得・プラン提案（`search_experiences` / `get_experience` / `plan_experience`）

含まないもの: 問い合わせ送信、予約、購入、公開、push、アカウント変更、任意 URL の MCP 接続。
