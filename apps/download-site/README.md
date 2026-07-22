# Tsugite download site

Tsugite Desktop の紹介と、macOS / Windows 向けベータ版の配布導線を担うランディングページです。

```sh
npm ci
npm run dev
npm run build
npm test
npm run lint
npm run security:audit
```

`security:audit` はproduction依存と開発依存の両方を検査し、moderate以上の既知脆弱性があれば失敗します。Next、Cloudflare、ESLint系の上流が安全版へ追従するまでは、検証済みの推移依存を`overrides`で固定します。

CTAは GitHub prerelease `v0.6.0-beta.1` の固定asset URLを参照します。リリースを公開する際は、LPが参照するファイル名と`SHA256SUMS.txt`をリリースassetおよびリリースノートと一致させてください。

macOS版はアプリ全体をアドホック署名して配布しますが、Developer ID署名とnotarizationは未実施です。Windows版はコード署名なしで配布します。LPではOSの保護機能を恒久的に無効化せず、公式ReleaseとSHA-256を確認する手順を案内します。

## Desktopとエージェントの説明契約

- 推奨導線は、Codex／Claude Codeを制作の入口、Desktopを案件・Viewer・承認の確認画面として同じrepo rootで使うハイブリッド構成。
- 生成ランチャー／生成ノードは本ベータ版に含まれないため、実際の企画・生成・編集依頼はTsugiteリポジトリを開いたCodex／Claude Codeから行う。
- 物語構成、映像文法、モデル別prompt knowledgeはリポジトリ側の設計支援であり、Desktopベータの実行機能や生成接続とは分けて説明する。
- 学び昇格自動化は候補を承認待ちにするだけで、通知はCodex／Claudeのhost標準機能、共有sourceへの反映は人の承認後の別作業。
