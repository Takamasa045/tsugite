# M0 契約: Identity Lock Phase A

**状態:** Phase A 実装完了 + スキル配線済み  
**親設計:** `docs/design/identity-lock-and-scene-consistency.md`  
**エージェント手順:** `.agents/skills/tsugite/SKILL.md` → Identity Lock Protocol（自然言語向け）

## North-star

長尺制作でキャラの声・外見・manner 記述を verbatim 固定し、ハッシュで改変を止める。Gate 自動承認・課金実行は触らない。

## 後方互換マトリクス

| 入力 | validate | render |
|---|---|---|
| 現行最小 IR（locked_blocks なし） | ok | 既存とバイト同等 |
| dialogue `lock_text` のみ | ok | 既存と同等（H3-E007 維持） |
| locked_blocks 正しい text+sha256 | ok | 原文が prompt に exact 含有 |
| text 改変・sha256 古い | **error LOCK-E001** | compile 失敗 |

## Issue 表（Phase A）

| code | severity | 層 | Gate 影響 |
|---|---|---|---|
| `LOCK-E001` | error | validate（renderer 非依存） | なし（実行非連動） |

## 注入点

| フィールド | H3 grammar | plain-prompt |
|---|---|---|
| `voice` | `renderDialogueBlock` 内、speaker 説明の直後に verbatim | 同左（共有 helper） |
| `appearance` / `manner` | 対話ショットの `renderShotBody` 末尾、および reference の `subject_definitions` | plain ショット本文末尾 |

ラベル（Phase D 骨格前の暫定）:

- `VOICE:` + 原文
- `CHARACTER APPEARANCE:` + 原文
- `CHARACTER MANNER:` + 原文

## Lineage 拡張（optional）

```ts
locked_block_hashes?: Record<string, string>  // "hero.voice" → sha256 hex
```

既存フィールドは不変。キー無しなら lineage にフィールドを出さない。

## RED テスト（Phase A）

1. `locked_blocks.voice` sha256 mismatch → `LOCK-E001`
2. 正しい locked の voice/appearance/manner が compile 出力に exact substring
3. locked_blocks なし IR は P0 golden と一致
4. plain 経路でも mismatch が error になる
5. `lock-block` CLI が sha256 を書き戻し、無関係フィールドを保持

## CLI 境界

`bin/pipeline lock-block` は **local-write**。

- project.yaml の IR 内 locked_blocks のみ更新
- Gate / run / render / 課金を起動しない
- YAML は `parseDocument` + `setIn` + `writeAtomic`（Zod dump しない）
