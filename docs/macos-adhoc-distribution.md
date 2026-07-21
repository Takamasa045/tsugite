# macOS ad-hoc distribution

TsugiteのmacOS先行ベータ版をApple Developer Programなしで配布するときは、
アプリ全体をアドホック署名してからDMGを作成する。

この方法に費用はかからないが、Developer ID署名やAppleの公証ではない。
利用者は初回起動時に、アプリの入手元を確認したうえで
「システム設定」→「プライバシーとセキュリティ」→「このまま開く」を選ぶ必要がある。
警告なしの通常起動が必要な場合は、Developer ID署名と公証を使用する。

## パッケージ作成

macOS上で、検証済みの`.app`を入力にして実行する。

```sh
node scripts/package-macos-adhoc.mjs \
  --app /path/to/Tsugite.app \
  --output /path/to/Tsugite-0.6.0-macos-arm64.dmg
```

既存の出力を意図的に置き換える場合だけ`--overwrite`を追加する。
スクリプトは元の`.app`を変更せず、一時コピーに対して次を行う。

1. Electronアプリ全体をアドホック署名する。
2. `codesign --verify --deep --strict`で署名を検証する。
3. Applicationsへのショートカットを含むDMGを作成する。
4. `hdiutil verify`でDMGの整合性を検証する。

出力は完成先と同じディレクトリに一時作成し、すべての検証に合格した後だけ
完成名へ切り替える。`--overwrite`でも既存DMGを先に削除しない。

## 公開前の確認

```sh
npx vitest run test/desktop-macos-adhoc.test.mjs
hdiutil verify /path/to/Tsugite-0.6.0-macos-arm64.dmg
```

DMGをマウントし、アプリに対して次の検証が通ることも確認する。

```sh
codesign --verify --deep --strict --verbose=2 /Volumes/Tsugite/Tsugite.app
codesign -dv --verbose=4 /Volumes/Tsugite/Tsugite.app
```

表示される署名は`Signature=adhoc`、Team IDは`not set`であること。
`spctl`はDeveloper ID署名・公証がないため拒否する。これは無料配布方式の想定結果であり、
利用者向けの初回起動手順を省略してよいという意味ではない。

公開済みのGitHub Release資産は、修正版DMGのチェックサムと起動確認が完了し、
置き換えが明示承認された後にだけ更新する。
