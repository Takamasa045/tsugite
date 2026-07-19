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

> Klingで動画を生成できる接続が2つあります。
> - TopView MCP: needs-verification
> - PixVerse CLI: needs-verification
> どのサービスを使って生成しますか？

## 接続状態の語彙

| 状態 | 意味 | 実行判定 |
|---|---|---|
| `ready` | transportと必要な認証を確認済みで、要求capability/modelに対応 | 候補にできる。ただしGateとクレジット確認は別途必要 |
| `needs-verification` | MCP handoff、ログイン、契約権限、残クレジットなどを機械確認できない | readyとみなさず、選択後に手動確認 |
| `needs-setup` | 必要なCLIまたは宣言済み環境変数が不足 | セットアップ完了まで実行不可 |
| `not-integrated` | 登録枠はあるが、Tsugiteからの自動実行adapterは未接続 | 自動実行せず、setupまたはmanual importを案内 |

`ready`は「現時点で、レジストリが機械確認できるsetup checkを満たした」状態であり、料金、残高、レート制限、プロバイダ障害まで保証しない。manual checkが必要なconnectionは `needs-verification` とし、実行前に確認する。
subscription/API keyを使うintegrated connectionは、environmentまたはmanualの認証checkを必須とし、command存在だけでreadyにしない。認証方式とsecretを含まない接続契約digestはGate 1 reviewへ固定する。外部実行先を環境変数で選ぶbridgeは`*_COMMAND`だけを直接routeとして宣言でき、JSON arrayには引数なしのwrapper実行ファイル1件だけを許可する。実行ファイルidentityをhashし、資格情報はdigestへ含めない。引数が必要なら、資格情報を別の認証環境へ分離したwrapperを用意する。接続定義または実行先が変わった場合は再レビューする。

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

利用者向けの選択・認証上、TopViewは **TopView MCP接続** として表示する。現行repo-local実装の `adapters/topview/` は、TopViewのPython toolkit/skillを呼び出すbridgeであり、`project.yaml` の実行adapter互換性のため内部で使う。この内部bridgeを別の利用者契約や、MCP認証済みの証明として表示しない。

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
