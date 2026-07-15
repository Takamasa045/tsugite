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

## 現在のスコープ

- manifest 検証とローカル素材チェック。
- `cli`、`mcp-agent`、`mcp-client` 形式のアダプタ registry。
- PixVerse / Kling 向け CLI generation adapter wrapper。
- PixVerse / Kling / Seedance の出典・鮮度付き T2V / I2V prompt knowledge catalog。
- 34種の物語・広告・解説・ドキュメンタリー・ジャンル・MV構成と、35種の尺配分・映像文法・AI動画原則を理由付きで選ぶ story guide catalog。
- Topview 向け MCP-agent generation adapter 契約。
- OpenClaw 向け optional CLI bridge と Hermes 向け analysis handoff adapter。
- APIキー不要でFFmpegだけを使う `pipeline analyze` と local-media-analysis adapter。
- 既存のローカルWhisperモデルで、文字起こし・フィラー候補・章・抽出的要約・英訳字幕を作るlocal-whisper-analysis adapter。
- Gate 1で承認した明示的な候補だけをsource-to-output EDLへ変換し、Remotion / HyperFramesへ同じ編集済みmanifestを渡す長尺編集フロー。
- local-media / generated-media を `dist/<run-id>/` に組み立てる処理。
- manifest と media probe による Gate 2 QC report 生成。
- 最終尺・解像度・fps・映像/音声streamを検査する Gate 3 QC report 生成。
- 画像素材、話者/pose、presentation presetを含むmanifest契約。
- ブログ記事を60秒・16:9の2人掛け合いへ変換するRemotionテンプレート。
- FAQの質問リストからQUESTION/ANSWERカード付き掛け合いを生成するQ&Aテンプレート。
- Remotion / HyperFrames backend 契約。
- Coordinator role と Gate 承認を要求する guarded `run` / `render`。
- `apps/workflow-viewer/` 配下の独立した読み取り専用3Dワークフロービューア。

## 3D Workflow Viewer

同梱サンプルまたはCLIが生成したTsugiteスナップショットを、状態付きノード、依存線、詳細パネル、シーク可能なイベント再生を備えた3D制作フロアとして表示します。工程名と説明は非エンジニア向けの日本語を優先し、内部名、技術参照、時刻、ログは「詳しい情報」にまとめます。CLIから現在状態を出力できますが、Viewer自体はバックエンド、プロバイダー呼び出し、project変更、実行権限を持ちません。

```sh
cd apps/workflow-viewer
npm install
npm run dev
npm run test:coverage
npm run build
```

JSON仕様、操作、サンプル、現在の制限は [`apps/workflow-viewer/README.md`](apps/workflow-viewer/README.md) を参照してください。

## セットアップ

必要環境は Git、Node.js 22.x、npm 10以上、FFmpeg（`ffprobe`を含む）です。

```sh
# macOS
brew install ffmpeg

# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg

# Windows
winget install --id Gyan.FFmpeg -e
```

Windowsではインストール後にterminalを開き直してください。`npm ci`はRemotionとHyperFramesを含む依存をこのrepo内へ導入するため、global installは不要です。HyperFramesはdevDependencyなので`npm ci --omit=dev`は使用しないでください。

PixVerse / Klingなどのprovider CLI、Topview / OpenClaw / Hermesの外部runtime、認証情報、課金設定は自動導入・設定しません。選択したadapterだけを別途準備し、`doctor`を再実行してください。`doctor`はversion・local package・宣言済みbridgeを副作用のない方法で検査し、生成や課金を行いません。認証や実providerへの接続は行わず、必要な手動確認を`status: manual`と`remediation`で表示します。blocking checkが不足または未確認なら全体の`ok`は`false`になります。

## コマンド

```sh
npm ci
npm run check
bin/pipeline story-guides --request "30秒の縦型SNS広告。価値と実績を見せる" --duration 30 --json
bin/pipeline guides --json
cp -R examples/local-fixture projects/my-first-run
bin/pipeline doctor --config projects/my-first-run/project.yaml --json
bin/pipeline validate --config projects/my-first-run/project.yaml --json
bin/pipeline plan --config projects/my-first-run/project.yaml --json
bin/pipeline review --config projects/my-first-run/project.yaml --open --json
bin/pipeline viewer --config projects/my-first-run/project.yaml --open --json
bin/pipeline run --config projects/my-first-run/project.yaml --dry-run --json
bin/pipeline finalize --config projects/my-first-run/project.yaml --json
```

長尺の手持ち動画を外部APIなしで解析する場合は、`examples/local-analysis` を使います。

```sh
cp -R examples/local-analysis projects/my-seminar
bin/pipeline doctor --config projects/my-seminar/project.yaml --json
bin/pipeline analyze --config projects/my-seminar/project.yaml --actor coordinator --json
```

ローカルWhisperまで使う場合は `examples/local-analysis/project-editorial.yaml` を参照し、`model_path` と必須の `model_sha256` を信頼できる既存`.pt`へ変更します。モデルの自動downloadは行いません。詳しくは [APIを使わないローカル長尺解析](docs/local-analysis.md) を参照してください。

解析は元動画・manifest・Gate stateを変更せず、source timestamp付き候補とローカルhandoffを生成します。候補は `edit.editorial` で明示選択し、Gate 1承認後の `run` だけが `editorial-edl.json` と編集済みmanifestへ反映します。詳しくは [APIを使わないローカル長尺解析](docs/local-analysis.md) を参照してください。

`review` は検証済みのproject・manifest・planから `dist/<run-id>/review/index.html` と `review-data.json` を生成します。字幕を優先した一枚絵コンテ、キャラクターシート、カット詳細、コスト、Gate 1コマンドを表示しますが、`state.json` は変更せず生成処理も実行しません。Gate 1のapproveと実行開始時には、この2ファイルが存在し、対象projectのレビューであることを検査します。出力先を変える場合は `--output <directory>`、別のstateルートを使う場合は `--state-dir <directory>`、ローカルHTMLを開く場合だけ `--open` を使います。Gate 1検査に使う場合はcanonicalな出力先を使ってください。

`viewer` は検証済みproject / planに、現在の `state.json`、`run-log.md`、review、Gate 2 / Gate 3のQC成果物を重ね、`dist/<run-id>/viewer/index.html` と `workflow.json` を生成します。`run-log.md` の実行サマリーと生成リクエスト記録は、素材生成工程の詳しい情報に表示されます。Gate 2 QCが参照する実ファイルがある場合は、代表的な生成映像2本・画像4枚・音声2本を `viewer/previews/` にコピーし、Gate 2の右パネルで直接プレビューできます。Gate 3 QCの完成動画も同じ場所へコピーし、完成動画の作成・確認・完了工程で再生できます。パス外参照、リンク、未対応形式、欠損ファイルは同梱しません。adapter実行、Gate更新、state書き込みを行わない読み取り専用スナップショットです。初回だけ `npm --prefix apps/workflow-viewer ci` でViewer依存を導入し、pipeline状態が変わったらコマンドを再実行してください。Tsugiteは完全なイベント履歴をまだ保存していないため、タイムラインはplanの工程順と現在の成果物から決定的に再構成します。`--output`、`--state-dir`、`--open` は `review` と同じローカル成果物規約です。

`run` と `render` は意図的に Gate で保護されています。

```sh
bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-1 --decision approve --json
bin/pipeline run --config projects/my-first-run/project.yaml --actor coordinator --json
bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-2 --decision approve_all --json
bin/pipeline render --config projects/my-first-run/project.yaml --actor coordinator --json
bin/pipeline gate --config projects/my-first-run/project.yaml --actor coordinator --gate gate-3 --decision approve --json
```

明示的な人間承認なしに、非 dry-run の `run` や `render` を実行しないでください。
Gate 3 は `re-render` も受け付け、Gate 1 / 2 の承認を保ったままrenderingへ戻します。Gate 2 の `retry_specific` は未実装です。全体を計画からやり直す場合は `revise` を使います。

ユーザーが対象動画を明示的に「完成」と確定した後だけ、`finalize` で旧メディアを整理できます。引数なしのpreviewは削除予定と保持対象を表示するだけです。内容を確認後、Coordinatorが `--apply` を付けると、最終run、最終manifestが参照する元素材、設定・manifest・state・run logを残し、旧run・旧QA・未使用素材の動画・音声・画像だけを削除します。実行結果は最終run内の `completion-record.json` に記録されます。

```sh
bin/pipeline finalize --config projects/my-first-run/project.yaml --json
bin/pipeline finalize --config projects/my-first-run/project.yaml --apply --actor coordinator --json
```

## Shitate連携（任意）

別リポジトリのShitateを使う場合だけ、選定済みrunとanchorをSHA-256 lock付きの不変snapshotとしてprojectへ取り込めます。通常のTsugite利用にはShitateの導入・設定は不要です。

```sh
bin/pipeline shitate-import \
  --config projects/my-project/project.yaml \
  --shitate-root /absolute/path/to/shitate \
  --character hero \
  --run-id 20260713_three-view_v1 \
  --anchor references/images/main-anchor.png \
  --request-id shot-001 \
  --json
```

ローカルファイルのコピー、manifestへのanchor/speaker追加、任意requestのI2V化だけを行い、生成やGate更新は行いません。`negative.txt` は保存しますが、現行PixVerse video CLIに対応引数がないため黙って適用しません。詳しくは [Shitate連携](docs/shitate.md) を参照してください。

## ブログ掛け合いテンプレート

`templates/blog-dialogue-60s/` は、記事の出典、60秒台本、オリジナル柴犬pose、話者画像、字幕図解を `manifest.json` へまとめるstarterです。

```sh
cp -R templates/blog-dialogue-60s projects/my-article-dialogue
node projects/my-article-dialogue/build-manifest.mjs projects/my-article-dialogue
bin/pipeline validate --config projects/my-article-dialogue/project.yaml --json
bin/pipeline plan --config projects/my-article-dialogue/project.yaml --json
bin/pipeline run --config projects/my-article-dialogue/project.yaml --dry-run --json
```

ユーザー提供キャラクターはローカルslotへ置きます。音声/BGMが空の状態は字幕付き無音ドラフトで、非dry-runの `run` / `render` は通常どおり明示承認が必要です。

## Q&A掛け合いテンプレート

`templates/qa-dialogue/` は FAQ の `qa_list` から、QUESTION/ANSWER カード付きの16:9掛け合い manifest を決定的に生成します。

```sh
cp -R templates/qa-dialogue projects/my-faq
node projects/my-faq/build-manifest.mjs projects/my-faq
bin/pipeline validate --config projects/my-faq/project.yaml --json
bin/pipeline plan --config projects/my-faq/project.yaml --json
bin/pipeline run --config projects/my-faq/project.yaml --dry-run --json
```

`qa.json` を編集して `build-manifest.mjs` を再実行するだけで尺・字幕・チャプターが更新されます。無音の間は `draft: true` のままにしてください。

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

基本ループは次の通りです。

1. `projects/` に project を作る。
2. Gate 承認後にだけ生成または組み立てを実行する。
3. 出力を見て、良かった点、失敗した点、やり直した理由を書く。
4. 一回限りのメモはその project 内に残す。
5. 繰り返し使う教訓だけを examples、templates、adapter/backend constraints、validate/doctor、tests/fixtures、運用ルール、公開契約に昇格する。

昇格の目安:

```text
一回限りの好み        -> projects/<job>/notes.md
何度も使う好み        -> examples/ or templates/
機械的に防げる失敗    -> constraints.yaml / validate / doctor + tests/fixtures
判断系の運用ルール    -> LESSONS.md -> SKILL.md / CLAUDE.md / AGENTS.md
QA の判定ルール       -> Gate 2 / Gate 3 checks + report schema/tests
公開契約の変更        -> README / manifest/schema.md / docs/requirements.md
```

昇格時は、失敗の再現 fixture とテスト、または人間が読む運用ルールのどちらかを必ず残します。Gate 2 / Gate 3 の判定を増やす場合は、report の形とテストも一緒に更新します。

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
- `npm run check` はvendor boundary、TypeScript build、全テストに加え、`src/`のstatements / branches / functions / linesが各80%以上であることを強制します。
- この workspace path には `*` が含まれるため、Vite が警告する場合があります。現在この path でも tests は通りますが、運用上ノイズになる場合は `*` を含まない path に repo を移してください。
