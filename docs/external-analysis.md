# 任意の外部解析adapter

Tsugiteの解析は `analysis.mode: local` が既定です。既存project.yamlは変更不要で、外部送信、API key、課金は発生しません。精度補完が必要なprojectだけ、provider固有処理をadapter配下へ閉じ込めて `hybrid` または `cloud` を選べます。

## モード

| mode | 外部adapterへ渡せる入力 | 用途 |
|---|---|---|
| `local` | なし | 配布時の標準。FFmpeg／ローカルWhisperのみ |
| `hybrid` | confidenceが閾値未満のtranscript segmentだけ | 認識の怪しい箇所だけ文章補正 |
| `cloud` | 選択したclipのsource media。明示adapterでは依存解析JSONも含められる | 外部ASR、意味要約、多言語翻訳など |

`hybrid`では元動画path、全transcript、依存adapterの全出力をonline adapterのstdinへ渡しません。online adapterは選択segmentの修正だけを返し、coreが高信頼segmentと決定的に再結合します。confidenceが閾値未満のsegmentが0件ならcredentialを要求せずonline adapterも起動せず、ローカルtranscriptをそのまま引き継ぎます。

## project.yaml

```yaml
analysis:
  mode: hybrid
  adapter: local-whisper-analysis
  confidence_threshold: 0.7
  requests:
    - id: transcript-local
      output: transcript
      source_clip_id: seminar
      params:
        model_path: /absolute/path/to/local-model.pt
        model_sha256: <sha256>
    - id: transcript-refined
      adapter: my-external-analysis
      output: transcript
      source_clip_id: seminar
      depends_on: [transcript-local]
```

online CLI adapterは送信境界とcredential名を宣言します。provider名、endpoint、SDK、response変換はcoreへ入れず、各adapter内に置きます。

```yaml
name: my-external-analysis
kind: cli
class: analysis
offline: false
outputs: [transcript]
network:
  input_scope: low-confidence-segments # cloudはsource-mediaも選択可能
  credential_env: [MY_ANALYSIS_API_KEY]
  timeout_ms: 900000
command:
  executable: node
  args: [adapters/my-external-analysis/analyze.mjs]
  input: stdin-json
```

`credential_env`は大文字の環境変数名だけを最大16件宣言できます。値はproject.yamlへ書かず、実行環境へ設定します。coreは通常のprocess環境を丸ごと渡さず、安全な基本環境とここで列挙した変数だけを子プロセスへ渡します。`NODE_OPTIONS`、`LD_PRELOAD`等のruntime注入変数は宣言できません。adapterがcredential値をstdout JSONへ含めた場合、成果物へ保存せず実行を失敗させます。online adapterは既定15分、最大60分の `timeout_ms`、最大2回のretryで停止します。

online wrapperのstdinは通常の `request` / `run_id` / `run_dir` / `source` に `external_input` を加えたJSONです。`hybrid`の `external_input.segments` には選択segmentだけが入り、wrapperは同じIDとsource timestampを持つ修正版だけを返します。`cloud`の `source.path` は選択clipのローカルpathです。翻訳字幕などで既存transcriptも必要なadapterは `source-media-and-dependencies` を宣言した場合だけ `inputs` を受け取れます。stdoutは通常のanalysis schemaに従い、`metadata.api_used`、`metadata.network_used`、`metadata.actual_credits`を実績値で返します。

## 確認と実行

```sh
bin/pipeline validate --config projects/my-seminar/project.yaml --json
bin/pipeline plan --config projects/my-seminar/project.yaml --json
bin/pipeline doctor --config projects/my-seminar/project.yaml --json
bin/pipeline analyze --config projects/my-seminar/project.yaml \
  --actor coordinator --allow-external-analysis --json
```

- `plan.analysis.transfers` はrequest、adapter、送信scope、timeout、必要な環境変数名を表示します。値は表示しません。`max_estimated_credits` はhybridでも全対象を処理すると仮定した上限寄りの事前値です。
- `doctor` はcredentialの有無だけを検査し、値を出力しません。
- online adapterを1つでも選ぶprojectは、Coordinatorに加えて毎回 `--allow-external-analysis` が必要です。
- 実行結果は `raw-analysis.json` の `mode`、`api_used`、`network_used`、`actual_credits`、`external_transfers` に記録します。transferには送信対象segment IDとdependency request IDも残します。
- 外部解析後も削除・字幕・章は提案のままです。Gate 1で確認されるまでEDLやmanifestへ反映しません。

## 信頼境界

Tsugiteはadapterへ渡すJSONと環境変数を最小化しますが、OS sandboxやnetwork namespaceは作りません。追加adapterはローカルで実行される信頼コードです。配布前に実装と依存関係をレビューし、送信先の利用規約、保存期間、学習利用、料金上限をadapterの `constraints.md` に記録してください。

特定providerのadapterは同梱していません。利用者が選んだCLI／APIを上記のstdin/stdout契約へ正規化することで追加できます。
