# TopView CLI生成

TopView adapterは、TopView skill同梱の`video_gen.py`を呼ぶ実行可能なCLI adapterです。通常は`~/.agents/skills/topview-skill/scripts/video_gen.py`を検出し、必要な場合だけ`TSUGITE_TOPVIEW_VIDEO_COMMAND`へJSON配列形式のcommandを設定します。

## 単一画像から動画を生成する

```yaml
generation:
  adapter: topview
  requests:
    - id: opening-shot
      mode: image-to-video
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
bin/pipeline doctor --config <project.yaml> --json
bin/pipeline validate --config <project.yaml> --json
bin/pipeline plan --config <project.yaml> --json
bin/pipeline review --config <project.yaml> --json
bin/pipeline run --config <project.yaml> --dry-run --json
```

`run --dry-run`はadapterを起動せず、クレジット見積もりだけを返します。実生成はレビュー済みのGate 1をCoordinatorが承認した後だけ実行できます。生成済み動画は`dist/<run-id>/`へ取得され、assembled manifestの`clips`と`provenance`に記録されます。

現行契約は単一`first_frame`のi2vと既存t2vです。`end_frame`、複数参照画像、omniは未対応です。
