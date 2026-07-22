# tsugite

[English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [한국어](README.ko.md)

生成アダプタと編集バックエンドを、単一の manifest 契約で接続するベンダー中立の動画パイプラインです。

動画 job ごとに `project.yaml` を持ちます。配布用 repo として、コピー可能なサンプルは `examples/` に置き、ユーザー作業用の `projects/` は git 管理から外します。安全な基本フローは次の通りです。

1. project と manifest を検証する。
2. 実行計画を作成する。
3. Gate 1 で人間の承認を待つ。
4. Coordinator 承認後にだけ生成または組み立てを実行する。
5. Gate 2 で出力 QA を行う。
6. Gate 2 承認後にだけ render する。
7. Gate 3 で最終動画 QA を行う。

## エージェントスキル

Codexはrepo skillの `.agents/skills/tsugite/SKILL.md` を検出し、`$tsugite` または内容に一致する依頼から安全な制作フローを読み込みます。

Claude Codeでは `.claude/skills/tsugite/SKILL.md` が `/tsugite` として同じ正本を読み込みます。目的別の短縮入口として `/tsugite-plan`、`/tsugite-verify`、`/tsugite-finalize`、`/tsugite-learning-review`、`/shitate-import` も利用できます。ルートの `SKILL.md` は旧ツール向けの互換入口です。

## 現在のスコープ

- manifest 検証とローカル素材チェック。
- `cli`、`mcp-agent`、`mcp-client` 形式のアダプタ registry。
- PixVerse / Kling 向け CLI generation adapter wrapper。
- PixVerse / Kling / Seedance の出典・鮮度付き T2V / I2V prompt knowledge catalog。
- 34種の物語・広告・解説・ドキュメンタリー・ジャンル・MV構成と、35種の尺配分・映像文法・AI動画原則を理由付きで選ぶ story guide catalog。
- TopView skill CLIを使うT2V / 単一画像I2V generation adapter。
- OpenClaw 向け optional CLI bridge と Hermes 向け analysis handoff adapter。
- APIキー不要でFFmpegだけを使う `pipeline analyze` と local-media-analysis adapter。
- 既存のローカルWhisperモデルで、文字起こし・フィラー候補・章・抽出的要約・英訳字幕を作るlocal-whisper-analysis adapter。
- Gate 1で承認した明示的な候補だけをsource-to-output EDLへ変換し、Remotion / HyperFramesへ同じ編集済みmanifestを渡す長尺編集フロー。
- local-media / generated-media を `dist/<run-id>/` に組み立てる処理。
- manifest と media probe による Gate 2 QC report 生成。
- 最終尺・解像度・fps・映像/音声streamを検査する Gate 3 QC report 生成。
- 画像素材、話者/pose、presentation presetを含むmanifest契約。
- Remotion / HyperFrames backend 契約。
- Gate 1後・Gate 2前にBGM/SFXを固定する音声adapter契約と、HyperFrames公式`media-use`接続。
- Coordinator role と Gate 承認を要求する guarded `run` / `render`。
- `apps/workflow-viewer/` 配下の独立した読み取り専用3Dワークフロービューア。

## 3D Workflow Viewer

ランチャーでは「いつものAIで作業」「このアプリでAIと作業」「確認だけする」の3つから作業場所を選べます。いつものCodex / Claudeアプリを確認画面と並べて使うことも、Desktop内蔵端末からPCに導入済みのCodex CLI / Claude Codeを開くこともできます。ブラウザ版では内蔵端末を使えないため、外部アプリと並べるか、確認だけに使います。

内蔵端末はAI CLIをインストールせず、最初に起動できる対象をCodex CLI / Claude Codeに限定します。ただし、起動後のAI CLIは各CLIの通常の権限・承認設定に従い、workspaceのファイル読書き、command実行、network接続を行うことがあります。Tsugite独自のsandboxではないため、各CLIの承認画面を確認してください。AI CLIの認証・契約と、PixVerseなど生成providerのAPI課金・creditsは別です。内蔵端末やランチャーを開いても生成は始まらず、AIが提案してもGateは自動承認されません。Gateは一般的なファイル操作を制限する仕組みではなく、`run`、`render`、Gate判定には従来どおり人の明示承認とCoordinator権限が必要です。

同梱サンプルまたはCLIが生成したTsugiteスナップショットを、状態付きノード、依存線、詳細パネル、シーク可能なイベント再生を備えた3D制作フロアとして表示します。工程名と説明は非エンジニア向けの日本語を優先し、内部名、技術参照、時刻、ログは「詳しい情報」にまとめます。CLIから現在状態を出力できますが、Viewer自体はバックエンド、プロバイダー呼び出し、project変更、実行権限を持ちません。

Desktopで制作案件が0件の場合は、空の制作棚からworkspaceを選び直せます。実行中の制作処理やAI CLIがある間は切替を行わず、選択先を検証・保存してからDesktop全体を再起動します。ブラウザ版にはこの端末ローカル操作を表示しません。

```sh
cd apps/workflow-viewer
npm install
npm run dev
npm run test:coverage
npm run build
```

JSON仕様、操作、サンプル、現在の制限は [`apps/workflow-viewer/README.md`](apps/workflow-viewer/README.md) を参照してください。

## セットアップ

必要環境は Git、Node.js 22.12以上の22.x LTS、npm 10以上、FFmpeg（`ffprobe`を含む）です。

```sh
# macOS
brew install ffmpeg

# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg

# Windows
winget install --id Gyan.FFmpeg -e
```

Windowsではインストール後にterminalを開き直してください。`npm ci`はRemotionとHyperFramesを含む依存をこのrepo内へ導入するため、global installは不要です。HyperFramesはdevDependencyなので`npm ci --omit=dev`は使用しないでください。正式な入口とPowerShell手順は[Windowsネイティブ利用ガイド](docs/windows.md)を参照してください。

repo rootからのPowerShell最短手順です。

```powershell
npm ci
npm --prefix apps/workflow-viewer ci
node bin/pipeline doctor --config examples/local-fixture/project.yaml --json
npm run viewer:open
```

PowerShellでは拡張子のない`bin/pipeline`を直接実行せず、`node bin/pipeline ...`を使用してください。Node.js、FFmpeg、provider CLIを導入・更新した後は、更新された`PATH`と`PATHEXT`を反映するためPowerShellを開き直します。providerの認証、利用権限、課金設定は別途手動で準備してください。

PixVerse / Klingなどのprovider CLI、TopView / OpenClaw / Hermesの外部runtime、認証情報、課金設定は自動導入・設定しません。選択したadapterだけを別途準備し、`doctor`を再実行してください。TopViewでは同梱skillの`video_gen.py`を非課金の`list-models`で確認します。`doctor`は生成や課金を行わず、認証や残クレジットは手動確認として表示します。blocking checkが不足または未確認なら全体の`ok`は`false`になります。

TopViewの`mode: image-to-video`設定、安全な`first_frame`、Gate付き実行は[`docs/topview-cli.md`](docs/topview-cli.md)を参照してください。

HyperFramesでBGM生成とSFX解決を行う場合は[`docs/hyperframes-audio.md`](docs/hyperframes-audio.md)を参照してください。この経路はElevenLabsへ自動切替しません。

## コマンド

最初に組み込みのコマンド一覧を確認できます。全体ヘルプには各コマンドの安全区分、個別ヘルプには利用可能なオプションが表示され、projectの読み込みやproviderへの接続は行いません。

```sh
node bin/pipeline --help
node bin/pipeline help validate
```

スクリプトから安定した機械可読出力を使う場合は、ヘルプや各コマンドに`--json`を付けます。

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

`presets` は、install済みbackendが宣言するpresentation presetをprojectに依存せず読み取る、副作用のないコマンドです。manifestの作成・変更時は、未確認のpreset IDを手入力せず、返却された `presets` 一覧から選びます。

非エンジニアが複数の制作案件から選んで確認する場合は、初回だけViewer依存を導入し、その後はランチャーを1コマンドで開けます。

```sh
npm --prefix apps/workflow-viewer ci  # 初回だけ
npm run viewer:open
```

ランチャーは `127.0.0.1` の空きポートだけで起動し、`projects/*/project.yaml` を一覧表示します。起動時に各ローカル案件の `feedback.jsonl` を読み、「好み・学び」棚で `observed` / `recurring` / `promoted` / `verified` の状態を要約します。対象は最大128案件で、各案件の最新記録・診断を公平に合計1000項目まで選び、上限到達時は画面に明示します。「最新状態に更新して開く」は現在のstate・review・QC・run logから読み取り専用Viewerを再生成します。再生成先はランチャーの実行中だけ使う権限 `0700` の一時ディレクトリで、案件の出力pathには書き戻さず、ランチャー終了時に削除します。専用の学び昇格自動化が作った `pending` 案だけを、未読風バッジとピックアップで表示します。手動案や別workflowの結果は通常の棚に残り、ピックアップには入りません。これは別の既読状態ではなく、現在の承認待ち件数です。人は反映先・変更内容・根拠・検証方法を確認し、承認または見送りを記録します。どちらの判断でも対象は承認待ちから解消されます。承認は別作業で実装を始める許可にすぎず、承認操作そのものはprompt、template、rule、check、Gate、stateを変更しません。ランチャーはブラウザ通知権限を要求せず、デスクトップ通知、常駐サービス、外部通知先を使いません。終了するときは、起動したターミナルで `Ctrl+C` を押します。

長尺の手持ち動画を外部APIなしで解析する場合は、`examples/local-analysis` を使います。

```sh
cp -R examples/local-analysis projects/my-seminar
node bin/pipeline doctor --config projects/my-seminar/project.yaml --json
node bin/pipeline validate --config projects/my-seminar/project.yaml --json
node bin/pipeline plan --config projects/my-seminar/project.yaml --json
node bin/pipeline analyze --config projects/my-seminar/project.yaml --actor coordinator --json
```

ローカルWhisperまで使う場合は `examples/local-analysis/project-editorial.yaml` を参照し、`model_path` と必須の `model_sha256` を信頼できる既存`.pt`へ変更します。モデルの自動downloadは行いません。詳しくは [APIを使わないローカル長尺解析](docs/local-analysis.md) を参照してください。

解析は元動画・manifest・Gate stateを変更せず、source timestamp付き候補とローカルhandoffを生成します。候補は `edit.editorial` で明示選択し、Gate 1承認後の `run` だけが `editorial-edl.json` と編集済みmanifestへ反映します。詳しくは [APIを使わないローカル長尺解析](docs/local-analysis.md) を参照してください。

`review` は検証済みのproject・manifest・planから `dist/<run-id>/review/index.html` と `review-data.json` を生成します。字幕を優先した一枚絵コンテ、キャラクターシート、カット詳細、コストに加え、全体・カット別のモーション仕様と安全なHTML/CSS近似プレビューを表示します。Gate 1の判断欄は全レビュー項目と制作条件の後に1回だけ表示し、`state.json` は変更せず生成処理も実行しません。Gate 1のapproveと実行開始時には、この2ファイルが存在し、対象projectのレビューであることを検査します。出力先を変える場合は `--output <directory>`、別のstateルートを使う場合は `--state-dir <directory>`、ローカルHTMLを開く場合だけ `--open` を使います。Gate 1検査に使う場合はcanonicalな出力先を使ってください。

`viewer` は検証済みproject / planに、現在の `state.json`、`run-log.md`、review、Gate 2 / Gate 3のQC成果物を重ね、`dist/<run-id>/viewer/index.html` と `workflow.json` を生成します。`run-log.md` の実行サマリーと生成リクエスト記録は、素材生成工程の詳しい情報に表示されます。Gate 2 QCが参照する実ファイルがある場合は、代表的な生成映像2本・画像4枚・音声2本を `viewer/previews/` にコピーし、Gate 2の右パネルで直接プレビューできます。Gate 3 QCの完成動画も同じ場所へコピーし、完成動画の作成・確認・完了工程で再生できます。パス外参照、リンク、未対応形式、欠損ファイルは同梱しません。adapter実行、Gate更新、state書き込みを行わない読み取り専用スナップショットです。初回だけ `npm --prefix apps/workflow-viewer ci` でViewer依存を導入し、pipeline状態が変わったらコマンドを再実行してください。Tsugiteは完全なイベント履歴をまだ保存していないため、タイムラインはplanの工程順と現在の成果物から決定的に再構成します。`--output`、`--state-dir`、`--open` は `review` と同じローカル成果物規約です。

`run` と `render` は意図的に Gate で保護されています。

```sh
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-1 --decision approve --json
node bin/pipeline run --config projects/my-first-run/project.yaml --actor coordinator --json
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-2 --decision approve_all --json
node bin/pipeline render --config projects/my-first-run/project.yaml --actor coordinator --json
node bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-3 --decision approve --json
```

明示的な人間承認なしに、非 dry-run の `run` や `render` を実行しないでください。
Gate 3 は `re-render` も受け付け、Gate 1 / 2 の承認を保ったままrenderingへ戻します。Gate 2 の `retry_specific` は未実装です。全体を計画からやり直す場合は `revise` を使います。

ユーザーが対象動画を明示的に「完成」と確定した後だけ、`finalize` で旧メディアを整理できます。引数なしのpreviewは削除予定と保持対象を表示するだけです。内容を確認後、Coordinatorが `--apply` を付けると、最終run、最終manifestが参照する元素材、設定・manifest・state・run logを残し、旧run・旧QA・未使用素材の動画・音声・画像だけを削除します。実行結果は最終run内の `completion-record.json` に記録されます。

```sh
node bin/pipeline finalize --config projects/my-first-run/project.yaml --json
node bin/pipeline finalize --config projects/my-first-run/project.yaml --apply --actor coordinator --json
```

## Shitate連携（任意）

別リポジトリのShitateを使う場合だけ、選定済みrunとanchorをSHA-256 lock付きの不変snapshotとしてprojectへ取り込めます。通常のTsugite利用にはShitateの導入・設定は不要です。

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

ローカルファイルのコピー、manifestへのanchor/speaker追加、任意requestのI2V化だけを行い、生成やGate更新は行いません。`negative.txt` は保存しますが、現行PixVerse video CLIに対応引数がないため黙って適用しません。詳しくは [Shitate連携](docs/shitate.md) を参照してください。

## project ファイル

`examples/local-fixture/project.yaml` で使っている最小の local-media project:

```yaml
slug: local-fixture
run_id: local-fixture-run
manifest: manifest.json
dist_dir: dist
edit:
  backend: remotion
```

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

`plan` はモデルと入力モードが一致した `prompt_guidance` を返します。別adapter経由でモデル知識を使う場合はrequestに `prompt_guide.catalog` を指定します。カタログは実行能力を意味せず、promptを自動変更しません。詳しくは [モデル別プロンプト知識](docs/prompt-guides.md) を参照してください。

構成やカットを提案する前に `story-guides` を使うと、目的と尺に応じた第一候補、補助候補、不採用理由、カット配分、映像文法をJSONで確認できます。Save the Catを含む有名メソッドは固有展開をコピーせず、構造上の役割へ抽象化します。詳しくは [王道の物語構成・映像文法](docs/story-guides.md) を参照してください。

OpenClaw / Hermes の optional adapter は、配布時に必要な人だけが追加する
opt-in 機能です。base install では不要で、`project.yaml` が該当 adapter を
選んだ場合だけ adapter 固有の setup を行います。詳しくは
[Optional Adapters](docs/optional-adapters.md) を参照してください。

## パイプラインの育て方

Tsugite は、動画をたくさん生成するだけで自動的に自分好みになるわけではありません。出力を見て、やり直し理由や好みを言語化し、それを repo のルール、テンプレ、チェックに戻していくことで育ちます。

構造化feedbackは各 `projects/<job>/feedback.jsonl` にローカル保存します。案件をまたいで同じ好みには同じ `key` を付け、生成回数ではなく反復した記録を識別します。状態は `observed`（初回記録）→ `recurring`（反復を確認）→ `promoted`（共有先へ反映済み）→ `verified`（後続出力で改善確認）の順です。`recurring` で反映先・変更内容・検証方法が揃うと昇格案を作成でき、`pending`（承認待ち）→ `approved`（承認済み・反映待ち）または `rejected`（見送り）を別軸で記録します。昇格は必ず人間が判断し、承認記録だけではprompt、template、check、運用ruleを自動変更しません。

基本ループは次の通りです。

1. `projects/` に project を作る。
2. Gate 承認後にだけ生成または組み立てを実行する。
3. 出力を見て、良かった点、失敗した点、やり直した理由を `pipeline feedback` で記録する。
4. 一回限りのメモと `feedback.jsonl` はそのローカルproject内に残す。
5. 同じ `key` の反復記録を根拠に、反映先・変更内容・検証方法を持つ昇格案を作る。
6. ランチャーで人が昇格案を承認または見送り、承認済みの案だけを再利用先へ実装して `promoted` にする。
7. 後続の出力で改善を確認してから `verified` にする。

任意のCodex Automation、Claude Desktop/Cowork Scheduled task、Claude Codeから、この承認待ちキューだけをランチャーの起動と独立して準備できます。これは他の自動化の状態確認ではなく、「好み・学び」の昇格候補を人の承認待ちにする専用自動化です。1回に最大3件、反映先・変更内容・検証方法・根拠が揃う重複のない候補だけを、既存の `pipeline feedback` CLIで `pending` 追記します。共有sourceは自動変更しません。登録方法、実行元の記録、host標準通知の条件は [学び昇格レビュー自動化](docs/automations/learning-promotion-review.md) を参照してください。重複実行を避けるため常設scheduleは1つを主系にします。

コピー済みのローカルprojectへ記録し、絶対pathを公開せずJSON結果を確認する例:

```sh
node bin/pipeline feedback --config projects/my-first-run/project.yaml \
  --key opening-audio --category audio --signal prefer --stage observed \
  --summary "冒頭0.5秒以内にBGMを開始する" --json
```

反復した学びに昇格案を作り、ランチャーへ「昇格承認待ち」として表示する例:

```sh
node bin/pipeline feedback --config projects/my-first-run/project.yaml \
  --key opening-audio --category audio --signal prefer --stage recurring \
  --summary "冒頭0.5秒以内にBGMを開始する" \
  --evidence "dist/my-first-run/gate3-qc.json" \
  --promotion-kind qa --target src/orchestrator/gate3Qc.ts \
  --proposal-summary "冒頭音声の判定をGate 3へ追加する" \
  --verification "後続案件のgate3-qc.jsonと冒頭波形で確認する" --json
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

昇格には人間の承認が必要です。失敗の再現fixtureとテスト、または人間が読む運用ルールのどちらかを必ず残します。Gate 2 / Gate 3 の判定を増やす場合は、reportの形とテストも一緒に更新します。昇格後は、後続projectの記録を根拠に `verified` を判断します。

このループによって、配布用 repo としての安全性を保ったまま、自分好みの制作パイプラインに育てていけます。ローカル案件は `projects/` 配下で git 管理外にし、再利用できる改善だけを本体へ commit します。

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
- `npm run check` はvendor boundary、TypeScript build、全テストに加え、`src/`のstatements / functions / linesが80%以上、branchesが75%以上であることを強制します。高core環境やCI runnerでもprocess-heavyなfixtureを安定させるため、coverageはVitestを最大4 workerで実行します。
- `npm run security:audit` はproduction依存と開発依存を含む全体の両方を検査し、moderate以上のadvisoryで失敗します。
- この workspace path には `*` が含まれるため、Vite が警告する場合があります。現在この path でも tests は通りますが、運用上ノイズになる場合は `*` を含まない path に repo を移してください。
