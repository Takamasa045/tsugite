# ElevenLabs Eleven v4 / Turbo 音声生成

`generation.connection: elevenlabs` は hosted MCP 用アダプターです。Gate 1承認後のCoordinator `run` が生成します。`validate`、`plan`、`review`、`models`、`run --dry-run` は生成しません。

新規送信には、明示取得した有効な見積と、その見積を含むGate 1承認が必要です。価格unknownを0や無料として承認しません。

`test/elevenlabs-public-cli.test.mjs` は公開CLIを別processで起動する無課金テストです。MCP/MP3通信とbearerのみfixtureにし、Gate・digest・保存・manifest/QC・Remotion renderを本番処理で通します。macOSでは子Chromeを含む外部通信をsandboxで禁止し、render用loopbackだけ許可します。本物のKeychainは使用しません。このfixtureの成功は実providerの課金・音質の検証とは別です。

生成adapterの失敗はstderrのversion 1 JSON envelopeで返します。親は4KiB以内・既知code・固定phase/state/action・request一致を検査し、未知形式は汎用エラーにします。provider本文・signed URL・private pathは転記しません。`not_submitted`、受理済み`accepted`、送信結果`unknown`、確定失敗`failed`を区別し、envelopeだけを再送許可にはしません。signal終了・不完全な成功JSONは結果不明として再試行しません。`recovery_action`は安全な操作の分類で、実際の同一job復旧commandは次のreceipt実装で提供します。

## 対応する呼び出し

- 単一話者、2,000文字以下、MP3 narration。追加parameter、参照音声、複数話者、別モデルへの自動切替は未対応。
- `tools/list` の全ページを読み、指定 `model_id` が `enum` / `const` に明示された場合だけ送信します。
- 旧 `text_to_speech` / `generate_speech` / `create_speech` の `text`・`voice_id`・`model_id` 契約を維持。
- 新 `creative_generate_speech` は `prompt`・`context`・`voice_id`・`model_id` を使い、`generations_count: 1`、`estimate_only: false` を明示します。互換な `creative_get_flow_run_status` も送信前に必要です。
- 生成は1回だけ。返されたflow/sessionを限定して完了まで照会し、1音声のmodel・本文・voiceを照合して取得します。結果不明、失敗、待機期限超過では生成を再送しません。
- 送信前にrun内へ `.submission.jsonl` を排他的作成し、受理後のflow/session IDを追記します。同じrequestの再実行も停止します。ログにはOAuth tokenや短期URLを保存しません。journalを削除して再送することを通常の復旧手順にしないでください。
- 新規送信はmacOS/Linuxでdirectory fsyncが成功する場合だけ対応します。新しく作ったrun/assetsの祖先directory、journal本体、journalの親directoryを順に同期してから送信し、途中の失敗では送信しません。空・部分書込のjournalも残します。Windowsなど同等の永続化を確認していない環境では `submission_durability_unsupported` で停止します。
- 回帰テストは同期順序・失敗注入・別process競合・filesystem永続化モデル・実SIGKILL・OSのdirectory fsyncを区別します。SIGKILLによる再送防止の検証は、任意の電源断やstorage故障に対するexactly-onceの保証ではありません。
- MP3またはElevenLabsドメインのURLを受け付けます。実接続で確認したGoogle Storageの `xi-backend/database/workspace/.../content_generation/.../.../content.mp3` も限定的に許可します。他bucket、redirect、想定外形式、過大な応答を拒否します。

```yaml
generation:
  connection: elevenlabs
  requests:
    - id: opening-voice
      operation: voice
      output_kind: audio
      audio_role: narration
      model: eleven_v4_turbo
      prompt: "ものづくりの旅が始まります。"
      params:
        voice_id: mP74e7DoGAGQYxAmpTm8
```

このvoice IDは既存のユーザー指定「いとぱん」の設定例です。現在の利用権・モデルとの組合せは未検証で、別IDへ自動置換しません。通常v4を明示的に選ぶ場合は `model: eleven_v4` とします。

2026-10-15 UTCの認証済みCodex接続では `eleven_v4` が利用可能で、`eleven_v4_turbo` は提供スキーマにありません。`eleven_turbo_v2_5` は別モデルです。モデル資料のv4 Turboの存在をhosted MCP対応の証拠にせず、指定がなければ生成前に停止します。[公式モデル資料](https://elevenlabs.io/docs/overview/models)

## 明示的な料金確認とGate承認

```sh
# 本文・声・モデル・文字数・数量のpreview。外部通信なし。
node bin/pipeline quote --config path/to/project.yaml --json
# 内容確認後、見積だけを明示取得。Gateや生成は実行しない。
node bin/pipeline quote --config path/to/project.yaml --approve-transfer --actor coordinator --json
node bin/pipeline review --config path/to/project.yaml --json
# レビュー確認後、通常のGate 1 approveとCoordinator runへ進む。
```

実提供schemaで`estimate_only: true`と数量1が使える場合だけ呼びます。通常のplan/validate/review/models/dry-runから見積APIへ自動送信しません。provider上に非課金flowが作成される場合があります。schema非対応やTurbo非提供では停止し、別モデルに替えません。

見積は取得後5分の**継手側の有効期限**を持ちます。providerがこの期間の価格を保証したという意味ではありません。本文・声・モデル・数量、provider schema、接続profile/grant epoch、credits/金額の上限をGate digestへ結合し、adapterも保存済みstateと照合します。quote・上限・接続の変更後は再レビューが必要です。上限は送信判断に使い、provider請求の技術的な上限固定や残高確認を保証しません。

`billing.schema_version: 1`はunknown/unmeasuredをnull、実測0を`"0"`として区別します。creditsと金額はdecimal文字列です。確認済みのfiat単位はUSD/1 generationのみで、未確認通貨・不正単位・overflowは停止し、換算しません。fiat項目がない場合は金額未確認です。既存の数値`estimated_credits`/`actual_credits`は互換用に残し、新しい送信判断と表示にはbillingを使います。実績をmanifest/run logへ保存し、同じgeneration参照のimportを重複加算しません。

`project.yaml`のroot `billing`は実行時情報の予約名です。YAMLやadapter入力JSONの自己申告から送信許可を作りません。

専用Keychainではloginごとに非秘密`grant_epoch`を作り、通常refreshでは維持します。旧recordにepochがなければ読取り・probeは継続できますが、新規送信の見積には明示的な再接続が必要です。既存bearer環境では、管理者が非秘密の`TSUGITE_ELEVENLABS_GRANT_EPOCH`を明示し、grant差替え時に更新してください。任意の非秘密profile名は`TSUGITE_ELEVENLABS_PROFILE_ID`です。この方式は管理者の申告であり、workspaceやgrant同一性をAPIで自動検証したという表示はしません。token bytesをdigestやcacheへ保存しません。

課金送信前のdurable journalには見積・承認参照と消費済み送信許可を記録し、利用額未確定を保持します。結果不明で予約を返したりjournalを消して再送したりしません。project全体の未解決処理検出と同一jobの取得再開はreceipt段階で拡張します。

## CLI認証と無課金診断

独立した継手CLIは、既存の `ELEVENLABS_MCP_ACCESS_TOKEN` または継手専用Keychain profileを明示選択して使います。APIキーは使いません。Codex/公式CLIのOAuthやkeychain項目を自動共有・抽出しません。

既存の正規bearer環境が利用できる場合の無課金診断:

```sh
node adapters/elevenlabs-v4/probe.mjs eleven_v4
node adapters/elevenlabs-v4/probe.mjs eleven_v4_turbo
```

`tools/list` だけを読み、本文・voice IDを送らず、生成/見積ツールも呼びません。`requested_model_declared` と `adapter_compatible` を分けて報告します。終了コードは互換0、非互換/照会失敗20、認証なし30、引数不正40。`pipeline models` はローカル契約だけで `provider-validation-required` です。

### 継手専用OAuthの準備（公開GETのみ）

```sh
node adapters/elevenlabs-v4/auth.mjs plan
```

認可先・scope・保存先・client要件を報告します。Keychain、ブラウザ、callback listener、token発行・登録・生成を呼びません。2026-10-16 UTCの実discoveryで以下を確認しました。

| 項目 | 公開metadataの値 |
| --- | --- |
| resource | `https://api.us.elevenlabs.io/v1/mcp` |
| issuer | `https://api.us.elevenlabs.io` |
| authorization | `https://elevenlabs.io/app/oauth/authorize` |
| token | `https://api.us.elevenlabs.io/v1/oauth/token` |
| grant / PKCE / public client | authorization_code、refresh_token / S256 / none |
| client方式 | Client ID Metadata Document対応。registration_endpointは未公開 |
| 公開scope | convai_read、convai_write、text_to_speech、speech_history_read、flows、image_video_generation、voice_generation |
| 継手が要求するscope | **text_to_speech flows の2つだけ** |

[Protected Resource Metadata](https://api.us.elevenlabs.io/.well-known/oauth-protected-resource/v1/mcp)、[Authorization Server Metadata](https://api.us.elevenlabs.io/.well-known/oauth-authorization-server)を使用。地域・issuer・token endpoint・必要scopeなどが変化した場合は停止します。公開scope一覧を自動的に全件要求しません。専用2 scope接続の認証済みtools/listと、明示承認済み1本の生成・状態照会・取得は確認済みです。権限不足でも自動拡張しません。

### 認可前に必要な専用client metadata

利用者が管理する公開HTTPS URL（path付き、query/fragmentなし）をclient_idにし、同じURLでJSONを提供します。今回の承認済み専用URLは **https://itopan.jp/oauth/tsugite-elevenlabs-client.json**。秘密を含まないJSON 1件だけを別のportfolioリポジトリで公開し、200/application/json・redirectなし・元JSONとの一致を確認しました。他クライアントのmetadataは流用しません。[MCP Client ID Metadata Documents仕様](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-id-metadata-documents)

利用者が実際のURLを選んだ後、公開する内容を次で作れます。出力はclient名・redirect URI・scope等だけで秘密情報は含みません。

```sh
node adapters/elevenlabs-v4/auth.mjs metadata --client-metadata-url "$TSUGITE_ELEVEN_CLIENT_METADATA_URL"
```

固定client名は `Tsugite ElevenLabs narration`、redirectは `http://127.0.0.1:32145/elevenlabs/callback`、grantはauthorization_code/refresh_token、token認証はnoneです。秘密のclient_secretは作成しません。公開後、次で一致をGET確認します。

```sh
node adapters/elevenlabs-v4/auth.mjs plan --client-metadata-url "$TSUGITE_ELEVEN_CLIENT_METADATA_URL"
```

CIMDと固定loopback redirectは、2026-10-16 UTCに専用OAuthで実際に受理され、PKCE code交換と専用Keychain保存・読戻しが成功しました。要求/保存scopeは上記2つです。認可画面の表示内容やOSダイアログ自体は当タスクから未観測です。

### 明示承認後だけ行う操作

```sh
node adapters/elevenlabs-v4/auth.mjs login --client-metadata-url "$TSUGITE_ELEVEN_CLIENT_METADATA_URL" --approve-oauth --approve-keychain
```

この操作はブラウザを開き、ElevenLabsでworkspaceと `text_to_speech flows` を確認して認可します。127.0.0.1の固定callbackだけを待ち、PKCE S256・state・issuer・resourceを照合してcodeを交換します。状態・PKCE verifier・codeはメモリだけで保持し、3分で期限切れです。新規OAuth grant、scope同意、専用Keychain項目の作成/更新は、音声生成費用とは別に明示承認が必要です。両approveフラグなしではネットワーク・Keychain・ブラウザに触れる前に停止します。

保存はmacOS Keychainのservice **io.tsugite.elevenlabs-v4.oauth.us**、account **tsugite-narration** の1項目だけ。token/refresh token、期限、client ID、issuer/resource/scopeを保存します。秘密はOSコマンドのargvへ渡さずstdinで渡し、読戻し一致を確認します。平文ファイルfallbackや他のKeychain項目へのアクセスはありません。実保存・読戻し・専用接続での認証済みtools/listが成功しました。同一grantの実refreshとOS同意画面の観測は未検証です。

接続後は予約値を明示選択して使います。これはtokenではなく、この専用Keychain profileを選ぶ非秘密の文字列です。

```sh
ELEVENLABS_MCP_ACCESS_TOKEN=@tsugite-elevenlabs-v4-keychain node adapters/elevenlabs-v4/probe.mjs eleven_v4
```

`auth.mjs status` は専用項目の設定・期限だけを返し、refresh/保存しません。通常のprobe/生成で期限切れの場合は既に認可済みの同一grantだけをrefreshします。認可画面を自動起動せず、scopeの追加や動的client登録もしません。認証・保存失敗の応答本文や秘密をCLI出力しません。

公式 `elevenlabs auth login` は別クライアントの接続で、この継手専用手順には不要です。公式CLI、Codexからtokenを取り出す回避手順は使いません。[公式hosted MCP手順](https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp)

## 完了済み結果の明示インポート

生成を再送せず、取得済みの完了応答を保存する入口もあります。

```sh
node adapters/elevenlabs-v4/import-result.mjs /absolute/private/completed-result.json < payload.json
```

`payload.json` は通常のadapter入力 `{ "request": ..., "run_dir": "/absolute/run" }`。結果ファイルはMCPの `structuredContent` またはJSON text contentを持つ応答です。完了・1 session/音声・model・本文・voiceの一致を要求し、MCP生成や状態照会は呼びません。短期URLを含む結果は非公開の一時ファイルに置き、取得後に除去してください。生成失敗時の自動fallbackではなく、利用者が選ぶ別入口です。

結果は `metadata.source: imported-existing-generation` を持ちます。`credits` は元生成の実績であり、インポートで再度請求した額ではありません。料金が返らない旧ツールでは `provider_billing: unmeasured` / 数値0を維持し、無料とは表示しません。

## 検証済み範囲

2026-10-15 UTC、ユーザー承認の通常v4 / Ren（`d4Vuj6wQOxvRyQ320L3k`）/「これは音声生成の接続テストです。」16文字を、正規Codex接続で**1回だけ**生成しました。実績16 credits、0.3168 US cents（US$0.003168）、2.96秒、MP3 44.1kHz mono。モデルの変更や重複生成はありません。

2026-10-16 UTC、追加費用の明示承認後、同じ本文・声・通常v4を**継手専用OAuthから1本だけ**生成しました。実orchestrator→本番の `generate.mjs` 子CLI→認証済みhosted MCP→取得→manifest/QCが成功し、再開時は既存成果物を再利用して追加MCP呼出し0を確認しました。直前見積・実費とも16 credits / US$0.003168、3.04秒・66,906bytes・MP3 44.1kHz mono。専用検証ハーネスの一回限り送信監視を使用し、transportや応答のmockはありません。Gateは明示承認済みテストの隔離fixtureで、制作本番のGate承認や公開CLIの全Gate導線の検証とは区別します。

| 経路 | 結果 |
| --- | --- |
| 正規Codex接続で生成→状態照会 | 実生成成功。CLIアダプターからの送信ではない |
| 継手CLI import→orchestrator→manifest narration→Gate 2 QC→再開 | 同じ実音声で成功。追加生成/課金なし。検証fixtureのGate状態を使用 |
| orchestrator→子adapter→非同期生成/poll→音声pin→manifest/QC/state→再開 | 外部MCP/fetchだけを置換した無課金fixtureで成功 |
| 継手専用OAuth→Keychain→独立CLIの認証済み `tools/list` | 成功。hosted schemaのgenerations_countはinteger（1〜4）。1本指定を受理し、実schema fixtureで回帰検証 |
| 実orchestrator→独立CLIの認証済み `tools/list`→生成/poll→取得→manifest/QC→再開 | 追加承認の1本で成功。生成1、実費16 credits、再開時追加MCP呼出し0。隔離fixtureのGate状態を使用 |
| v4 Turbo | 実接続スキーマにモデル指定がなく未生成 |

検証音声は非公開のLibrary成果物として保持しています。ローカルWhisper smallの認識は「これは音声生成の接続テストです」で本文と一致し、ffmpeg decodeと音量検査も成功しました。現在のモデルには音声入力がなく、主観的な聴感検証はしていません。ASRを聴取の代替成功と扱いません。

専用OAuthで生成した2本目も同じローカルASRで本文一致、ffmpeg decode成功、平均-19.1dB・最大-2.7dB。主観的な聴感検証は同様に未実施です。別承認の2回を合計すると32 credits / US$0.006336で、意図しない重複送信はありません。私的なLibrary識別子・音声ファイル・認証情報・短期URLは公開リポジトリに含めません。

音声生成runでは既存の動画もrun内へ固定し、manifest・QC・run logのasset件数を一致させます。Gate 2は自動通過せず、人間の確認を待ちます。

## Durable receipts and existing-job recovery

New adapter-owned `*.receipt.json` v1 files are projections of the permanent
`*.submission.jsonl` v2 journal. Every accepted identity, poll/download budget,
verified MP3 hash/size/duration and billing update is fsynced before the next
external action. The journal remains present for older CLI versions. Old or
incomplete markers remain unknown; missing IDs are never inferred.

```sh
node bin/pipeline resume --config projects/example/project.yaml --json
node bin/pipeline resume --config projects/example/project.yaml --apply --actor coordinator --json
```

Preview reads local records only. Apply checks the original Gate 1 review and
uses the adapter's separate resume command: it can poll/download the same
flow/session and rebuild manifest/QC, but cannot submit a new generation. It
rejects active-mode and adapters without this declared capability. A normal
`run` may continue a partially completed set: pinned requests are hash/codec
verified and reused, accepted requests resume the same job, unknown requests
stop, and unsubmitted requests still need a current quote and unchanged Gate.
Changed approval/request content cannot silently adopt an earlier generation.

The cumulative per-request limits survive restarts: 30 polls, 120 seconds of
scheduled polling wait, three completed-result status refreshes and three
download attempts. Each status RPC has its own 20-second timeout; 120 seconds
is a wait budget, not a bound on total wall time. Exhaustion requires inspection,
never a fresh generation or a reset by restarting the CLI. Completed results may
refresh an expired download URL from the same job; signed URLs are not saved.

Before a new paid submit, a Gate-bound local project context locates
`.tsugite/elevenlabs-submissions/<request-digest>.json`. Unresolved entries block
new run IDs in the same project. A resolved prior entry requires both a new
quote and a new Gate approval to regenerate; its history is retained. This is a
local safeguard, not provider idempotency or a distributed lock across copies
whose project metadata was removed. New submissions from old quote caches
without a project context require a new quote/review.

Receipt pinning uses a fsynced temporary file, real MP3 codec/duration inspection,
and a durable candidate hash before linking the output. An orphan file is reused
only when that proof matches; symlinks, partial JSON, mismatched bytes and unknown
legacy records fail closed. Repeated import/resume records historical source
billing and zero new submissions. Existing source assets are reused only when
hashes match and are never overwritten during partial assembly.
