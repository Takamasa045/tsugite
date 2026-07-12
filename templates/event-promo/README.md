# Event Promo Starter

短尺のイベント告知動画を、案件固有の素材をGitへ混ぜずに制作・振り返りするための雛形です。

```bash
cp -R templates/event-promo projects/my-event-promo
```

`projects/*` はGit管理外です。コピー後のフォルダに画像、音声、manifest、レンダー結果、QA reportを置いてください。このtemplate側には生成済み素材を追加しません。

## 制作ループ

1. `brief.md` に目的、視聴者、CTA、公開情報を書く。
2. `story-guides` を実行し、第一候補・補助候補・不採用理由を記録する。
3. `shotlist.md` で6〜8カットを設計する。各カットは被写体、距離、角度、場所のいずれかを変える。
4. TTSは最初の1クリップだけ生成し、固有名詞、読み、style tag混入、重複を確認してから一括生成する。
5. 横型と縦型は別レイアウトとして設計する。中央cropを既定にしない。
6. `validate`、`plan`、`run --dry-run` を通し、明示承認後にだけ実行する。
7. contact sheet、黒画面、無音、尺、音量、CTAの読める時間を確認する。
8. `completion-notes.md` を埋める。案件固有メモはそのまま残し、再利用できる知見だけを本体へ昇格する。

## 配布境界

- 案件固有: `projects/<job>/` の画像、音声、MP4、manifest、QA report、制作メモ
- 再利用可能: template、検証、fixture、運用ルール、ルート`LESSONS.md`
- `examples/`へ昇格できるのは、小さく自己完結し、コピー後すぐ検証でき、特定イベントの成果物ではないfixtureだけ
