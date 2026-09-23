# Tsugite

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [한국어](README.ko.md)

AI動画を作って終わりにせず、素材、制作ログ、判断、好みを次の制作へ継いでいくローカル動画制作工房です。

ソース版 **0.17.0**。Desktopアプリの一般配布は終了しています。日常の入口は GitHub のソースを Codex / Claude Code などで開き、確認には `127.0.0.1` のブラウザランチャーを使います。変更履歴は [CHANGELOG](CHANGELOG.md) です。

**まず見るところ:** [一番簡単な始め方](#一番簡単な始め方) · [できること](#できること) · [安全な制作フロー](#安全な制作フロー) · [コマンド](#コマンド)

## どんな問題を解決するか

生成サービス、ローカル素材、編集バックエンドを単一の **manifest** 契約で接続し、制作計画、承認、QA、ログを案件ごとに残します。Gitやターミナルに詳しくなくても、安全境界を確認しながらCodex、Claude Codeなどの対応コーディングエージェントへ初回準備を任せられます。

## できること

用途から入口を選んでください。任意ツールは Gate や `run` / `render` の代わりにはなりません。

### 安全な制作フロー

動画 job ごとに `project.yaml` を持ちます。コピー可能なサンプルは `examples/`、ユーザー作業用の `projects/` は git 管理外です。

1. project と manifest を検証する。
2. 実行計画を作成する。
3. **Gate 1** で人間の承認を待つ。
4. Coordinator 承認後にだけ生成または組み立てを実行する。
5. **Gate 2** で出力 QA を行う。
6. Gate 2 承認後にだけ render する。
7. **Gate 3** で最終動画 QA を行う。

`run` と `render` は Coordinator と事前の Gate 承認が必要です。明示的な人間承認なしに非 dry-run を実行しないでください。

### クリップを生成する

| 手段 | 役割 | 詳細 |
| --- | --- | --- |
| PixVerse / Kling CLI adapter | パイプライン経由の T2V / I2V | [Optional Adapters](docs/optional-adapters.md) |
| Prompt catalog | PixVerse / Kling / Seedance の出典付き助言。カタログの存在は実行能力ではなく、prompt も自動変更しない | [モデル別プロンプト知識](docs/prompt-guides.md) |
| Story guides | 34種の物語構成と、35種の映像文法・AI動画原則を理由付きで選ぶ | [王道の物語構成・映像文法](docs/story-guides.md) |
| TopView skill CLI | T2V と単一画像 I2V | [TopView CLI](docs/topview-cli.md) |
| H3 Prompt Director | MiniMax H3（`minimax-h3`）向け Creative IR → 決定的な英語プロンプト | [H3 Prompt Director](docs/h3-prompt-director.md) |

MiniMax direct / MiniMax HTTP は **preflight-only** のまま、送信可能としては表示しません。PixVerse / Kling などの provider CLI、認証、課金は自動導入しません。選んだ adapter だけを準備し、`doctor` を再実行してください。

### パイプライン内で編集する

`edit.backend` のレンダラーです。同じ manifest / EDL 契約を受け取ります。

| Backend | 役割 | 詳細 |
| --- | --- | --- |
| Remotion | 既定のローカル renderer。字幕、presentation preset | `edit.backend: remotion` |
| HyperFrames | ローカル renderer と公式 `media-use` の BGM / SFX | [HyperFrames音声](docs/hyperframes-audio.md) |
| Editframe | 任意の **macOS** ローカル renderer と preview。`npm run editframe:install` のあと `edit.backend: editframe`。preview は authoring copy。WebMCP と disk-save API は未検証 | [Editframe](docs/editframe.md) |
| Tesseract | 公式 CLI 0.2.0 を使う任意のローカル backend。ネイティブ文書/操作、6種のcanvas、24/30/60fps、720p/1080p/4K MP4、preview/filmstrip、macOS ProRes/alpha-solo出力に対応。0.2.0実機renderは未検証。Fast Edit は未対応 | [Tesseract](docs/tesseract.md) |
| **Jev Fast Edit v1** | Remotion / HyperFrames / Editframe で同じ backend 中立の編集意図（カード、字幕、トランジション、ズーム、SFX、16:9 と 9:16）。先に local-whisper の単語タイムスタンプが必要。選ぶのは `edit.backend` と `edit.fast_edit` だけ。新しい renderer ではない | [Fast Edit](docs/fast-edit.md) |

この経路には、Gate 拘束の editorial EDL（元素材を変えずにカット・字幕・章を再タイミングする）、画像素材と話者 / pose、presentation preset も含まれます。preset ID は手入力せず `node bin/pipeline presets --backend remotion --json` の一覧から選びます。

### パイプラインの外で編集する（Adobe など）

**エージェントが操作する外部エディタ**です。`pipeline render` の backend ではありません。Tsugite 案件としての Gate は維持します。

| ツール | Skill | いまできること | 詳細 |
| --- | --- | --- | --- |
| **Premiere Pro** | `$premiere-editing`（Claude Code: `/premiere-editing`） | macOS。カット、トランジション、音声、字幕、色。ローカル MCP と画面確認 | [Premiere Pro](docs/premiere-pro.md) |
| **After Effects** | `$after-effects-editing`（Claude Code: `/after-effects-editing`） | macOS。公式ローカル `DoScriptFile` helper で inspect / fixture / タイトル追加 / 別名保存。画面上の文字と再生は別確認 | [After Effects](docs/after-effects.md) |
| PixVerse Canvas | 公式 CLI 1.4.4（任意導入） | `npm run pixverse:install` のあと `npm run --silent pixverse -- canvas ...`。外部 Canvas 入口であり pipeline backend ではない。導入確認だけでは live な Canvas 変更を主張しない | [PixVerse Canvas](docs/pixverse-canvas.md) |
| HyperFrames Studio | 固定 0.8.24 の WebMCP | `npm run hyperframes:studio -- <composition-dir>` で authoring copy を開く。パッチ済み 0.8.24 + native Chrome 152 で inspect / 文字・色編集まで実測。motion や他ホストは未検証。Studio 編集は pipeline manifest を更新せず、後続の `render` が HTML を再生成する | [Studio WebMCP](docs/hyperframes-studio-webmcp.md) |

### 手元の映像を解析する

- APIキー不要の `pipeline analyze`（local-media-analysis。FFmpeg / `ffprobe` のみ）。
- 任意の local-whisper で文字起こし、フィラー候補、章、抽出的要約、英訳字幕。モデルの自動 download は行いません。
- `composition` がある案件では、`review` の前に `analyze` → `compose`。`compose` は最大3件の backend 中立提案を書き、選ぶ `edit.composition.proposal_id` は1つだけ。並べ替えた manifest は Gate 1 承認後の `run` だけが実体化します。

詳細は [APIを使わないローカル長尺解析](docs/local-analysis.md) と `examples/local-analysis/` です。

### 案件を確認する

ループバック専用ランチャーは `projects/*/project.yaml`、テンプレート、Gate、「好み・学び」、「安全な整理」を一覧します。開くだけでは AI CLI の導入、credits 消費、外部送信、生成、render、Gate 変更は行いません。

3D Viewer は現在の run の読み取り専用スナップショットです。詳細は [ローカルランチャー](#ローカルランチャーと3d-viewer) です。

### 任意の追加機能

| 追加 | 役割 | 詳細 |
| --- | --- | --- |
| Hypit 制作 | adapter 所有の authoring 経路（`npm run hypit:install`）。pipeline render backend ではなく、Gate 1 / 3 の代替でもない。live な `hypit build` / MP4 受け入れはソース bump では主張しない。Hypit runtime は Node.js 22.15以上（22.x）。本体の最低版は 22.12 | [Hypit](docs/hypit.md) |
| Editframe examples | 公式サンプル 27件の固定ギャラリー。`npm run editframe:examples:install` のあと `npm run editframe:examples` | [Editframe examples](docs/editframe-examples.md) |
| Agent Services | 公開 read-only Remote MCP 用の別 registry（`services` / `service-tools` / `service-call`）。生成 `connections` とは分離 | [Agent Services](docs/agent-services.md) |
| Shitate import | 別リポの SHA-256 lock 付きキャラ snapshot を取り込む。通常利用には不要 | [Shitate連携](docs/shitate.md) |
| キャラクター追加 | 任意の source manifest から speaker（pose / mouth / 画像）をコピー | [キャラクター追加](#キャラクター追加) |
| Hermes | 任意の analysis handoff adapter | [Optional Adapters](docs/optional-adapters.md) |

## 一番簡単な始め方

1. Codexで空の作業フォルダを開くか、そのフォルダでClaude Codeを起動します。ローカルファイルとシェルコマンドを扱えるほかのコーディングエージェントでも利用できます。
2. 下の短いセットアップ依頼文を、利用中のエージェントへ貼り付けます。
3. 環境確認とセットアップ結果を確認します。
4. 必要なシステム変更がある場合だけ、内容を確認して承認します。

`git clone`やnpmコマンドを自分で入力する必要はありません。

## Codex・Claude Codeなどへのセットアップ依頼文

```text
この空のフォルダ内に、公式のTsugite
https://github.com/Takamasa045/tsugite
を安全にセットアップしてください。
最初は読み取り専用で環境を確認し、不足ソフトのシステム導入前には私の承認を待ってください。
クローン後は公式のsetup:checkとsetupを使い、課金不要サンプルのdoctor、validate、planまで進めてください。
既存ファイルの上書き、ログイン、APIキー設定、課金、run、render、Gate承認、commit、pushは行わないでください。
```

安全条件をすべて含むコピー用全文は[Codex・Claude Codeなどで使う Tsugiteセットアップ依頼文](docs/onboarding/codex-setup-prompt.ja.md)です。

## セットアップ後にできること

- 「はじめての継手」サンプルをランチャーで確認する。
- ローカル素材だけで`validate`、`plan`、`review`を試す。
- 自分の動画案件を`projects/`に作る。
- 必要なProviderだけを後から選び、認証・課金を別途確認する。

## 安全上の注意

公式Bootstrapはリポジトリ内の依存導入、課金不要サンプル、`doctor`、`validate`、`plan`だけを自動実行します。システムソフトの導入、PATH変更、外部ログイン、secret設定、課金、`run`、`render`、Gate判断、commit、push、公開は行いません。詳しい境界は[初回セットアップ契約](docs/onboarding/setup-contract.ja.md)を参照してください。

Gate 2 の `retry_specific` は未実装で、1.0 でも入れません。全体を計画からやり直す場合は `revise` を使います。Gate 3 は `re-render` を受け付け、Gate 1 / 2 の承認を保ったまま rendering へ戻します。

## 開発者向け・手動セットアップ

クローン済みのrepo rootで、依存導入前からNode.js標準モジュールだけで公式Bootstrapを起動できます。

```sh
npm run setup:check
npm run setup
npm run setup:open  # セットアップ後にランチャーも開く場合だけ
```

機械可読な結果が必要な場合は各コマンドに`-- --json`を追加します。`setup:check`は読み取り専用です。OS別の導入は[セットアップ詳細](#セットアップ詳細とos別の注意)へ進んでください。

## エージェントスキル

Codexは `.agents/skills/tsugite/SKILL.md` を検出し、`$tsugite` または内容に一致する依頼から安全な制作フローを読み込みます。

Claude Codeでは `.claude/skills/tsugite/SKILL.md` が `/tsugite` として同じ正本を読み込みます。目的別の短縮入口:

- `/tsugite-plan` — validate → plan → Gate 1 レビュー（Gate は承認しない）
- `/tsugite-verify` — コード / 文書変更後の確認
- `/tsugite-finalize` — 対象動画を明示的に「完成」としたあとだけ
- `/tsugite-learning-review` — 学び昇格候補の準備
- `/shitate-import` — 任意の lock 付き snapshot 取り込み
- `/premiere-editing` / `/after-effects-editing` — Adobe を外部エディタとして使う

ルートの `SKILL.md` は旧ツール向けの互換入口です。

## ローカルランチャーと3D Viewer

Tsugiteリポジトリをいつもの Codex / Claude 環境で開き、案件確認にはブラウザ版ランチャーを並べます。Electron 版は開発・回帰検証用です。配布状態は [Desktop](docs/desktop.md) を参照してください。

```sh
npm --prefix apps/workflow-viewer ci  # 初回のみ
npm run viewer:open
```

ランチャーと成果物サーバーは、動的に選ばれた `127.0.0.1` のポートだけで待ち受けます。終了は起動したターミナルの `Ctrl+C` です。ブラウザ通知権限、デスクトップ通知、常駐サービス、外部通知先は使いません。

できること:

- `projects/*/project.yaml` を必須フィールド `name`（日本語可）で一覧する。
- 読み取り専用の 3D スナップショットを、実行中だけ使う権限 `0700` の一時ディレクトリへ再生成する。案件の出力 path には書き戻さない。
- 起動時に各案件の `feedback.jsonl` を読み、「好み・学び」棚で `observed` / `recurring` / `promoted` / `verified` を要約する。最大 128 案件、最新記録は合計 1000 項目。学び昇格の `pending` だけが未読風バッジになる。承認は別作業で実装を始める許可にすぎず、prompt / template / rule / Gate / state は変更しない。
- **安全な整理** は Git worktree 整理と完成案件の media finalize を **別パネル・別 preview・別確認・別 apply** にする。一括削除はない。ブラウザは path を送らず、サーバーが短命な review id を保持し、live 状態を再照合してから canonical CLI を呼ぶ。

3D Viewer は状態付きノード、依存線、詳細、シーク可能なイベント再生を持つ制作フロアです。Gate 2 QC が参照する実ファイルがある場合は、生成映像 2本・画像 4枚・音声 2本を `viewer/previews/` にコピーします。Gate 3 の完成動画も同じ場所へコピーします。adapter 実行、Gate 更新、state 書き込みは行いません。

JSON仕様、操作、制限は [`apps/workflow-viewer/README.md`](apps/workflow-viewer/README.md) です。

## セットアップ詳細とOS別の注意

必要環境は Git、Node.js 22.12以上の22.x LTS、npm 10以上、FFmpeg（`ffprobe`を含む）です。任意の Hypit 制作は追加で Node.js 22.15以上（22.x）が必要です。本体の最低版は 22.12 のままです。

```sh
# macOS
brew install ffmpeg

# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg

# Windows
winget install --id Gyan.FFmpeg -e
```

Windowsではインストール後にterminalを開き直してください。正式な入口とPowerShell手順は[Windowsネイティブ利用ガイド](docs/windows.md)を参照してください。PowerShellでは拡張子のない`bin/pipeline`を直接実行せず、`node bin/pipeline ...`を使用してください。Node.js、FFmpeg、provider CLIを導入・更新した後は PowerShell を開き直します。

`npm ci`はRemotionとHyperFramesを含む依存をこのrepo内へ導入します。HyperFramesはdevDependencyなので`npm ci --omit=dev`は使用しないでください。

```powershell
npm ci
npm --prefix apps/workflow-viewer ci
node bin/pipeline doctor --config examples/local-fixture/project.yaml --json
npm run viewer:open
```

初回セットアップ成功後、Codex と Claude Code は学び昇格自動化を一度だけ尋ねます。登録には host の明示選択が必要で、辞退するとそのセットアップ中は再質問しません。詳細は [学び昇格レビュー自動化](docs/automations/learning-promotion-review.md) です。

HyperFrames の BGM / SFX は ElevenLabs へ自動切替しません。[HyperFrames音声](docs/hyperframes-audio.md) を参照してください。

## コマンド

全体ヘルプには各コマンドの安全区分、個別ヘルプには利用可能なオプションが表示され、projectの読み込みやproviderへの接続は行いません。

```sh
node bin/pipeline --help
node bin/pipeline help validate
```

スクリプトから安定した機械可読出力を使う場合は `--json` を付けます。

```sh
npm ci
npm run check
node bin/pipeline story-guides --request "30秒の縦型SNS広告。価値と実績を見せる" --duration 30 --json
node bin/pipeline guides --json
node bin/pipeline presets --backend remotion --json
cp -R examples/local-fixture projects/my-first-run
node bin/pipeline doctor --config projects/my-first-run/project.yaml --json
node bin/pipeline validate --config projects/my-first-run/project.yaml --json
node bin/pipeline plan --config projects/my-first-run/project.yaml --json
node bin/pipeline review --config projects/my-first-run/project.yaml --open --json
node bin/pipeline viewer --config projects/my-first-run/project.yaml --open --json
node bin/pipeline run --config projects/my-first-run/project.yaml --dry-run --json
node bin/pipeline finalize --config projects/my-first-run/project.yaml --json
```

`review` は `dist/<run-id>/review/index.html` と `review-data.json` を生成します（字幕優先のコンテ、キャラクターシート、カット詳細、コスト、モーション）。Gate 1 の判断欄は最後に1回だけで、`state.json` は変更しません。Gate 1 の approve には canonical な出力先の2ファイルが必要です。`--open` はローカル HTML を開く場合だけ使います。

`viewer` は検証済み project / plan に `state.json`、`run-log.md`、review、Gate 2 / Gate 3 QC を重ね、`dist/<run-id>/viewer/index.html` と `workflow.json` を生成します。完全なイベント履歴はまだ保存しないため、タイムラインは plan 順と現在の成果物から再構成します。

長尺の手持ち動画を外部APIなしで解析する場合:

```sh
cp -R examples/local-analysis projects/my-seminar
node bin/pipeline doctor --config projects/my-seminar/project.yaml --json
node bin/pipeline validate --config projects/my-seminar/project.yaml --json
node bin/pipeline plan --config projects/my-seminar/project.yaml --json
node bin/pipeline analyze --config projects/my-seminar/project.yaml --actor coordinator --json
```

ローカルWhisperまで使う場合は `examples/local-analysis/project-editorial.yaml` を参照し、`model_path` と必須の `model_sha256` を信頼できる既存 `.pt` へ変更します。

Fast Edit の準備（Gate 承認も render もしない）。先に `local-whisper-analysis` を設定し、各ソースクリップの単語タイムスタンプを用意します。

```sh
node bin/pipeline analyze --config projects/my-first-run/project.yaml --actor coordinator
node bin/pipeline fast-edit --config projects/my-first-run/project.yaml --actor coordinator
```

`--allow-external-analysis` や `--decisions` の前に [Fast Edit](docs/fast-edit.md) を読んでください。

Gate で保護された実行:

```sh
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-1 --decision approve --json
node bin/pipeline run --config projects/my-first-run/project.yaml --actor coordinator --json
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-2 --decision approve_all --json
node bin/pipeline render --config projects/my-first-run/project.yaml --actor coordinator --json
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-3 --decision approve --json
```

ユーザーが対象動画を明示的に「完成」と確定した後は、正本 path・QA 証跡と終了記録を残してから `finalize` を preview します。引数なしは読み取り専用で `plan_digest` を表示するだけです。Coordinator が同じ digest を `--expected-plan-digest` に渡すと、最終 run、最終 manifest が参照する元素材、設定・manifest・state・run log を残し、旧 run・旧 QA・未使用素材の動画・音声・画像だけを削除します。`--state-dir` は `project.dist_dir` と同一のときだけ許可されます。

```sh
node bin/pipeline finalize --config projects/my-first-run/project.yaml --json
# preview JSON の plan_digest をそのまま渡す:
node bin/pipeline finalize --config projects/my-first-run/project.yaml --apply --actor coordinator --expected-plan-digest <plan_digest> --json
```

実装タスクを明示的に完了としたあとは、残った Git worktree を削除する前に監査します。`worktrees` の既定は読み取り専用の JSON preview です。apply には Coordinator と明示的な `--path` が必要で、`git worktree remove --force` や branch 削除は行いません。primary/current・dirty・未統合・locked・missing、および `projects/` や `.env` などの保護対象は拒否します。

```sh
node bin/pipeline worktrees --json
node bin/pipeline worktrees --apply --actor coordinator --path ../tsugite-feature-task --json
```

完成承認時にローカル `main` が別作業中なら、対象 worktree を統合待ちへ固定し、あとから primary のクリーンな main で `--reconcile` できます。詳細は [統合待ちworktreeのreconcile](docs/automations/worktree-reconcile.md) と [残存件数の通知](docs/automations/worktree-cleanup-alert.md) です。`worktree_warning` は削除可能候補が 3 件以上あることの件数警告であり、削除承認ではありません。

## 公開 Agent Services（Remote MCP）

公開 read-only Remote MCP（Cloudflare Search MCP と Azumi Experience）は同梱の [`agent-services/registry.yaml`](agent-services/registry.yaml) に登録します。生成 connections ではなく、任意 URL は受け付けず、この CLI から副作用も解きません。購入・決済操作ではありません（`billing_action=false`）が、provider の usage は消費し得ます（`provider_usage_possible=true`）。

```sh
node bin/pipeline services --json
node bin/pipeline service-tools --service itopan-search --json
node bin/pipeline service-call --service itopan-search --tool search --arguments '{"query":"AIエージェント"}' --json
```

Human Gate、endpoint 固定、現行の read-only 範囲は [Agent Services](docs/agent-services.md) を参照してください。

## Shitate連携（任意）

別リポジトリのShitateを使う場合だけ、選定済みrunとanchorをSHA-256 lock付きの不変snapshotとしてprojectへ取り込めます。通常のTsugite利用には不要です。

```sh
node bin/pipeline shitate-import \
  --config projects/my-project/project.yaml \
  --shitate-root /absolute/path/to/shitate \
  --character hero \
  --run-id 20260713_three-view_v1 \
  --anchor references/images/main-anchor.png \
  --request-id shot-001 \
  --json
```

ローカルファイルのコピー、manifestへのanchor/speaker追加、任意requestのI2V化だけを行い、生成やGate更新は行いません。詳しくは [Shitate連携](docs/shitate.md) を参照してください。

## キャラクター追加

任意の source manifest から speaker（poses / mouth frames / images）を target project へコピーします。テンプレートや他 project のキャラを Shitate なしで再利用する用途向けです。

```sh
node bin/pipeline character-add \
  --config projects/my-project/project.yaml \
  --from-manifest fixtures/manifests/dialogue.valid.json \
  --speaker left \
  --json
```

source の画像パスは manifest と同じディレクトリを基準に解決します。完全一致時は冪等、競合時は上書きせず拒否し、生成や Gate 更新は行いません。

## project ファイル

`examples/local-fixture/project.yaml` で使っている最小の local-media project:

```yaml
slug: local-fixture
name: ローカル検証フィクスチャ
run_id: local-fixture-run
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
```

`name` は必須（日本語可）です。ランチャーはこの表示名で一覧します。後から選択パネルの「名前を変更」で直せます（`slug` / フォルダ名は変わりません）。

生成を含む project では `generation` section を追加します。

```yaml
generation:
  adapter: pixverse
  requests:
    - id: shot-001
      prompt: short prompt
      model: v6
      duration: 5
      aspect: "16:9"
      input_mode: text-to-video
      params: {}
```

`plan` はモデルと入力モードが一致した `prompt_guidance` を返します。別adapter経由でモデル知識を使う場合はrequestに `prompt_guide.catalog` を指定します。カタログは実行能力を意味せず、promptを自動変更しません。

Fast Edit の例:

```yaml
edit:
  backend: remotion # or hyperframes / editframe
  fast_edit:
    enabled: true
    beat_seconds: 2.5 # 任意
```

MiniMax H3（`minimax-h3`）では、自由記述ではなく任意の Creative IR + 決定的 compiler を使います。[H3 Prompt Director](docs/h3-prompt-director.md) と [`examples/h3-prompt-director/`](examples/h3-prompt-director/) を参照してください。

Hermes の optional adapter は、配布時に必要な人だけが追加する opt-in です。base install では不要です。詳しくは [Optional Adapters](docs/optional-adapters.md) を参照してください。

## パイプラインの育て方

Tsugite は、動画をたくさん生成するだけで自動的に自分好みになるわけではありません。出力を見て、やり直し理由や好みを言語化し、それを repo のルール、テンプレ、チェックに戻していくことで育ちます。

構造化feedbackは各 `projects/<job>/feedback.jsonl` にローカル保存します。案件をまたいで同じ好みには同じ `key` を付けます。状態は `observed` → `recurring` → `promoted` → `verified` です。昇格は必ず人間が判断し、承認記録だけでは prompt、template、check、運用 rule を自動変更しません。

1. `projects/` に project を作る。
2. Gate 承認後にだけ生成または組み立てを実行する。
3. 出力を見て、良かった点、失敗した点、やり直した理由を `pipeline feedback` で記録する。
4. 一回限りのメモはそのローカル project 内に残す。
5. 同じ `key` の反復記録を根拠に、人間承認後だけ再利用先へ反映する。
6. 後続の出力で改善を確認してから `verified` にする。

任意の Codex Automation、Claude Desktop/Cowork Scheduled task、Claude Code から、この承認待ちキューだけを準備できます（1回最大3件、重複なし）。常設 schedule は1つを主系にします。詳細は [学び昇格レビュー自動化](docs/automations/learning-promotion-review.md) です。

```sh
node bin/pipeline feedback --config projects/my-first-run/project.yaml \
  --key opening-audio --category audio --signal prefer --stage observed \
  --summary "冒頭0.5秒以内にBGMを開始する" --json
```

昇格の目安:

```text
一回限りの好み        -> projects/<job>/notes.md + feedback.jsonl (observed)
同じ好みkeyの反復     -> feedback.jsonl (recurring; 昇格を人間が確認)
何度も使う好み        -> examples/ or templates/
機械的に防げる失敗    -> constraints.yaml / validate / doctor + tests/fixtures
判断系の運用ルール    -> LESSONS.md -> .agents/skills/tsugite/SKILL.md / CLAUDE.md / AGENTS.md
QA の判定ルール       -> Gate 2 / Gate 3 checks + report schema/tests
公開契約の変更        -> README / manifest/schema.md / docs/requirements.md
```

昇格には人間の承認が必要です。失敗の再現fixtureとテスト、または人間が読む運用ルールのどちらかを必ず残します。

## リポジトリルール

- core code はベンダー中立に保つ。ベンダー固有の実行挙動は `adapters/` または `backends/`、根拠付きの助言データは `knowledge/video-models/` と `knowledge/story-frameworks/` に閉じ込める。
- adapter directory には `constraints.md` を必ず置く。
- `mcp-agent` adapter には `SKILL.md` を必ず置く。
- ユーザー作業は `projects/` に置き、`examples/` はコピー可能でリセットしやすい状態に保つ。
- 再利用できるルールが生まれる失敗は `LESSONS.md` に記録する。

## 本番運用メモ

- `examples/local-fixture/project.yaml` は fixture style のローカル検証 config です。編集前に `projects/` へコピーしてください。
- `projects/*` は git ignore されるため、ローカル prompt、media、manifest、`dist/`、run state は配布用 commit に混ざりません。
- npm 11 では、platform-specific parent が skip されても optional wasm child package が lockfile に残るため、`npm ci` 後に `npm ls` が `@emnapi/runtime` を extraneous と表示する場合があります。`npm ci`、`npm audit`、build、tests、`validate`、`plan`、`run --dry-run` がすべて通っている場合のみ non-blocking と扱います。
- `npm run check` はvendor boundary、TypeScript build、全テストに加え、`src/`のstatements / functions / linesが80%以上、branchesが74.4%以上であることを強制します（Production Orchestration 導入後の保持値。75%復帰は残債）。高core環境やCI runnerでもprocess-heavyなfixtureを安定させるため、coverageはVitestを最大4 workerで実行します。
- `npm run security:audit` はproduction依存と開発依存を含む全体の両方を検査し、moderate以上のadvisoryで失敗します。
- この workspace path には `*` が含まれるため、Vite が警告する場合があります。現在この path でも tests は通りますが、運用上ノイズになる場合は `*` を含まない path に repo を移してください。
- 1.0 は live provider/billing 証拠と packaged Desktop UAT がまだ必要です。Windows smoke は GitHub Actions で確認済みです。Desktop インストーラーはこのソースリリースの対象外です。
