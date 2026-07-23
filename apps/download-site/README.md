# Tsugite product site

Tsugite の機能と、GitHub + Codex / Claude Code を使うローカルワークフローを案内するランディングページです。

Desktopアプリの一般配布は終了しています。macOS / Windows向けインストーラーへはリンクせず、最新版のGitHub Releaseとリポジトリを入口にします。過去のベータ版資産は履歴として残しますが、サポート対象として案内しません。

```sh
npm ci
npm run dev
npm run build
npm test
npm run lint
npm run security:audit
```

`security:audit` はproduction依存と開発依存の両方を検査し、moderate以上の既知脆弱性があれば失敗します。Next、Cloudflare、ESLint系の上流が安全版へ追従するまでは、検証済みの推移依存を`overrides`で固定します。

CTAは正式版のGitHub Releaseとリポジトリだけを参照します。`releases/download`、DMG、EXEなどの直接ダウンロードURLを追加しないでください。

## エージェント中心の説明契約

- 推奨導線は、GitHubから最新版を取得し、Codex／Claude Codeを制作の入口、ブラウザで開くローカルViewerを確認画面として同じrepo rootで使う構成。
- 実際の企画・生成・編集依頼は、Tsugiteリポジトリを開いたCodex／Claude Codeから行う。
- 物語構成、映像文法、モデル別prompt knowledgeはリポジトリ側の設計支援であり、生成接続や利用枠とは分けて説明する。
- 学び昇格自動化は候補を承認待ちにするだけで、通知はCodex／Claudeのhost標準機能、共有sourceへの反映は人の承認後の別作業。
