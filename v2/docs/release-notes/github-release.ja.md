# GitHub Release 本文の下書き（日本語）

タグ `v2.0.0-alpha.6` の日本語側です。公開用に日英を一つにした本文は [github-release-body.md](github-release-body.md)。この PR はタグを打たず、Release も npm も公開しません。英語の下書きは [github-release.md](github-release.md)。`v2/package.json` は `2.0.0-alpha.6` です。

直前の公開版は [v2.0.0-alpha.5](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5) です。新しい動画は v2 から始めます。既存の `project.yaml` 案件は v1 `0.18.0` の保守として残します。正式版 2.0.0 ではありません。

## 入ったもの

### #241 — PixVerse の image-to-video と transition、ElevenLabs の音声設定、静止画

PixVerse V6 の image-to-video と first/last-frame transition、`make.inputs` で計画に束縛するローカル静止画、ElevenLabs の音声モデルと `voice_settings` を、合成 HTTP で確認した。PNG / JPEG / WebP は、秒数を明示したとき local と Remotion のタイムラインで保持する。PixVerse の実呼び出しはしていない。

### #242 — PixVerse の extend / upscale / modify / 画像 Fusion と、ElevenLabs の music / SFX

それらの PixVerse の mode と、ElevenLabs の `mode: music` / `mode: sfx` を、合成 HTTP で確認した。見積もりは明示のまま。実呼び出しはしていない。

### #243 — ElevenLabs の `credits: null`

実課金の効果音 1 本（2秒）が、数値のクレジットを返さなかった。明示 `credits: null` は、受け取ったファイルを成功にし、予約は確認ページで精算するまで維持する。`credits` の欠落は、これまでどおり契約違反。この 1 件が、SFX の実課金受け入れ。音声と music の実課金受け入れは未了。

### #245 と #246 — 物語と構成の相談、カタログの同梱

[#245](https://github.com/Takamasa045/tsugite/pull/245) は、素材の前に構成だけ相談できるようにする。相談は生成も外部送信も課金も承認もしない。採用した構成を結ぶと計画のハッシュが変わり、古い承認では先へ進めない。素材は自動では作り直さない。[#246](https://github.com/Takamasa045/tsugite/pull/246) は、同じバイトのカタログと出典を v2 の配布物へ同梱する。`plugin story consult` は git の作業ツリーでも npm のパッケージでも動き、読むのはパッケージ内の `knowledge/story-frameworks/catalog.yaml` だけである。親ディレクトリは探さない。カタログはデータであり、その型を生成できるという意味ではない。

```sh
npm run --silent v2 -- plugin story consult --request "60秒の静かな自然映像。ドラマ・CTA不要" --seconds 60
```

採用した JSON は `plugin story check` のあと `plugin story bind` で結び、続けて `plan` する。

### #248 — PixVerse、Kling、TopView のサブスク CLI

[#248](https://github.com/Takamasa045/tsugite/pull/248) は、PixVerse・Kling・TopView を API キーではなく各社 CLI のログイン状態でつなぐ。PixVerse の既定は CLI で、`base_url` と `credential_env` を書いた HTTP は任意で残る。Kling に CLI 経路を足し、TopView は公式 skill の `video_gen.py` と `auth.py status` だけの labs プラグインである。テストは偽物の CLI だけである。実生成も課金もしていない。**サブスク CLI での実機確認は未了**である。各 CLI にサブスクリプションでログインした状態での実生成と、その生成から最終ファイルまでの通し書き出しは、このリリースではしていない。Tsugite 独自のログインコマンドは足さない。Kling と TopView は、PixVerse の実機確認の代わりにはしない。

## PixVerse、Kling、TopView のつなぎ方

各サービスの CLI で、そのサブスクリプションにログインした状態で使う。経路はこのパッケージにあり、テストは偽物の CLI だけである。API キーを案件の設定に書いてつなぐ方式にはしない。このリリースはログイン先も課金先も選ばず、Tsugite 独自のログインコマンドも足さない。サブスク CLI での実機確認は未了。

オフライン見本（`init`、`check`、`plan`、`make`、`export`）は、これらの CLI を呼ばない。

## 正式版 2.0.0 はこの alpha ではない

判定は [migration-plan.ja.md](../migration-plan.ja.md)。

- ElevenLabs SFX の実課金受け入れ: 済（上の 2 秒・1 本）。
- ElevenLabs の音声と music の実課金受け入れ: 未了。
- PixVerse の API キーでの有料受け入れ: 条件から外した。
- PixVerse のサブスク CLI での実機確認: 未了。CLI にサブスクリプションでログインした状態で、実生成と、その生成から最終ファイルまでの通し書き出しを確認する。
- Kling と TopView も同じ CLI ログイン方針で、経路はある。実機確認は未了で、PixVerse の確認の代わりにはしない。
- 作者以外 3 人の初回試用と、新しい制作の既定を v2 にする所有者の明示承認は、まだ。

対応する v1 案件は `init <directory> --from-v1 <v1-directory>` で写す。`--flatten` は完成動画の 1 本。`--archive-v1` は範囲を限った保管。承認と秘密情報は写さない。案件専用の Remotion 構成とキャラクターの編集グラフは v1 に残す。
