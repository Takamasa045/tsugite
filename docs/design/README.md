# Tsugite 設計文書索引

このディレクトリでは、**現在実装済みの契約**と**次期版の実装予定契約**を分けて管理する。

## 現在実装済み

| 文書 | 状態 | 対象 |
| --- | --- | --- |
| [identity-lock-and-scene-consistency.md](./identity-lock-and-scene-consistency.md) | Phase A–E 実装済み | locked blocks、scene、variant、lineage lint |
| [identity-lock-m0-contract.md](./identity-lock-m0-contract.md) | 実装済み | Identity Lock Phase A の機械契約 |
| [template-direction.md](./template-direction.md) | 実装済み | template 方向性 |
| [template-variant-required-inputs.md](./template-variant-required-inputs.md) | 実装済み | variant ごとの必須入力 |

現行 H3 の実装契約は [../h3-prompt-director.md](../h3-prompt-director.md)、接続の正本は [../connections.md](../connections.md) を参照する。

## 次期版の設計

[production-orchestration-v1/](./production-orchestration-v1/) は、Tsugite を線形 run から、長期再開可能な階層 Task Tree へ移行するための**確定済み・未実装の設計パッケージ**である。

- まだ実装済みとは扱わない。
- `package.json` の version、Gate、生成接続、課金経路はこの文書を追加しただけでは変わらない。
- 実装は同パッケージの migration / acceptance criteria を Phase ごとに満たしたときだけ完了とする。
