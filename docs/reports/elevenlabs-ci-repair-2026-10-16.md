# PR185 CI修復の証拠

対象branch: `codex/elevenlabs-hosted-oauth`。journal review r4290171354は別commit `7b45f77`、公開CLI review修復は`3416452`、時計fixture修復は`9809cce`。

## 時計

ae5d564のUbuntu CI 6失敗と、修正前の同名6件を比較した。PO5の2件・PO6の1件も、Resultのissuesを出して最初の失敗がcompileの`VPD-K001`（freshness期限切れ）だと確認した。PO4/8には後続`VPD-E031`もあった。既存のfixture時計2026-09-01を関連suiteと子CLIへ適用し、5ファイル141件成功。期限の直前・一致・直後の3件も成功。本番profileの期限と実時刻判定は変更していない。

## 依存

Node 22.23.2、npm 12.0.2。元repoのnode_modulesは変更せず、空のtask所有directoryへlock通りclean install（第三者install scripts無効）し、継手の固定HyperFrames patchを別途実行した。root buildとElevenLabs/OAuth/耐久化/公開CLI/依存API互換107件成功。siteも空のnode_modulesから導入しbuild/HTML・依存検証5件/lint成功。

root auditはmoderate 3/high 3/critical 1から全依存0へ。SDK 1.32.1、fast-uri 3.1.8、ip-address 10.7.4、selector-parser 7.1.6、proxy-addr 2.0.8、sharp 0.35.5、source-map-js 1.2.2を固定した。SDKは通常importと既存のdeep importを含むOAuth/transport経路をfixtureで検証した。専用OAuthは固定issuer/resourceを自身で検証し、SDKの自動authProviderを使わない。[SDK公式advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h)

siteはNext/eslint-config-next 16.4.2（要求下限16.3.8）、sharp 0.35.5、brace-expansion 5.0.12、fast-uri 3.1.8、undici 7.29.1、source-map-js 1.2.2へ更新。[Next公式advisory](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j)

**site全依存auditは未解決。** productionは0だが、`braces`のstack exhaustion（GHSA-vfj7-8cjw-p6xm）に由来する開発依存8件が残る。npm公式registryで最新bracesは3.0.3、auditの影響範囲は`<=3.0.3`。eslint Next plugin→fast-glob、およびvinext→commonjs/dynamic-import→micromatchの経路。監査閾値・既存検出器を変更せず、全依存0とは報告しない。新vinextはReact peer変更もあり、未検証majorへの強制置換はしていない。[advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)

## 制限

ローカルfull coverageは2回ともENOSPCで中断し、全体結果の証拠に使わない。root/siteのclean installと上記対象試験は別の成功証拠。全体coverage・Viewer・Windows最終stepの結果は、このheadのCIで別途確認する。追加の実課金provider callと新規OAuth権限は0。
