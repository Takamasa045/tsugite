# Character Gallery — Goal & Agent Plan

## Goal（一文）

ランチャーに **仕立て非依存のキャラクターギャラリー** を追加し、プロジェクト／テンプレートの `speakers[]` を視覚一覧し、ユーザーが選んだ **具体 source（sourceKey + speakerId）** のキャラを既存プロジェクトへ **画像コピー + manifest 追記** できるようにする。

## 完了条件

1. **Phase 0**: `src/platform/fsSafe.ts` に `writeAtomic` / `containedFile` / `isWithin` / `portableRelative` / `sha256File` / `pathExists` を挙動そのまま抽出。`shitate.ts` は import 切替 + issue ラップ。`test/shitate-import.test.ts` green。
2. **Phase 1–2**: `src/characters/{types,scan,aggregate,addToProject}.ts` と対応テスト green。missing pose は表示可・「使う」拒否。競合は上書き禁止。
3. **Phase 3**: `GET /api/characters` / `GET|HEAD /character-image/:key` / `POST /api/characters/use`。desktop (`allowProjectActions: false`) でも専用 endpoint で動く。
4. **Phase 4**: `characters` 棚 UI（カード／詳細／Use dialog）。遅延 fetch + token 付き POST。
5. **Phase 5**: `node bin/pipeline character-add ...`（`safety: "local-write"`）、README/CHANGELOG。
6. 検証: `npm test` → `npm run typecheck` → `npm run build` → `npm run check`。手動: launcher で characters タブ → scratch へ追加 → accent 変更 conflict → validate green。

## 非ゴール

- 仕立てリポジトリへの依存・`src/characters` から `shitate.ts` への依存
- speaker の上書きマージ／ギャラリー側での自動選択「ベスト1つだけ」強制
- launcher 内部の `projectDirectories` を export すること

## Worktree

- path: `/Users/takamasa/Projects/*開発/tsugite-character-gallery`
- branch: `codex/character-gallery`（基点 `origin/main` @ 276dde9）
- main 側の未コミット変更（LESSONS / remotion）には触れない

## 依存グラフとエージェント割当

```
Phase 0 (fsSafe)  ──►  Phase 1 (types/scan/aggregate)  ──►  Phase 2 (addToProject)
                              │                                    │
                              └──────────────┬─────────────────────┘
                                             ▼
                                    Phase 3 (launcher API)
                                       │            │
                                       ▼            ▼
                                  Phase 4 (UI)   Phase 5 (CLI/docs)
```

| Agent | Phase | 担当 | 依存 |
|-------|-------|------|------|
| A | 0 | `src/platform/fsSafe.ts` 抽出 + shitate 切替 | なし |
| B | 1 | types/scan/aggregate + scan/aggregate テスト | A |
| C | 2 | addToProject + character-add テスト | A, B |
| D | 3 | launcherCharacters + launcher.ts wire | B, C |
| E | 4 | workflow-viewer character shelf UI | D（wire 形） |
| F | 5 | CLI character-add + docs | C |

## 共有制約（全エージェント）

- 日本語コメントは既存スタイルに合わせる。core にエンジン固有名を入れない。
- TDD: 各モジュールにテストを先または同時に書く。
- 非 ASCII speaker id → コピー先 dir は sanitize（safe ならそのまま、さもなくば `char-<sha8>`）。
- Windows: path は常に `/`、走査ホットパスで per-file realpath を避ける。
- provenance は passthrough（`source.kind`）。表示は kind 汎用。
- missing pose: スキャン表示は可、「使う」は拒否。
- ファイルは小さく（各 <400 行目安）。
- `run` / `render` / Gate 承認は不要（本タスクはコード実装のみ）。
- コミットはユーザー明示指示があるまでしない。

## 参照ポイント（基点コード）

- `src/integrations/shitate.ts`: writeAtomic:564, containedFile:613, isWithin:625, portableRelative:635, sha256:644, pathExists:648, prepareProject:272, writeSnapshot:464, speaker 追記:355 付近
- `src/viewer/launcher.ts`: mutation 認可:629, /thumbnail/:id:701, /api/templates:1128, helpers (readJsonRequest / openContainedStaticFile / matchesProjectIdentity)
- `apps/workflow-viewer/src/app/LauncherApp.tsx`: Shelf:141, SHELVES:257, 遅延ロード:613, token POST:692
- `apps/workflow-viewer/src/components/template/*`: UI 準拠先
- `test/shitate-import.test.ts`: createFixture パターン
- speaker schema: `src/manifest/schema.ts` speakers/poses/mouth_frames

## 検証コマンド（各 Phase 後）

```bash
# Phase 0
npx vitest run test/shitate-import.test.ts

# Phase 1–2
npx vitest run test/characters-scan.test.ts test/characters-aggregate.test.ts test/character-add.test.ts

# Phase 3
npx vitest run test/viewer-launcher-characters.test.ts

# Phase 4
npx vitest run apps/workflow-viewer --reporter=dot

# 全体
npm test && npm run typecheck && npm run build && npm run check
```
