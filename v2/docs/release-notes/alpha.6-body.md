継手 / Tsugite **v2.0.0-alpha.6** は、公開済み [v2.0.0-alpha.5](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5) のあとに入った alpha です。正式版 2.0.0 ではありません。npm レジストリには公開しません。既存の `project.yaml` 案件は v1 `0.18.0` のままです。新しい動画は v2 から始めます。

導入は添付の `tsugite-2.0.0-alpha.6.tgz` と `SHA256SUMS` を照合してからにしてください。この Release は動画も画像も追加しません。

## 日本語

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

オフライン見本（`init`、`check`、`plan`、`make`、`export`）は、これらの CLI を呼ばない。

### 正式版 2.0.0 はこの alpha ではない

判定は [移行判断](https://github.com/Takamasa045/tsugite/blob/v2.0.0-alpha.6/v2/docs/migration-plan.ja.md)。

- ElevenLabs SFX の実課金受け入れ: 済（上の 2 秒・1 本）。
- ElevenLabs の音声と music の実課金受け入れ: 未了。
- PixVerse の API キーでの有料受け入れ: 条件から外した。
- PixVerse のサブスク CLI での実機確認: 未了。CLI にサブスクリプションでログインした状態で、実生成と、その生成から最終ファイルまでの通し書き出しを確認する。
- Kling と TopView も同じ CLI ログイン方針で、経路はある。実機確認は未了で、PixVerse の確認の代わりにはしない。
- 作者以外 3 人の初回試用と、新しい制作の既定を v2 にする所有者の明示承認は、まだ。

対応する v1 案件は `init <directory> --from-v1 <v1-directory>` で写す。`--flatten` は完成動画の 1 本。`--archive-v1` は範囲を限った保管。承認と秘密情報は写さない。案件専用の Remotion 構成とキャラクターの編集グラフは v1 に残す。

## English

Tsugite **v2.0.0-alpha.6** is the alpha after the published [v2.0.0-alpha.5](https://github.com/Takamasa045/tsugite/releases/tag/v2.0.0-alpha.5). It is not formal 2.0.0. It is not published to the npm registry. Existing `project.yaml` productions stay on v1 `0.18.0`. New videos start on v2.

Install from the attached `tsugite-2.0.0-alpha.6.tgz` and `SHA256SUMS` after the checksum matches. This Release adds no video or image.

### #241 — PixVerse image-to-video and transition, ElevenLabs voice settings, stills

Synthetic HTTP coverage for PixVerse V6 image-to-video and first/last-frame transition, local stills bound with `make.inputs`, and ElevenLabs speech model and `voice_settings` checks. PNG, JPEG, and WebP holds share the local and Remotion timeline when `seconds` is explicit. No live PixVerse call was made.

### #242 — PixVerse extend, upscale, modify, image Fusion, and ElevenLabs music and SFX

Synthetic HTTP coverage for those PixVerse modes and for ElevenLabs `mode: music` and `mode: sfx`. Quotes stay explicit. No live call was made.

### #243 — ElevenLabs `credits: null`

One billed 2-second sound effect returned no numeric credit amount. An explicit `credits: null` now marks the received file successful and keeps the reservation until the confirmation page settles it. A missing `credits` field is still a contract failure. That one SFX request is the recorded paid acceptance. Speech and music paid acceptance are open.

### #245 and #246 — story conversation, and the catalog in the package

[#245](https://github.com/Takamasa045/tsugite/pull/245) lets a project start from a structure conversation before footage. The conversation does not generate, send data out, spend credits, or approve. Attaching the chosen structure changes the plan hash, so an old approval cannot continue. Footage is not rebuilt automatically. [#246](https://github.com/Takamasa045/tsugite/pull/246) ships the same catalog bytes and the source notice inside the v2 package. `plugin story consult` works from a git checkout and from the npm package. It reads only `knowledge/story-frameworks/catalog.yaml` in that package. It does not search a parent directory. The catalog is data, not a promise that those forms can be generated.

```sh
npm run --silent v2 -- plugin story consult --request "60秒の静かな自然映像。ドラマ・CTA不要" --seconds 60
```

After you keep a JSON plan, run `plugin story check` and then `plugin story bind`, then `plan`.

### #248 — PixVerse, Kling, and TopView subscription CLIs

[#248](https://github.com/Takamasa045/tsugite/pull/248) connects PixVerse, Kling, and TopView through each service's CLI while that subscription is already logged in, not through an API key in settings. PixVerse defaults to the CLI. HTTP with `base_url` and `credential_env` stays optional. Kling gains a CLI path. TopView is a labs plugin that calls only the official skill `video_gen.py` and `auth.py status`. Tests replace the CLI with a fake. No real generation and no charge were made. **The subscription-CLI real-machine check is not done.** A real generation and a full export of that generation, while each CLI is logged in, are not part of this release. This release adds no Tsugite login command. Kling and TopView do not replace the PixVerse check.

The offline sample (`init`, `check`, `plan`, `make`, `export`) does not call those CLIs.

### Formal 2.0.0 is not this alpha

Judgment, in the [migration plan](https://github.com/Takamasa045/tsugite/blob/v2.0.0-alpha.6/v2/docs/migration-plan.md).

- ElevenLabs SFX paid acceptance: done (the 2-second request above).
- ElevenLabs speech and music paid acceptance: open.
- PixVerse API-key paid acceptance: removed from the criteria.
- PixVerse real-machine check on the subscription CLI: open. That check is a real generation and a full export of that generation while the CLI is logged in with the subscription.
- Kling and TopView follow the same CLI-login policy. The path is in this package. Their real-machine checks are open and do not replace the PixVerse check.
- Three non-author first trials, and an explicit owner approval to make v2 the default, are still open.

Copy a supported v1 production with `init <directory> --from-v1 <v1-directory>`. `--flatten` copies one finished video. `--archive-v1` keeps a bounded archive. Approvals and secrets are not copied. Production-specific Remotion and character graphs stay on v1.
