# よく出てくる言葉

入口の [README.ja.md](../../README.ja.md) では 5〜7 語だけ載せています。こちらが正式名つきの一覧です。コマンド名・キー名・ファイル名は訳しません。

| 平易な言い方 | 正式名 | 意味 |
| --- | --- | --- |
| 制作案件 | `project`（`project.yaml`） | 1本の動画のフォルダと設定。ランチャーは必須フィールド `name` で一覧します。 |
| 計画の確認 / 素材の確認 / 完成の確認 | Gate 1 / Gate 2 / Gate 3 | 人が OK するまで次へ進まない確認。案件が `gates.gate_2.auto_pass: qc_ok_no_new_assets` を選び、課金・新しい素材・品質の指摘がすべて0のときだけ、Gate 2 は人のOKなしで通ります。課金や新しい素材が出るときは必ず止まります。ランチャーでは「Gate 1 確認画面を開く」「確認待ち」と出ます。 |
| 素材リスト | manifest | 使う映像・音・字幕と編集内容をまとめた制作データ。 |
| 生成サービスとの接続 | adapter | PixVerse や Kling など、選んだ生成手段とのつなぎ。未選択の provider は自動導入しません。 |
| 編集エンジン | backend | 手元で動画を組み立てるレンダラー（既定は Remotion）。`edit.backend` で選びます。 |
| 生成する / 書き出す | `run` / `render` | 生成はサービスにより課金。書き出しは手元で課金なしですが時間がかかります。どちらも Coordinator と事前の Gate 承認のあとだけです。 |
| 好み・学び | feedback | 直したポイントの記録。状態は記録（observed）→ 学習中（recurring）→ 反映済み（promoted）→ 効果確認済み（verified）。承認は反映作業の許可であり、prompt / template / rule を自動では変更しません。 |

関連する確認画面の言葉：制作案件、確認待ち、好み・学び。技術的な以前の説明は [docs/reference.ja.md](../reference.ja.md) です。
