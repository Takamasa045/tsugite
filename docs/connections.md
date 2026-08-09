# 生成サービスとモデルの選択

Tsugiteでは、外部生成の選択を次の3軸に分ける。

1. **capability**: 何を作るか。例: 動画、画像、TTS、音楽、効果音、文字起こし
2. **model**: どの生成モデルを使うか。例: Seedance、Kling、PixVerse
3. **connection profile**: どの契約・認証・課金経路で実行するか。例: TopView MCP、PixVerse CLI、各社API、ローカル実行

同じモデルが複数のサービスから使えるため、`model` だけでは課金先は決まらない。反対に、サービス名とモデル名が同じ場合でも、接続プロファイルとモデルは別フィールドとして扱う。

## 利用者への確認ルール

外部生成を含む依頼では、projectを確定する前に次の順で接続を解決する。

```sh
node bin/pipeline connections --model "Seedance 2.0" --capability video.image-to-video --json
```

`connections` は読み取り専用で、課金や外部生成を行わない。フィルタを省略すると登録済みconnectionを一覧できる。

| 利用者の指定 | 対応 |
|---|---|
| サービスと対応モデルの両方が明示されている | その選択を使い、接続について再質問しない |
| サービスだけが明示されている | その接続を使う。モデルの選択が結果を大きく変え、既定値で安全に決められない場合だけモデルを確認する |
| モデルだけが明示され、対応するready接続が1つ | 候補と状態を示し、サービスを確認する |
| モデルだけが明示され、対応するready接続が複数 | 候補と状態を列挙し「どのサービスを使って生成しますか？」と確認する |
| サービスが未指定 | capabilityとmodelに対応する候補と状態を列挙し、同じ質問で確認する |
| readyの接続がない | 手持ち素材、手動取り込み、ローカル生成、希望サービスの接続設定を案内する |

明示された接続から別の契約、モデル、課金アカウントへ自動fallbackしない。過去projectの選択も、今回の課金先を自動決定する根拠にしない。

### 案内例

> Klingで動画を生成できる接続が3つあります。
> - PixVerseサブスク（PixVerse CLI。PixVerse側の料金・残高）
> - Kling直契約（Kling CLI。Kling側の料金・残高）
> - TopViewサブスク（TopView MCP。TopView側の料金・残高）
> どのサービスを使って生成しますか？

モデル名がKlingでも、`connection: pixverse`ならPixVerse経由、`connection: kling-direct`ならKling直契約である。Tsugiteはこの2つを自動で取り替えない。

## PixVerse CLIとKling CLI

`PixBurst`は別の接続やモデルではなく、`pixverse`接続の表示用aliasである。どちらの名前で指定しても課金先と実行adapterはPixVerse CLIになる。

`pixverse`接続は、インストール済みPixVerse CLIが公開する `create video / image / transition / voice / music / extend / modify / upscale / reference / motion-control / template` をgeneration requestから扱う。Gemini、Kling、Grok、MiniMax等のモデル名をTsugiteの固定allowlistで制限せず、CLIの検証結果を正本にする。

`kling-direct`接続は、Kling CLIの `text_to_image / image_to_image / text_to_video / image_to_video` を扱う。利用可能モデルとモデル別パラメータは `kling who_am_i` の実行時宣言が正本である。

## MiniMax direct（Phase A: preflight-only）

`minimax-direct` は MiniMax 公式 CLI `mmx`（>= 1.0.19）への接続枠です。**PixVerse 経由の MiniMax-H3 とは別 connection** です。混ぜないでください。

| 項目 | 契約 |
|---|---|
| 状態 | 実生成は **未統合**（`available-to-add` / preflight-only）。`ready` にしない |
| CLI 不在 | `needs-setup`（存在を偽装しない） |
| 認証 | 環境変数名 `MINIMAX_API_KEY` のみ宣言。値はログ・成果物・チャットに出さない。command 存在だけでは ready にしない |
| dry-run | `mmx video generate --model MiniMax-H3 --last-frame <pinned-path> ... --dry-run` を argv 配列で構築。`--image` / first-frame を付けない。`billing_action: false` / `generation_submitted: false` |
| IR → provider | `minimax-h3` → `MiniMax-H3` は明示 mapping のみ（推測変換禁止） |
| last-frame-only | MiniMax direct で対応。PixVerse では `H3-C007` で停止（transition 偽装・同画像複製・T2V 降格なし） |
| 公式 MCP | Hailuo-02 世代。H3 / last-only / H3 reference の実行根拠に使わない |

参照: [H3 Prompt Director](./h3-prompt-director.md)、`adapters/minimax/`、`knowledge/video-models/minimax-h3/prompt-guide.yaml`。

## MiniMax HTTP（Phase C: durable job / preflight-only）

`minimax-http` は MiniMax 公式 HTTPS API 向けの **別 connection** です。`minimax-direct`（`mmx` CLI）と **混ぜない・自動fallbackしない・承認/credentialを共有しない** でください。

| 項目 | 契約 |
|---|---|
| 状態 | 価格正本未設定の間は **preflight-only / blocked**。実送信準備完了とは表示しない。`submit: false` + `runtime_readiness: preflight-only` |
| 初期 scope | MiniMax-H3 **last-frame-only** のみ（exactly one last-frame asset）。first-frame 付与・同画像複製・T2V 降格・他 mode 推測は禁止 |
| 認証 | 環境変数名 `MINIMAX_API_KEY` のみ宣言。値は schema / artifact / log / audit / error に保存しない |
| durable job | `src/generationJobs` の provider-neutral 基盤（approval digest / submission_unknown / resume / pin） |
| transport | 固定 HTTPS allowlist、redirect 拒否、bounded timeout/poll/download、Content-Length と stream 上限、SHA-256、atomic local pin |
| テスト | repo-local **fixture-only** transport marker を DI。外部 DNS/HTTP/provider を呼ばない。real HTTP client / DNS resolver は **未実装** |
| pipeline | opt-in preflight / dry-run のみ。`run` / `render` / 課金 / Gate 更新は行わない |
| 将来 live 時 | public production factory だけでは live 不可。**public-IP 固定と DNS-rebinding 防御**を実装してから実送信を許可すること |

参照: `adapters/minimax-http/`、`profiles/connection-capabilities/minimax-http.yaml`、`src/generationJobs/`。

```yaml
generation:
  connection: pixverse # または kling-direct
  requests:
    - id: hero-still
      operation: image
      prompt: 夕暮れの工房
      model: gemini-3.1-flash-image
      aspect: "16:9"
      params: {}
    - id: narration
      operation: voice
      output_kind: audio
      audio_role: narration
      prompt: ものづくりの旅が始まります
      model: speech-2.8-hd
      params:
        voice_id: preset-id
```

既存の動画requestは`operation`省略時に`video`として扱う。参照素材は`first_frame`、`reference_images`、`input_images`、`input_video`、`input_videos`、`input_audios`でproject内の相対pathを指定し、実行前にrun directoryへ固定する。

## 非課金のモデル互換性確認

生成前に、projectが指定するモデルとparameterを次の読み取り専用コマンドで確認できる。

```sh
node bin/pipeline models --config <project.yaml> --json
```

ランチャーの生成キャンバスでは「モデル互換性を確認（非課金）」を使う。どちらも生成タスクを送信せず、クレジットを消費しない。

- TopViewは`topview_get_generation_config`を実行時に取得し、モデルの存在、必須parameter、選択肢を照合する。静的なモデル一覧を実行可否の根拠にしない。
- PixVerse／PixBurstはCLIのバージョンとTsugiteから渡す引数を確認する。CLIに汎用の非送信モデル検証がないため、モデル自体の受理は生成時のCLI検証まで確定しない。`provider-validation-required`は異常ではなく、この未確定境界を示す。
- `billing_action: false`と`generation_submitted: false`が、この確認で生成や課金を行っていないことを示す。

互換性確認の成功は、認証、残高、レート制限、Gate 1承認を代替しない。新しいモデルを指定しても、明示されたconnectionから別のサービスへ自動fallbackしない。

## 接続状態の語彙

| 状態 | 意味 | 実行判定 |
|---|---|---|
| `ready` | transportと必要な認証を確認済みで、要求capability/modelに対応 | 候補にできる。ただしGateとクレジット確認は別途必要 |
| `needs-verification` | MCP handoff、ログイン、契約権限、残クレジットなどを機械確認できない | readyとみなさず、選択後に手動確認 |
| `needs-setup` | 必要なCLIまたは宣言済み環境変数が不足 | セットアップ完了まで実行不可 |
| `not-integrated` | 登録枠はあるが、Tsugiteからの自動実行adapterは未接続 | 自動実行せず、setupまたはmanual importを案内 |

`ready`は「現時点で、レジストリが機械確認できるsetup checkを満たした」状態であり、料金、残高、レート制限、プロバイダ障害まで保証しない。manual checkが必要なconnectionは `needs-verification` とし、実行前に確認する。
subscription/API keyを使うintegrated connectionは、environmentまたはmanualの認証checkを必須とし、command存在だけでreadyにしない。認証方式とsecretを含まない接続契約digestはGate 1 reviewへ固定する。接続定義が変わった場合は再レビューする。

## 契約がない場合

外部生成サービスが1つもreadyでなくても、Tsugiteの企画、台本、story guide、Gate 1 review用の設計、手持ち素材の編集、QAは進められる。次の選択肢を案内する。

- 手持ちの動画・画像・音声を使う
- 他サービスで生成したローカルファイルを手動取り込みする
- 対応するローカル生成runtimeを使う
- 必要になった時点で、希望するサービスを1つ接続する

「すべてのサービスへの契約が必要」とは案内しない。素材生成が必要になるまでは、外部契約なしで進められる範囲を明示する。

## 認証と秘密情報

- API key、token、cookie、認証URLをチャット、`project.yaml`、Git管理ファイルへ貼り付けさせない。
- プロバイダのログインフロー、OSのcredential store、またはadapterが宣言する環境変数を使う。
- `doctor`がtransportを確認できても、認証、契約権限、残高まで確認したことにしない。
- 外部送信対象と見積もりをGate 1前に示し、明示承認なしで実行しない。

## TopViewの位置付け

利用者向けの選択・認証上、TopViewは **TopView MCP接続** として表示する。`adapters/topview/` は公式HTTPS MCPへ接続するrepo-local実行bridgeで、Gate 1承認後にだけ画像・動画・音声タスクを送信し、結果を案件内へ取得する。MCP transportが到達可能なだけでログイン、利用権限、残高まで確認済みとは表示しない。

## 新しいベンダーを追加する

接続候補はMCP、CLI、公式API、ローカルruntime、手動取り込みを同じ登録契約で追加できる。自動実行対応にするには、最低限次を宣言する。

外部生成adapterは原則としてconnection登録と明示選択が必須である。connectionを省略できる`local-only`は、外部送信も外部課金も行わないテスト／ローカルadapterだけに限定する。

- 安定したconnection IDと利用者向けlabel
- transport種別とrepo-local実行adapter/handoffの対応
- 対応capability、model、input mode、必須parameter
- 認証手段とsecretを保存しないsetup案内
- 副作用のないsetup checkと接続状態の変換
- クレジット見積もり、非同期jobの追跡、ローカル成果物化の方法
- 正規化したエラー、timeout、retry、キャンセル境界
- 送信するプロンプト・参照素材・音声の範囲

必要契約を満たせないベンダーは `manual import`として案内し、実行可能と表示しない。モデルカタログへの追加はprompt guidanceの追加であり、接続や利用権限の追加ではない。
