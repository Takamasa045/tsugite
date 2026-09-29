# ElevenLabs Eleven v4 / Turbo 音声生成

`generation.connection: elevenlabs` は ElevenLabs の[ホスト型MCP](https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp)を使います。Gate 1 承認後の Coordinator `run` だけが音声を生成します。`validate`、`plan`、`review`、`models`、`run --dry-run` は生成しません。

## 認証

継手の独立したCLIプロセスには、`ELEVENLABS_MCP_ACCESS_TOKEN` にホスト型MCP用のOAuthアクセストークンを渡してください。ElevenLabs APIキーは使いません。Codexに保存されたMCPのOAuth認証は継手のCLIへ自動共有されません。トークンの値を `project.yaml`、ログ、チャット、Git管理ファイルへ書かないでください。トークンを渡せない環境では自動生成は実行できません。

実行前には、そのアカウントと選択した voice ID で指定モデルが利用できること、残高と料金を確認してください。Professional Voice Clone は v4 用の学習が必要な場合があります。

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

この voice ID はユーザー指定の「いとぱんの声」です。通常のv4を使う場合は `model: eleven_v4` に変更できます。Eleven v4 Turbo とこの音声の組み合わせは、認証済み接続で未確認です。アダプターは単一話者、2,000文字以下、MP3の narration だけを扱います。複数話者、音声参照、追加パラメータ、他モデルへの自動切替は未対応です。

送信前にMCPの `tools/list` で、`text`、`voice_id`、`model_id` を持つ音声ツールを確認します。ツールが指定モデルを受け付けないと宣言していれば送信せず停止します。ElevenLabsの[モデル資料](https://elevenlabs.io/docs/overview/models)はv4 Turboの利用経路をText to Dialogue WebSocketと案内しており、ホスト型MCPからのTurbo生成は未検証です。`pipeline models --config <project.yaml> --json` はローカル契約だけを確認して `provider-validation-required` を返します。

MCPから返るMP3データまたはElevenLabsドメインの短期ダウンロードURLをrun内に固定し、manifestの narration に入れます。外部リンクや想定外の形式は拒否します。結果が不明なMCP呼び出しは二重課金を避けるため自動再送しません。`estimated_credits: 0` と結果の `credits: 0` は料金を計測していない意味で、無料ではありません。

モデル情報: [ElevenLabs Models](https://elevenlabs.io/docs/overview/models)。
