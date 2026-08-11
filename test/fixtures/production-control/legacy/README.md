# PO-0 legacy baseline fixtures

このディレクトリは Production Orchestration v1 の PO-0 用 fixture-only baseline です。

- 対象は v0.9.x の project / Gate state / finalize retention / generation job / H3 artifact / Launcher public DTO です。
- 生成、render、provider traffic、課金、Gate更新、外部送信は行いません。
- `manifest.json` の `design_pack.documents` は、read-only design worktree から導入した12文書の byte SHA-256 です。
- JSON の canonical hash は `src/integrity/canonical.ts` の object key sort・array order保持規則で計算します。
- 絶対パス、secret、prompt本文、provider raw bodyは保存しません。必要な値が歴史資料に無い場合は `legacy_not_recorded` とします。
- `generation-job.json` の `submission_unknown` は、known provider job id が無い結果不明を表すだけで、再送許可を表しません。

この baseline は後続Phaseの候補 schemaではなく、既存実装の互換性を守るための読み取り専用の証拠です。
