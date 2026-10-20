# Gemini会話音声 → PixVerse / MiniMax H3 参照動画

この雛形は台本生成、会話音声、参照動画の三段階です。`brief.json`からGeminiで2人の台本下書きを作り、内容を確認してTTS案件へ反映します。TTS案件で会話WAVを生成し、聴いて採用したWAVだけを次の案件へコピーします。次の案件はPixVerse CLIの`minimax-h3` `create reference`へ人物画像2枚とそのWAVを送ります。動画生成は別のGate 1承認とPixVerse課金確認を必要とします。両manifestの黒い仮クリップは動画パイプラインの入力契約を満たすためだけの素材で、完成映像ではありません。

1. `tts/`と`video/`をdurable `projects/`（または`TSUGITE_PROJECTS_HOME`）内の別案件としてコピーする。案件名・run IDは重複しない値に変更する。
2. `brief.json`のテーマ、目標尺、A/Bの人物像を編集する。`node adapters/google-gemini-tts/dialogue.mjs generate <brief.json> <draft.json>`で入力検査を行う。Google側の利用権限、料金、予算を確認した後、`--submit`を付けて台本を1回生成する。出力された`draft.json`の台詞と演技指定を確認・修正してから、`node adapters/google-gemini-tts/dialogue.mjs apply <draft.json> <tts/project.yaml>`でTTS案件へ反映する。applyはmanifestの仮字幕も更新する。TTSは入力した本文を改変せず読み上げる。声は`tts/project.yaml`の`speakers`で選ぶ。
3. Google AI StudioのGemini APIキーを実行環境の`GEMINI_API_KEY`に設定する。キーをYAMLやチャットに書かない。モデルの利用権限、料金、予算を確認し、`validate` → `plan` → `review`でWAVの生成内容を確認してGate 1を判断する。
4. Coordinatorが承認後に`run`を実行する。`dist/<run-id>/assets/audio/narration/`内のWAVを試聴し、Gate 2で採用または修正を判断する。`credits: 0`はGoogle料金0円を意味しない。
5. 採用したWAVを`video/media/dialogue.wav`へコピーし、2人の参照画像を`video/media/speaker-a.png`と`speaker-b.png`へ置く。実際の音声長を測り、10秒のH3上限に合わせて台詞・映像の区間を設計する。長い会話は複数カットに分ける。
6. `video/project.yaml`と`video/manifest.json`で、`input_audios`は生成モデルへの参照、`audio.narration`は最終版で使う原音声を示す。`story-guides`、Identity Lock、`validate` → `plan` → `review`とGate 1を経てからPixVerseで生成する。最後に音声と口の動き、話者の対応を人が確認する。

H3の音声参照は画像または動画参照と併用する。音声参照だけで台詞の完全一致やリップシンクは保証されないため、採用したWAVを最終音声トラックとして残す。声、外見、仕草、場所の固定は制作SkillのIdentity Lock Protocolに従う。この雛形はメディア未配置のため、コピーと入力後に検証する。

詳細: [`docs/google-gemini-tts.md`](../../docs/google-gemini-tts.md)
