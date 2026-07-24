# テンプレートカタログ

ランチャーの「テンプレート」タブは、`templates/` 直下にある `template.yaml` を読み取り専用で表示します。メタデータは用途を比較するための説明であり、実行能力、利用権、Git公開可否を証明するものではありません。

## 配置

```text
templates/
└── my-template/
    ├── template.yaml
    ├── README.md
    └── project.yaml # 実行可能なテンプレートだけで使用
```

フォルダ名と `id` は一致させ、小文字英数字とハイフンだけを使います。`template.yaml` がない補助フォルダはカタログ対象外です。

## schema version 1

```yaml
schema_version: 1
kind: tsugite-template
id: my-template
name: サンプルテンプレート
summary: 何を入力すると、どのような動画になるかを一文で説明します。
category: 記事を動画化
use_cases:
  - ブログ記事
output:
  duration:
    mode: fixed
    min_seconds: 60
    max_seconds: 60
    label: 60秒
  aspect_ratios:
    - "16:9"
  speaker_count: 2
required_inputs:
  - type: text
    label: 記事本文
    required: true
starter:
  source: examples/local-fixture
  instructions: 同梱サンプルをコピーして、まずローカル素材だけで検証します。
tags:
  - 解説
audio:
  narration: optional
  bgm: optional
  silent_draft: true
  notes: 音声未指定時は無音ドラフトになります。
status: stable
distribution: local-only
```

`status` は `stable` / `experimental` / `deprecated`、`distribution` は `bundled` / `local-only` を指定します。`distribution` はランチャー上の表示区分であり、アクセス制御やGit公開判定には使用しません。

`starter` は任意です。`source` はリポジトリ内の `examples/` 配下だけを指定し、ランチャーには相対パスと説明だけを表示します。テンプレート本体がユーザー固有の素材を必要とする場合でも、検証可能な開始元を示せます。開始元は画面からコピー・実行されず、利用者が内容を確認してから手作業で使います。

親テンプレートは用途・入力・構成・制約を比較するためのカタログ項目です。`project.yaml` と素材を含むstarterとは区別し、実行前にはstarterをコピーして案件ごとの素材とmanifestを用意してください。

## 安全条件

- `template.yaml` は64 KiB以下の通常ファイルにし、symlinkを使用しない
- 未知フィールド、未知のschema version、ID不一致は無効として表示する
- APIはメタデータだけを返し、README全文、絶対パス、manifest、成果物を配信しない
- テンプレート棚からテンプレート・projectのコピー、生成、`run`、`render`、Gate更新は行わない
- 選択内容から作ったCodex向け依頼文だけを、利用者の操作でローカルクリップボードへコピーできる。外部送信や実行は行わない
