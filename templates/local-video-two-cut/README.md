# ローカル動画 2カット

外部接続、課金、生成、Gate更新を使わずに、Tsugiteの最小編集フローを確認するための開始テンプレートです。実行可能な正本は、同梱の検証済みサンプル `examples/local-fixture/` です。

## 始め方

リポジトリrootで、サンプルを自分の案件としてコピーします。

```sh
cp -R examples/local-fixture projects/my-two-cut
```

続けて `projects/my-two-cut/project.yaml` の `slug` と `run_id` を案件名に変え、`manifest.json` の2本の `clips[].src` を自分のローカル動画へ更新します。まずは同じ16:9・同程度の尺で置き換えると、構成を変えずに確認できます。

```sh
bin/pipeline validate --config projects/my-two-cut/project.yaml --json
bin/pipeline plan --config projects/my-two-cut/project.yaml --json
bin/pipeline run --config projects/my-two-cut/project.yaml --dry-run --json
```

この3コマンドは読み取り専用です。`run` と `render`、Gate判断は含めず、外部送信やクレジット消費は発生しません。

## 変更する場合

- カット数や尺を変えるときは、`manifest.json` の `meta.target_duration_seconds` と各clipの `in` / `out` / `duration` を揃えてから `validate` をやり直します。
- 音声、生成素材、キャプションを追加する場合は、この開始テンプレートの範囲外です。接続とGateの選択を明示して別途計画してください。
- 配布物にはテスト用の小さなローカル動画だけを使います。ユーザーの素材、成果物、認証情報をテンプレートへ追加しません。
