# Agent Service Registry（公開 Remote MCP）

Tsugite の **Agent Service Registry** は、公開 read-only の Remote MCP を安全に呼び出すための専用レジストリです。

- **生成サービスの課金経路**（`connections/catalog.yaml`）とは別系統です。混ぜません。
- **任意 URL は受け付けません。** endpoint は bundled `agent-services/registry.yaml` からのみ解決します。
- **Read-only MVP**: 現行 runtime は `read_public_data` / `approval=none` のみ実行します。`side_effect` や `approval=required` は schema 上で将来表現できても、**network 前に必ず拒否**され、CLI から解除できません。
- **Human Gate** は「read-only 以外を agent 単独実行させず停止し、人間が別の信頼済み実行面で行う」境界です。偽の approval artifact や process-local replay は提供しません。

## 登録済みサービス（MVP）

| id | display name | endpoint | allowlisted tools | policy |
|---|---|---|---|---|
| `itopan-search` | itopan Search | `https://…search.ai.cloudflare.com/mcp` | `search` | `read_public_data` / `approval=none` |
| `azumimusuhi-search` | azumimusuhi Search | `https://…search.ai.cloudflare.com/mcp` | `search` | `read_public_data` / `approval=none` |
| `lab-search` | lab Search | `https://…search.ai.cloudflare.com/mcp` | `search` | `read_public_data` / `approval=none` |
| `azumi-experience` | Azumi Experience | `https://azumi-experience-mcp.tkms045.workers.dev/mcp` | `search_experiences`, `get_experience`, `plan_experience` | `read_public_data` / `approval=none` |

正本: [`agent-services/registry.yaml`](../agent-services/registry.yaml)

Cloudflare 公式の公開 MCP URL 形式および Workers 上の公開 endpoint は、公開情報として registry に記載しています。secret やアカウント情報は書きません。

## CLI

```sh
# レジストリ一覧（network なし）
node bin/pipeline services --json

# リモートの tool 一覧（network あり）。registry 未宣言 / side_effect は callable=false
node bin/pipeline service-tools --service itopan-search --json

# tool 呼び出し（network あり）。allowlist + read-only policy を通過したものだけ
node bin/pipeline service-call \
  --service itopan-search \
  --tool search \
  --arguments '{"query":"AIエージェント"}' \
  --json
```

安定 JSON フィールドの要点:

| field | 意味 |
|---|---|
| `network` / `network_attempted` | `services` は `false`。成功した `service-tools` / `service-call` は `true`。policy/validation および exact allowlist 拒否（`endpoint_forbidden` 等）は DNS 前なので `false`。実 DNS/connect 後の失敗（`endpoint_dns_private` / `network` / `timeout`）は `true` |
| `billing_action` | 常に `false`（購入・決済操作ではない） |
| `provider_usage_possible` | 常に `true`。公開 MCP の query は provider の quota / usage を消費し得る |
| `remote_usage` | 実際に remote を叩いたとき `true` |
| `blocked_undeclared` | remote に見えたが registry 未宣言の tool 名のみ |
| `blocked_by_policy` | registry 宣言済みだが現行 policy で non-callable の `{ name, reason }` 一覧（例: `side_effect` / `approval_required`） |
| `side_effect` | 成功時は常に `false`（side_effect tool は実行前拒否） |
| `human_gate` | 成功時は `not_required`。side_effect は `agent_service.human_gate_required` / `side_effect_blocked` で停止 |
| `secret_values_exposed` | 常に `false` |

## 安全境界

1. **Bundled registry only**: production CLI は常に `agent-services/registry.yaml` のみ。`TSUGITE_AGENT_SERVICES_REGISTRY` や CLI path 差替えは無効。programmatic な path injection はテスト用関数引数のみ。
2. **Exact endpoint bind**: scheme / origin / explicit port / path を registry 宣言どおりに固定。query / hash 不可。同一 endpoint への GET/POST/DELETE は許可、別 path / port は禁止。exact allowlist 判定は DNS より前。
3. **DNS publicness**: production MCP session は **pre-connect 1 回** DNS を解決し、loopback / private / link-local / CGNAT / ULA / multicast / unspecified / documentation / NAT64・6to4 埋込 private / site-local / discard / benchmarking 等を拒否する。`createAllowlistedFetch` 単体の default は **per-request 再検査**だが、`defaultTransportFactory` は precheck 後 `skipDns=true` で二重解決を避ける。**DNS TOCTOU**（解決後に応答が変わる）は限界として残る。主要 trust boundary は固定 Cloudflare / Workers host。
4. **Redirect manual + 全拒否**: HTTP redirect は follow しない。
5. **Tool allowlist**: remote の tool 一覧は observed として返すが、呼べるのは registry 宣言の read-only 分のみ。未宣言は `blocked_undeclared`、宣言済み non-callable は `blocked_by_policy`。
6. **Write-like 名**: `send` / `submit` / `edit` / `drop` / `grant` / `approve` / `commit` / `merge` 等は defense-in-depth で拒否。
7. **Human Gate (fail closed)**: `side_effect` / `approval=required` は artifact や `--yes` では解除不能。人間は別の信頼済み実行面で行う。
8. **Session hard deadline**: `withRemoteMcpSession` が AbortController と default 30s deadline を必ず持ち、connect / list / call / close を bounded にする。cleanup hang も短い best-effort で main を返す。
9. **エラー正規化**: remote の内部 URL・stack・secret は CLI 出力へ漏らさず、安定 issue code に正規化します。

## 生成 connections との違い

| | Agent Service Registry | Generation connections |
|---|---|---|
| 正本 | `agent-services/registry.yaml`（bundled 固定） | `connections/catalog.yaml` |
| CLI | `services` / `service-tools` / `service-call` | `connections` |
| 用途 | 公開データの Remote MCP 参照 | 画像・動画・音声生成の課金経路 |
| auth | MVP は `none` のみ | subscription / api-key / local など |
| 購入・決済 | しない（`billing_action=false`） | しうる |
| provider usage | **しうる**（`provider_usage_possible=true`） | しうる |

## 現在の read-only 範囲

- 公開検索（`search`）
- 体験の検索・取得・プラン提案（`search_experiences` / `get_experience` / `plan_experience`）

含まないもの: 問い合わせ送信、予約、購入、公開、push、アカウント変更、任意 URL の MCP 接続、approval artifact による side-effect 解除。
