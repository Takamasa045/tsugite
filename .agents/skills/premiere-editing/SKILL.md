---
name: premiere-editing
description: Premiere Proで既存動画をカット、トランジション、音声、字幕、色調整するときに使う。Tsugite案件の任意の外部編集、または独立したローカル編集を、MCPと画面確認で進める。Premiereを指定しない一般制作やコード保守では発動しない。
---

# Premiere Editing

日本語で簡潔に進める。既存の依頼・好み・承認を引き継ぎ、編集方針の確認を繰り返さない。

## 入口と承認

- Premiereが指定されたときの任意の編集入口。基本セットアップの必須依存にしない。
- Tsugite案件では [制作Skill](../tsugite/SKILL.md) を読み、対象の `project.yaml`、現在のrun、承認済みreview、素材・出力を一致させる。実編集はCoordinatorだけが対象編集への承認後に行う。Planner / Reviewer / Output QAはPremiereでも読み取り・提案まで。
- pipeline中の案件は現在のGateと承認済み計画の範囲を守る。Premiereを経由してGate前の生成・組み立て・書き出しを代行しない。承認済み内容を変えるならreviewと該当Gateを取り直す。
- `edit.backend: premiere` は未実装。Premiereはエージェントが操作する外部エディタであり、`pipeline render` のbackendではない。MCPや画面操作がpipeline stateを強制する仕組みではないため、エージェントが実行前に承認を照合する。
- 明示的な独立編集・接続テストには架空の `project.yaml` やGate stateを作らない。対象のコピーに限定し、その結果をTsugiteのGate承認・制作完了として報告しない。
- 書き出し、既存成果物の上書き、外部共有、生成機能の課金は編集指示だけから推定しない。明示された範囲の既存承認は再利用する。

## 接続と対象の確定

1. [接続手順](../../../docs/premiere-pro.md) に従う。利用可能なら `tsugite-premiere` MCPを使い、別名登録の同じサーバーが既にあれば再利用する。未導入なら導入内容を確認してから必要な設定だけ行う。
2. `get_capabilities` → `ping` → `get_project_info` / `get_active_sequence` で実機と対象を確認する。開いている無関係な案件を切り替えたり保存したりしない。空のPremiereではproject/sequence不在は接続失敗と区別する。
3. 初回編集は保存済み `.prproj` のコピー、または新規の別名案件で行う。Tsugite案件の `.prproj`、素材コピー、編集記録はdurable projects homeの対象案件内に置く。Downloadsや一時worktreeの唯一のコピーへ依存させない。
4. `get_full_sequence_info` 等で尺・fps・音声・クリップ境界・素材範囲・offlineを読む。構造変更後はIDを取り直す。接続、カタログ掲載、ツール成功、実際の編集結果を別々に判断する。

## 編集の判断

[演出ガイド](references/editorial-guide.md) を必要な範囲で読み、目的・参考映像・素材に合わせて選ぶ。まず「どの箇所に、何のために、何秒／何フレームの編集をするか」を短く示す。ユーザーが演出を任せている場合は小さな編集案を自分で決め、不要な選択質問を増やさない。Gateが必要なら具体的なreviewを用意してから判断を受ける。

- 構成やカット順を提案するTsugite案件では `story-guides` を参照する。既存の一接続点へ効果を追加するだけなら、全体構成やIdentity Lockを始め直さない。
- トランジション名・利用可能な効果・字幕や音声の対応はそのホストで確認する。名称の日本語／英語差や空カタログを成功と扱わない。
- 編集案には映像だけでなくリンク音声、隣接素材の余白、字幕の時刻への影響も含める。フレーム境界で指定し、全カットへの効果一括適用を既定にしない。

## 操作とフォールバック

1. MCPで対象を読み、最小の変更を行い、すぐ読み戻す。比較対象はクリップ数、start/end、source in/out、速度、音声同期、必要なtransition/effectの存在。
2. 複合編集では上流の `preview_edit_plan` 等を利用できる範囲で使う。ただしMCPのconfirmation tokenはTsugiteのGate承認ではない。
3. **Premiere 26.2 + premiere-pro-mcp 1.14.9 の実測制限:** `trim_clip` がsource outだけを変え、timeline endを変えない事例がある。source outの変更や `success` だけで完了にしない。前後のsource範囲とtimeline尺の整合を必ず照合する。
4. 不一致やエラーで後続操作が未知の状態に依存する場合、止めて再読する。同じ変更を盲目的に再送しない。UndoがそのMCP操作を戻すとは限らない。復旧は保存済みコピーとの照合を優先し、別操作をUndoしたらその事実を確認して復元する。
5. 利用可能なComputer Useで、同じ承認済み編集を行える。画面から対象・フォーカスを確認し、操作後に画面とMCPを読み戻す。Macの実測ではMCPで再生ヘッドを81秒に合わせ、タイムラインへフォーカスしてWで末尾を短縮し、映像・音声の終端一致を確認できた。Wや座標を別環境の固定手順にしない。
6. GUIでも確かめられなければ、未完了の箇所と復旧状態を報告する。利用できない操作を別の有料サービスやrawスクリプトで勝手に代替しない。`unsafe-script` 等の拡張権限を自動で有効化しない。

## 保存とQA

- 指定先へ保存し、保存済みファイルの存在を確認する。初回連携や重要な構造変更では、保存後に閉じて再オープンし、配置・source範囲・素材onlineを照合する。
- Premiereで再生し、変更箇所の前後、トランジション中のフリーズ／黒フレーム、字幕位置、終端を確認する。音声メーターの動作と聴感評価を混同しない。
- 記録は対象案件の `premiere/` に残す。アプリ／MCP版、元と作業用project、編集意図、前後のtimecode、実機読み戻し、GUI確認、失敗と復旧、未確認項目を含める。秘密情報や無関係な素材情報は残さない。
- 書き出す場合は別名出力を既定とし、出力ファイルをメディア検査・再生してから報告する。明示された上書き依頼があれば、旧版をバックアップして別名で新版を検証し、必要なGate／新版承認を満たしてから指定先への置換を行う。同じ上書き承認を再質問せず、別名出力だけで依頼を完了扱いにしない。`.prproj` 保存、書き出し要求受付、書き出し完了、視聴QAは別の結果。
- 既存のGate 3承認済み動画をPremiereで変えた場合、新版は未承認の別成果物。旧QAや承認を流用せず、既存の正式フローで扱えない外部出力をstate/manifestの手編集で完成扱いにしない。

## 参照

- このSkillはTsugite独自の手順。上流の [edit-premiere-project](https://github.com/leancoderkavy/premiere-pro-mcp/tree/main/plugins/premiere-pro/skills/edit-premiere-project) を参考に、承認境界と実機失敗から構成した。上流Skillの自動インストールや汎用的な全機能対応を意味しない。
