# TopView MCP生成

TopView adapterは、固定HTTPS endpointの公式TopView MCPを呼ぶ実行bridgeです。生成キャンバスでは「TopView MCP」と表示し、画像・動画・音声のモデルと必須parameterを実行時の`topview_get_generation_config`から取得します。静的なモデル一覧だけを実行可否の根拠にはしません。

## 単一画像から動画を生成する

```yaml
generation:
  connection: topview
  adapter: topview
  requests:
    - id: opening-shot
      input_mode: image-to-video
      first_frame: assets/opening.png
      prompt: "人物がゆっくり振り向き、カメラが少し前進する"
      model: Standard
      duration: 5
      aspect: "9:16"
      params:
        resolution: 720
        sound: true
```

`first_frame`は`project.yaml`基準の相対pathです。未存在ファイル、repo外path、絶対path、symlinkは`validate`で拒否され、`run`直前にも再検証されます。`review`ではこの画像をGate 1確認用に表示します。検証済み画像は`dist/<run-id>/assets/generation-inputs/`へ固定され、TopViewには固定後のpathだけを渡します。

```sh
node bin/pipeline doctor --config <project.yaml> --json
node bin/pipeline validate --config <project.yaml> --json
node bin/pipeline plan --config <project.yaml> --json
node bin/pipeline review --config <project.yaml> --json
node bin/pipeline run --config <project.yaml> --dry-run --json
```

`run --dry-run`はMCPへ生成タスクを送らず、クレジット見積もりだけを返します。実生成はレビュー済みのGate 1をCoordinatorが承認した後だけ実行できます。生成済みメディアは`dist/<run-id>/`へ取得され、assembled manifestの`clips`、`images`、`audio`と`provenance`に記録されます。

対応する生成種別は次の通りです。

- `operation: image`: text-to-image、画像編集
- `operation: image` + `params.task_type: storyboard`: ストーリーボード画像
- `operation: video`: text-to-video、image-to-video
- `operation: reference`: 画像・動画参照によるomni reference
- `operation: motion-control`: 画像と動画を使うmotion control
- `operation: music`: 音楽生成
- `operation: voice`: `params.voice_id`による音声合成。`input_audios`を指定した場合は参照音声によるinstant voice生成
- `operation: template`: `params.template_id`に`remove-background`、`product-avatar`、`avatar-video`を指定するTopView専用処理

TopView側のモデル・必須parameterが変わり得るため、具体的な選択肢はMCPの実行時configを正本にします。未対応の入力組み合わせや、選択モデルが実行時configにない場合は課金前に停止します。

専用templateでは、`remove-background`は`first_frame`を対象画像、`product-avatar`は`first_frame`を背景除去済み商品画像・最初の`input_images`をモデル画像、`avatar-video`は`first_frame`をアバター画像として扱います。既存avatar IDを使う場合は`params.avatar_id`を指定します。すべてのローカル入力はrun内へ固定してから送信します。

## 認証と秘密情報

- TopViewのログインで作成されたprivate credential file、または`TOPVIEW_UID`と`TOPVIEW_API_KEY`を使う。
- `doctor`はMCP tool availabilityだけを非課金で確認する。契約権限と残高はGate 1前に別途確認する。
- credential、署名付きupload/download URL、認証headerをmanifestやログへ保存しない。
