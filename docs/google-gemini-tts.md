# Google Gemini TTS と音声参照動画

Tsugiteの`google-gemini-tts`接続はGoogle AI StudioのGemini APIキーを使い、Gemini TTSの会話または単独ナレーションをWAVで生成する。Google Cloud Text-to-Speechの認証・課金経路とは別。実装は`adapters/google-gemini-tts/`にあり、固定のGemini Interactions APIへ送る。接続情報・モデル・課金経路を混ぜない。

## 入力

- 対応モデル: `gemini-3.8-flash-tts`、`gemini-3.8-flash-lite-tts`。`models`コマンドのローカル事前検証はパラメータ形だけを確認し、Google側の権限や残高までは確認しない。
- 単独の声: `operation: voice`、`prompt: 読ませる本文`、`params.voice_id: Kore`。任意の`params.style`は読み方の短い指定。
- 2人の会話: `params.speakers`に2人の`speaker`とGoogleのプリセット`voice`を設定する。`prompt`は`A: 本文`のように1行1発話。`params.turn_styles`を使う場合は各行と同数にする。Geminiには各発話を別の`speech_metadata`付きテキストとして送り、`conversational`モードを使う。
- 台本生成は別の準備工程。`adapters/google-gemini-tts/dialogue.mjs generate`が`gemini-3.8-flash`で2人の台本下書きJSONを作る。`--submit`なしでは入力検査だけを行う。下書きを確認・修正して`apply`すると、TTS案件の台詞・演技指定・仮字幕が更新される。TTSアダプターは会話文を自動生成・改変しない。

## 実行境界

APIキーは実行環境の`GEMINI_API_KEY`だけから読む。`project.yaml`、manifest、ログに値を置かない。生成の前に接続、モデル、料金、予算を確認し、通常の`validate` → `plan` → `review` → Gate 1承認を経る。アダプターの送信は1回だけで、結果不明時に自動再送しない。返却WAVをrun内へ固定し、同じ依頼の再実行では既存成果物を再利用する。Google側の使用料金はTsugiteのcredits数では計算できない。

macOSではキーをチャットやrepoへ書かず、AI Studioからクリップボードにコピーした直後に`node scripts/gemini-keychain.mjs save-from-clipboard`でログインKeychainへ保存できる。保存後はクリップボードを消去する。`node scripts/gemini-keychain.mjs status`は存在だけを返す。`run-dialogue`または`run-pipeline`に続けて通常の引数を渡すと、その子プロセスにだけKeychainの値を`GEMINI_API_KEY`として渡す。例: `node scripts/gemini-keychain.mjs run-pipeline connections --model gemini-3.8-flash-tts --capability audio.text-to-speech --json`。通常の`node bin/pipeline`にはKeychain値を自動注入しない。

## MiniMax H3で動画化

[`templates/google-dialogue-h3/`](../templates/google-dialogue-h3/)に2案件の雛形がある。採用したWAVを動画案件内へコピーし、`generation.requests[].input_audios`に指定する。PixVerseの`create reference`は`minimax-h3`で音声参照を受け取り、画像または動画参照と併用する。`manifest.audio.narration`に同じWAVを指定すると、最終版では原台詞を音声トラックとして扱える。音声リファレンスは映像生成の条件付けであり、正確な台詞・口パクを保証しない。生成後に聞き比べと口の動きの確認を行う。

Google APIとPixVerseは別の課金先なので、各案件のGate 1で個別に確認・承認する。H3の1カットは現在のPixVerse経路で3/5/10秒、音声参照は最大3件、音声のみ参照は不可。長い会話は採用音声を区間に分け、カットごとに人物・声・場所の一貫性を設計する。モデルの実利用権限はPixVerse CLI側で生成前に確認する。

公式資料: [Gemini TTS](https://ai.google.dev/gemini-api/docs/speech-generation)、[Gemini APIキー](https://ai.google.dev/gemini-api/docs/api-key)、[Interactions API](https://ai.google.dev/api/interactions-api)。
