# Tsugite Workflow Launcher / 3D Viewer

AIエージェントの制作案件を選び、木組みの3D工程図で確認するローカルアプリです。和紙、藍、青磁、杉を基調にした「墨庭の設計卓」として、装飾より工程の判読性を優先しています。

ランチャーは案件一覧、テンプレート、制作記録の更新、3D Viewerへの導線を提供します。動画・画像を生成する2Dノード操作画面は後続リリースへ延期しています。3D Viewerは`project.yaml`・実行状態・Gate/QC成果物をViewer JSONへ変換した、自己完結の静的・閲覧専用成果物です。

## 起動

前提: Node.js 22.12以上の22.x LTS / npm 10以上

```sh
cd apps/workflow-viewer
npm install
npm run dev
```

```sh
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run preview
```

## Tsugiteと連動する

Viewerの依存関係を一度インストールしたあと、リポジトリルートで実行します。

```sh
npm --prefix apps/workflow-viewer ci
npm run viewer:open
```

ブラウザの制作棚から案件を選ぶと、保存済みの制作状態を確認し、3D Viewerを更新して開けます。Desktop UIから`validate` / `plan` / `review` / `run` / `render` / Gate判定は実行しません。これらの制作操作は、既存の承認境界を守ってCLIから行います。

「最新状態に更新して開く」を押すと、現在の実行記録から3D Viewerを再生成して表示します。以前に生成済みなら「前回の表示を開く」も使えます。「テンプレート」タブでは、`templates/*/template.yaml` の用途・出力・必要素材を検索して比較できます。テンプレート棚は閲覧専用で、コピー・生成・実行は行いません。メタデータ契約は [テンプレートカタログ](../../docs/template-catalog.md) を参照してください。

ランチャーと成果物サーバーは、それぞれ動的に選ばれた `127.0.0.1` のポートだけで待ち受けます。LANや外部に公開するサーバーではありません。終了は起動したターミナルの `Ctrl+C` です。

特定の1案件だけを直接生成して開く場合は、従来どおり次を使います。

```sh
node bin/pipeline viewer --config projects/my-first-run/project.yaml --open --json
```

既定では `dist/<run-id>/viewer/` に `index.html`、`workflow.json`、静的アセットを出力します。`--state-dir` で実行状態の参照先、`--output` で3D Viewer出力先を変更できます。3D Viewer生成は `state.json` やGateを変更しません。3D側のスナップショットを更新するには、コマンドを再実行するか、ランチャーの「最新状態に更新して開く」を使います。

タイムラインは、保存済みのイベント履歴ではなく、`plan` の工程順と現在の `state.json`、`review/`、`gate2-qc.json`、`gate3-qc.json` から決定的に再構成します。`run-log.md` が存在する場合は、実行モード、素材数、実績クレジット、生成リクエスト別の試行結果を制作マニフェスト統合ノードのログへ表示します。

## 技術構成

- React / TypeScript / Vite
- Tailwind CSS
- Three.js / React Three Fiber / Drei
- Zustand
- Lucide React
- Vitest / Testing Library

## 構成

```text
src/
├── app/          # 画面統合とショートカット
├── components/   # layout / workflow / scene
├── data/         # 固定サンプルJSONと一覧
├── hooks/        # タイムライン再生
├── lib/          # 検証・状態導出・配置・集計
├── store/        # 画面と再生の共有状態
├── styles/       # Tailwind入口と固有スタイル
└── types/        # JSON契約
```

## サンプルJSONを追加する

1. `src/data/` に `.json` を追加します。
2. `src/data/index.ts` で読み込み、サンプル一覧へ登録します。
3. `npm test` を実行し、ID・参照・時刻・循環の検証を通します。

最小構造:

```json
{
  "id": "workflow-example",
  "name": "Example workflow",
  "status": "running",
  "duration": 60,
  "nodes": [
    {
      "id": "task-1",
      "name": "要件整理",
      "type": "task",
      "status": "pending",
      "progress": 0,
      "position": { "layer": 0, "order": 0 },
      "inputs": [],
      "outputs": ["requirements.md"],
      "logs": []
    }
  ],
  "edges": [],
  "events": [
    { "time": 0, "nodeId": "task-1", "status": "running" },
    { "time": 20, "nodeId": "task-1", "status": "completed", "progress": 100 }
  ]
}
```

`position` を省略した場合は、依存エッジから左→右の階層を計算します。不正な参照、重複ID、未定義ステータス、範囲外時刻、循環参照はエラーとして画面に表示されます。

人向けの工程説明には、ノードの任意フィールド `details` を使用します。`purpose`（目的）、`activity`（実施内容）、`outcome`（結果）、具体的な `inputs` / `outputs` を指定すると、技術IDより先に日本語の説明が表示されます。承認ノードでは `approval.subject`、`approval.checkpoints`、`approval.decision`、任意の `approval.decidedAt` を追加すると、「何を承認するか」「何を確認したか」「どう判断したか」を工程台帳に表示できます。Tsugite CLIが生成するスナップショットでは、project.yaml、実行ログ、Gate状態、Gate 2/3 QCからこれらを自動作成します。

## ステータス

`pending` / `queued` / `thinking` / `running` / `waiting_approval` / `testing` / `completed` / `error` / `skipped`

色だけでなく、ラベル、形状、リングや発光の動きでも区別します。`prefers-reduced-motion` が有効な環境では反復アニメーションを抑えます。

## 操作

- ドラッグ: 回転
- 右ドラッグまたはShift+ドラッグ: 平行移動
- ホイール: ズーム
- ノードクリック: 詳細表示
- 3Dラベルクリック: 右の工程台帳に詳細表示
- 下部の工程梁をクリック: 右の工程台帳に、その時点の作業内容・入出力・前後工程・作業記録を表示（再生時刻は変更しません）
- ノードをダブルクリック: フォーカス
- 空白クリック / `Escape`: 選択解除
- `Space`: 再生 / 一時停止
- `←` / `→`: タイムラインを移動
- `R`: カメラをリセット

## 現在の制限

- ランチャーは3D Viewerを更新した時点の保存済み状態を表示します。プロバイダーのリアルタイム進捗配信ではありません。
- 3D Viewerは生成時点の静的スナップショットです。
- 任意のローカルJSON選択、YAMLの直接読込、GitHub連携は未対応です。
- 自由編集、任意コマンド、共有、認証、複数ユーザー、VRは対象外です。
- 目標規模は約30ノードです。100ノード以上ではInstancedMesh等の再設計が必要です。

## 将来構想

ローカルJSON/YAML読込、実行結果比較、ボトルネック分析、プロバイダー進捗配信、制作物プレビュー、一人称の歩行モードを段階的に追加できます。データ検証・時点状態導出・3D表示を分離しているため、表示側を変えずに入力手段を拡張できます。
