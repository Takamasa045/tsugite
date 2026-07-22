# Local analysis example

APIキーや外部サービスを使わず、ローカルのFFmpegだけで動画の無音区間を解析する配布サンプルです。

```sh
cp -R examples/local-analysis projects/my-seminar
node bin/pipeline doctor --config projects/my-seminar/project.yaml --json
node bin/pipeline validate --config projects/my-seminar/project.yaml --json
node bin/pipeline plan --config projects/my-seminar/project.yaml --json
node bin/pipeline analyze --config projects/my-seminar/project.yaml --actor coordinator --json
```

実案件では `media/sample-seminar.mp4` を手持ち動画に置き換え、`manifest.json` の尺・解像度・fpsを合わせてください。

解析結果は `dist/<run-id>/analysis/raw-analysis.json`、Codex／Claude Code向けのローカル作業指示は `agent-handoff.md` に出力されます。解析は元動画、manifest、Gate stateを変更しません。`edit.backend` は `remotion` または `hyperframes` を選べます。

現行MVPは無音カット候補の抽出までです。文字起こし、要約、フィラーワード判定、承認済みEDLへの変換は、今後のローカルSTT・editorial proposal段階で追加します。
