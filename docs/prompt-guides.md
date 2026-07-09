# モデル別プロンプト知識

`knowledge/video-models/` は、動画モデル別の T2V / I2V プロンプト知識を機械可読 YAML で保持します。現在は PixVerse、Kling、Seedance を収録しています。

カタログは計画用データです。カタログが存在しても、同名 adapter、API 接続、契約、利用権限、残クレジットが存在するとは限りません。`guides` は読み取り専用で、外部APIを呼びません。

## エージェントから参照する

```sh
bin/pipeline guides --json
bin/pipeline guides --catalog seedance --model seedance-2.0 --input-mode image-to-video --json
```

結果には常に次が含まれます。

- `scope: prompt-guidance-only`
- `execution_capability: not-evaluated`
- モデル一致状態、T2V / I2Vテンプレート、チェックリスト、避ける事項
- 尺、解像度、アスペクト比、prompt上限などのモデル別limits
- negative promptの扱い
- 公式出典、確認日、再確認期限、鮮度

## project.yaml から使う

既存 adapter と異なるモデル知識を使う場合だけ `prompt_guide.catalog` を明示します。`input_mode` は推測させず、requestごとに指定します。

```yaml
generation:
  adapter: topview
  requests:
    - id: shot-001
      prompt: A subject turns toward a sunlit window as the camera slowly pushes in.
      model: seedance-2.0
      duration: 5
      aspect: "16:9"
      input_mode: text-to-video
      prompt_guide:
        catalog: seedance
      params: {}
```

`plan` と `run --dry-run` は各requestの `prompt_guidance` を返します。

- `matched`: モデルと入力モードに対応するrecipeあり
- `catalog-missing`: 明示したカタログが見つからない
- `model-unmatched`: 別モデルのrecipeを誤適用しない安全停止
- `input-mode-unset`: T2V / I2Vが未指定
- `input-mode-unsupported`: カタログ上、そのモデルが入力モード非対応

これらはGate 1前の助言です。coreはpromptを書き換えず、`run` / `render` の承認条件も変更しません。

## 更新ルール

モデル更新時は公式資料のみを根拠にし、該当YAMLの `revision`、`verified_at`、`review_after`、`sources`、ruleの `source_ids` を一緒に更新します。公式仕様と選択adapterの実装制約が異なる場合は、実行時には `constraints.yaml` と実CLI/APIを優先し、その差をmodel noteへ残します。
