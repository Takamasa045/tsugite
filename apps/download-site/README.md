# Tsugite download site

Tsugite Desktop の紹介と、macOS / Windows 向けベータ版の配布導線を担うランディングページです。

```sh
npm ci
npm run dev
npm run build
```

CTAは GitHub prerelease `v0.6.0-beta.1` の固定asset URLを参照します。リリースを公開する際は、LPに記載したファイル名とSHA-256をリリースassetおよびリリースノートと一致させてください。

本ベータ版はコード署名なしで配布します。macOS版はnotarizationも未実施です。LPではOSの保護機能を恒久的に無効化せず、公式ReleaseとSHA-256を確認する手順を案内します。
