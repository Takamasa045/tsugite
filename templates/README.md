# Templates

Reusable project shapes live here when an example is too specific and a blank starter is more useful.

Use `examples/` for copyable, working fixtures. Use `templates/` for reusable structures that still require user-specific media, prompts, or settings before validation. A template may point to a verified `examples/` starter in `template.yaml`; this does not make the launcher copy or execute anything.

Available templates:

- [`commerce-showcase/`](commerce-showcase/README.md): 商品・サービス、ブランド、EC、プロフィール、根拠を伴う課題解決型の紹介設計。
- [`creative-short/`](creative-short/README.md): 自作曲・キャラクターMV、マンガ調、15秒ショート、30秒CMの設計。
- [`explainer-talk/`](explainer-talk/README.md): 一人解説、二人掛け合い、講義、豆知識、セミナー告知の設計。
- [`footage-editorial/`](footage-editorial/README.md): 店舗・道順・駐車場案内、リール切り抜き、製品組み立てを含む実写編集の設計。
- [`local-video-two-cut/`](local-video-two-cut/README.md): 同梱のローカル素材だけで、2カットの検証・計画・dry-runを確かめる実行可能な安全スターター。

最初の4件は用途・必要素材・表現上の制約を選ぶ親テンプレートです。選択だけでproject、生成、Gate更新は行いません。実行を始めるときは、`local-video-two-cut` または案件に合う別の検証済みstarterをコピーし、素材とmanifestを案件ごとに用意してください。
