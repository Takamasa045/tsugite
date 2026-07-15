# APIを使わないローカル長尺解析

`pipeline analyze` は、外部API、APIキー、課金、ネットワーク通信を必須にせず、手持ち動画からレビュー用の解析成果物を作ります。標準の `local-media-analysis` adapter は、Tsugiteですでに必須のFFmpegだけを使用します。

## 責務分担

```text
元動画
  -> local-media-analysis（source timestamp、無音候補）
  -> local-whisper-analysis（文字起こし、フィラー候補、章、抽出的要約、英訳字幕）
  -> Codex / Claude Code（任意の意味レビューと提案改善）
  -> project.yamlの明示的な編集方針
  -> Gate 1（適用予定のカット・字幕・尺を人間承認）
  -> editorial-edl.json + 編集済み共通manifest
  -> Remotion または HyperFrames
```

- FFmpegは機械的な時刻検出を担当します。
- Codex／Claude CodeはローカルJSONを読み、意味的な編集案を作る任意レイヤーです。
- Tsugite coreから外部AIサービスを直接呼びません。
- `source_start` / `source_end` は常に元動画上の時刻です。
- `action: review` は削除命令ではありません。`edit.editorial`で選択され、現在の解析digestを含むGate 1レビューが承認された候補だけをmanifestへ反映します。

## 実行

```sh
cp -R examples/local-analysis projects/my-seminar
bin/pipeline doctor --config projects/my-seminar/project.yaml --json
bin/pipeline validate --config projects/my-seminar/project.yaml --json
bin/pipeline plan --config projects/my-seminar/project.yaml --json
bin/pipeline analyze --config projects/my-seminar/project.yaml --actor coordinator --json
```

成果物:

- `dist/<run-id>/analysis/raw-analysis.json`
- `dist/<run-id>/analysis/editorial-proposal.json`
- `dist/<run-id>/analysis/agent-handoff.md`

`analyze` は元素材・manifest・Gate stateを変更しません。入力ファイルのSHA-256を成果物へ保持し、解析対象を識別します。adapterプロセスへは `PATH` / `HOME` / temp / locale系の最小環境変数だけを渡し、APIキー、token、proxy設定は引き継ぎません。FFmpegの入力protocolもローカルの `file` / `pipe` に限定するため、ローカルplaylistからネットワーク素材を取得しません。

`local` modeのCLI analysis adapterは `offline: true` を明示し、対応する `outputs` を宣言します。ただし、Tsugite自体はOSレベルのnetwork namespaceを作りません。同梱のlocal-media-analysisはnetwork clientとprovider credential参照を持たないことをテストしていますが、独自adapterを追加する場合はコードレビューが必要です。

任意の外部解析で精度を補完する場合も、既定のローカル契約は変わりません。低信頼区間だけを送る `hybrid`、選択した素材全体を送る `cloud`、実行時許可とcredential境界は [external-analysis.md](external-analysis.md) を参照してください。

## backendの選択

解析成果物はbackend非依存です。最終レンダーだけ `project.yaml` で選びます。

```yaml
edit:
  backend: remotion # または hyperframes
```

## ローカルWhisperによるPhase 2

`examples/local-analysis/project-editorial.yaml` は、無音検出とローカルWhisperを1つのprojectで使う例です。`model_path` と `model_sha256` を手元の既存モデルへ変更してから実行します。

```sh
bin/pipeline doctor --config examples/local-analysis/project-editorial.yaml --json
bin/pipeline validate --config examples/local-analysis/project-editorial.yaml --json
bin/pipeline analyze --config examples/local-analysis/project-editorial.yaml --actor coordinator --json
bin/pipeline review --config examples/local-analysis/project-editorial.yaml --open --json
```

- `doctor` は選択されたWhisper CLIとFFmpegを検査します。
- `analyze` は `model_path` が既存のregular `.pt` ファイルでなければ停止し、モデル名や自動downloadを許可しません。
- `model_sha256` は必須です。PyTorch `.pt` は実行可能なデシリアライズ入力になり得るため、信頼できる配布元のモデルだけを使い、実ファイルのSHA-256が一致しない限り停止します。
- 元動画はFFmpegで `file` / `pipe` protocolだけを許可した一時WAVへ変換してからWhisperへ渡します。
- 無音区間の幻覚字幕は `no_speech_prob` で除外します。
- 翻訳字幕はWhisperがローカル対応する英語のみです。他言語翻訳は別の任意adapterとして追加します。
- フィラー候補は常に `action: review` で、自動削除されません。
- 章と要約はtranscriptから決定的に生成する抽出型です。生成AIによる意味要約ではありません。

### 承認済み候補をEDLへ反映する

`project.yaml` の `edit.editorial` が、実際に適用する編集判断です。例ではフィラーだけを削除し、無音候補は保持します。

```yaml
edit:
  backend: remotion # または hyperframes
  editorial:
    remove_kinds: [filler]
    remove_ids: []
    exclude_ids: []
    captions:
      request_id: subtitles-en
    chapters:
      request_id: chapters-ja
```

- `remove_kinds`: 該当種類を一括して適用します。
- `remove_ids`: 個別候補を追加選択します。
- `exclude_ids`: 種類で選ばれた誤検出を保持します。`remove_ids`との重複は拒否します。
- `captions.request_id`: transcriptまたはsubtitle_trackのrequest IDを選びます。
- `chapters.request_id`: chaptersのrequest IDを選びます。

レビューHTMLには候補ごとに「適用予定」または「保持」、短縮時間、出力尺、字幕・章の件数が表示されます。確認後、CoordinatorがGate 1を承認して `run` すると次を生成します。

- `dist/<run-id>/editorial-edl.json`: 元動画と出力の時間対応、削除範囲、digest
- `dist/<run-id>/manifest.json`: EDLを反映したclip.in/out、出力時刻の字幕・章

同じ元素材を複数区間で使う場合も、run内へは1回だけコピーし、長尺素材のSHA-256もstreamingで1回だけ計算します。EDLの内容・digest・字幕／章を含むmanifest全体・動画／音声bytesの対応はGate 2で再検査し、承認digestをstateへ保存します。render直前にも同じ成果物を再検査するため、Gate 2後の変更やbackend差し替えは拒否します。元素材は変更しません。

analysis requestには個別の `adapter` と `depends_on` を指定できます。依存先が存在しない、循環する、別素材にまたがる場合はvalidate/analyzeが停止します。`local`では別adapterへの依存も停止し、`hybrid` / `cloud`で検証済みの外部解析経路だけadapterをまたげます。

Gate 1 reviewは `raw-analysis.json` と `editorial-proposal.json` のdigestを保持します。解析後に内容が変わると、古いGate 1承認では `run` できません。

## 現在の制限

次の機能はまだ自動化していません。

- 英語以外へのローカル翻訳（任意の外部adapterでは追加可能）
- ローカルでのabstractiveな意味要約（任意の外部adapterでは追加可能）
- 外部BGM・ナレーション・SFXを含む既存timelineの自動再配置（誤同期を避けるためEDL compileを停止します）
- generation requestと既存動画editorialの同時実行（現在はproject validationで停止します）

解析を実行しただけでは元動画は切られません。明示的な編集方針、Gate 1承認、Coordinatorによる `run`、Gate 2承認、Coordinatorによる `render` がそれぞれ必要です。
