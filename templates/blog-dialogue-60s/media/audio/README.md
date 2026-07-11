# Audio slots

このテンプレートは音声・BGM未提供のため、初期状態は字幕付き無音ドラフトです。

- 会話音声: 1セリフ1ファイル、48kHz mono WAV推奨。IDは `s01`〜`s10` と合わせる。
- 柴犬: 明るく少し高め。
- イトパン: 温かく落ち着いた声。
- BGM: 軽いテック感＋アコースティック、約94 BPM。会話より12〜18dB下げる。
- TTS生成後はSTTで読みを確認し、`tts_text` と字幕の意味が一致しているか確認する。

音声を追加したら `video.json` の `audio.narration` / `audio.bgm` を更新し、`build-manifest.mjs` を再実行する。
