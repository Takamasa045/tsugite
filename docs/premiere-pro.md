# Premiere Proを任意の外部エディタとして使う

`$premiere-editing`（Claude Codeでは `/premiere-editing`）で既存動画のカット、トランジション、音声、字幕、色調整と実機確認を行う。正本は [Premiere編集Skill](../.agents/skills/premiere-editing/SKILL.md)、演出の選び方は [編集ガイド](../.agents/skills/premiere-editing/references/editorial-guide.md)。

Premiereは任意のローカル連携。通常のTsugiteセットアップ、doctor、Remotion / HyperFramesには不要。今回はエージェント向け編集入口であり、`project.yaml` の新backendや `pipeline render` の実装ではない。LauncherにPremiere実行ボタンは追加しない。

## 最小構成と完了条件

- 1台のMac、インストール済みPremiere、ローカルstdio MCP、保存済みコピーの1案件から始める。
- `premiere-pro-mcp@1.14.9` のCEP接続を使う。UXPや別の接続先へ自動で切り替えない。
- 接続確認は `get_capabilities` と `ping`。案件・シーケンスを開いたら `verify_premiere_connection` と対象の読み戻しを行う。
- 編集の成功は、保存・タイムライン読み戻し・Premiereでの再生で判断する。MCPレスポンスやカタログだけで判断しない。

## ローカルセットアップ

エージェントが利用者に代わって設定できる。まず既存のPremiere版、Node、同じMCP接続、CEPパネルを確認し、重複導入しない。導入依頼が既にあれば再確認せずその範囲で進める。通常の動画編集依頼だけから、未導入のソフトや設定変更まで推定しない。

1. Premiereの既存案件を確認する。未保存作業を勝手に保存・破棄しない。
2. npmレジストリから固定版をdurableなローカルフォルダに導入する。coreの `package.json` には加えない。macOSの例:

   ```sh
   npm install --prefix "$HOME/.local/share/tsugite/premiere-mcp/1.14.9" --ignore-scripts --no-audit --no-fund premiere-pro-mcp@1.14.9
   ```

3. Premiereを通常終了した後、同パッケージの `artifacts/MCPBridgeCEP.zxp` をインストールする。既存の `~/Library/Application Support/Adobe/CEP/extensions/MCPBridgeCEP` があれば版・由来を確認し、無条件に置換しない。署名付きZIPをユーザーCEPディレクトリへ展開する場合も `META-INF/signatures.xml` を含む内容を変更せず保持する。
4. 標準の `--install-cep` はdebug設定を変更する場合がある。無条件実行しない。このMacでは署名付きアーカイブの配置と再起動で接続でき、`PlayerDebugMode` は変更していない。署名・権限で止まったら原因を確認し、保護設定を勝手に無効化しない。
5. MCPクライアントへ下の設定を追加する。サーバーとPremiereは同じMacで動かす。HTTPサーバー、外部ホスティング、APIキーは不要。
6. Premiereを起動し、必要に応じてWindow > Extensionsの接続パネルを開く。新しいエージェントセッションで接続確認する。

### Codex

既存の `tsugite-premiere` があれば設定を確認して再利用する。新規登録例（ユーザー単位のCodex設定に追加される）:

```sh
codex mcp add tsugite-premiere \
  --env PREMIERE_MCP_PROTOCOL_MODE=legacy \
  --env POSTHOG_API_KEY= \
  -- node "$HOME/.local/share/tsugite/premiere-mcp/1.14.9/node_modules/premiere-pro-mcp/dist/index.js"
codex mcp get tsugite-premiere --json
```

GUIからNodeが見つからない場合は、このMacで確認したNodeの絶対パスを指定する。接続設定の追加は全タスクからの発見を可能にするが、無関係な案件を編集する承認ではない。現在のセッションでツールが再検出されなければ、新規セッションまたはクライアントの再読込が必要。実行ファイルはローカル固定版を使い、接続のたびに `npx -y` でダウンロードしない。

`legacy` は今回動作確認したstdio接続の互換モード。将来の更新では新しい版とクライアントの接続を再確認する。空の `POSTHOG_API_KEY` はこのパッケージの任意telemetryを無効にするための明示設定。

### Claude Codeなど

既存のMCP設定へ次のエントリーだけをマージする。以下はひな形であり、NodeとMCPのパスを実機の絶対パスへ置き換える。プレースホルダーのまま登録しない。

```json
{
  "mcpServers": {
    "tsugite-premiere": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/PATH/TO/premiere-pro-mcp/dist/index.js"],
      "env": {"PREMIERE_MCP_PROTOCOL_MODE": "legacy", "POSTHOG_API_KEY": ""}
    }
  }
}
```

## Tsugite案件での利用

「この案件をPremiereで仕上げて。場面転換は穏やかに」のように依頼する。エージェントは対象の `project.yaml` とGateを読み、承認済み素材・編集案と照合して外部編集を進める。 `.prproj`、素材コピー、前後比較・QA記録はdurableな案件フォルダの `premiere/` に保存する。

既存の制作Skillの承認境界は維持する。Premiere操作を `run` / `render` のGate迂回に使わない。外部編集結果を既存manifest/stateへ手動で差し込み、機械検査済み・Gate 3承認済みと扱わない。独立した編集テストは独立成果物として報告する。既存の最終動画を変更したら旧版を残し、新版は再QA・承認の対象とする。

## 実測の対応範囲

2026-09-06、macOS / Premiere 26.2.0 / MCP 1.14.9で、コピーした1080p30素材3本を使って確認した。これは特定環境の実測であり、すべてのバージョンや素材の保証ではない。

|操作|結果|
|---|---|
|MCP新規project、3本import、sequence作成|成功、実機読み戻し済み|
|MCP `trim_clip`|失敗を検出。source outのみ変更されtimeline endが不変|
|GUIによる末尾トリミング|成功。映像・音声とも30秒→25秒、全体86秒→81秒|
|保存→閉じる→再オープン|成功。配置・source範囲が一致、映像素材offlineなし|
|Premiere再生|先頭から81秒終端まで再生。3本の映像と2・3本目の音声メーター確認|
|音の聴感、トランジション、字幕、色、書き出し|未検証。今後各操作をコピー上で検証する|

## 出典と保守

- [Premiere MCP上流](https://github.com/leancoderkavy/premiere-pro-mcp)（MIT）。npm固定版とCEP版をそろえ、更新後は接続・コピー編集・再オープンを再確認する。
- [上流の編集Skill](https://github.com/leancoderkavy/premiere-pro-mcp/tree/main/plugins/premiere-pro/skills/edit-premiere-project)。本repoはこのSkillを丸ごと複製・自動更新せず、Tsugiteの承認・演出・実測制限を独自に記述する。
- [Adobe公式UXP](https://developer.adobe.com/premiere-pro/uxp/)。APIの存在は現在のCEP接続での実行可否を意味しない。
