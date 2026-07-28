import { Check, ClipboardCopy } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import {
  buildTemplateBriefMarkdown,
  optionLabelFor,
  partitionRequiredInputs,
  resolveDirectionLines,
  resolveExampleLines,
  resolvePromptGuidesForBrief,
  resolveRequiredInputDetails,
  TEMPLATE_INPUT_TYPE_LABELS,
  type LauncherTemplate,
} from './templateShelfModel'

/** Final チェックリストが参照する最小 shape（テスト契約と API 応答の両方を受ける） */
export type TemplateChecklistTemplate = Pick<
  LauncherTemplate,
  | 'id'
  | 'name'
  | 'summary'
  | 'variants'
  | 'requiredInputDetails'
  | 'notFor'
  | 'audio'
  | 'direction'
  | 'promptGuideCatalog'
  | 'promptGuides'
>

export interface TemplateChecklistProps {
  template: TemplateChecklistTemplate
  choices: Readonly<Record<string, string>>
}

export function TemplateChecklist({ template, choices }: TemplateChecklistProps) {
  const headingId = useId()
  const detailsId = useId()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const brief = useMemo(
    () => buildTemplateBriefMarkdown(template, choices),
    [choices, template],
  )
  const resolvedInputs = useMemo(
    () => resolveRequiredInputDetails(template, choices),
    [choices, template],
  )
  const { required, optional } = useMemo(
    () => partitionRequiredInputs(resolvedInputs),
    [resolvedInputs],
  )
  const directionLines = useMemo(
    () => resolveDirectionLines(template, choices),
    [choices, template],
  )
  const exampleLines = useMemo(
    () => resolveExampleLines(template, choices),
    [choices, template],
  )
  const promptGuides = useMemo(
    () => resolvePromptGuidesForBrief(template, choices),
    [choices, template],
  )
  const goodExamples = exampleLines.filter((entry) => entry.kind === 'good')
  const monoExamples = exampleLines.filter((entry) => entry.kind === 'monotonous')
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [template.id])

  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [copyState])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(brief)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="launcher-template-checklist"
    >
      <div className="launcher-template-checklist-heading">
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>制作プロンプトができました</h2>
        <p>
          {template.name} の制作プロンプトです。コピーして README の手順で案件を用意してください。
          この画面では生成・実行・Gate更新はしません。
        </p>
      </div>

      <div className="launcher-template-checklist-primary">
        <button
          className="launcher-primary"
          onClick={() => void handleCopy()}
          type="button"
        >
          {copyState === 'copied' ? (
            <>
              <Check aria-hidden="true" size={16} />
              プロンプトをコピーしました
            </>
          ) : (
            <>
              <ClipboardCopy aria-hidden="true" size={16} />
              プロンプトをコピー
            </>
          )}
        </button>
        {copyState === 'failed' && (
          <p role="alert">
            プロンプトをクリップボードへコピーできませんでした。本文を選択して手動でコピーしてください。
          </p>
        )}
        {copyState === 'copied' && (
          <p aria-live="polite" className="launcher-template-checklist-copy-status">
            プロンプトをコピーしました
          </p>
        )}
      </div>

      <section
        aria-label="制作プロンプト Markdown"
        className="launcher-template-checklist-brief"
        role="region"
      >
        <div className="launcher-template-checklist-brief-toolbar">
          <h3>制作プロンプト本文</h3>
          <button
            className="launcher-secondary"
            onClick={() => void handleCopy()}
            type="button"
          >
            {copyState === 'copied' ? (
              <>
                <Check aria-hidden="true" size={16} />
                プロンプトをコピーしました
              </>
            ) : (
              <>
                <ClipboardCopy aria-hidden="true" size={16} />
                プロンプトをコピー
              </>
            )}
          </button>
        </div>
        <pre aria-label="プロンプト本文">{brief}</pre>
      </section>

      <div className="launcher-readonly-note">
        <strong>閲覧専用</strong>
        <p>
          この画面では生成・実行・Gate更新をしません。制作プロンプトの控えコピーだけできます。
          控えたら README の手順で制作案件を用意してください。
        </p>
      </div>

      <details className="launcher-template-checklist-details">
        <summary id={detailsId}>素材・演出の詳細を見る</summary>
        <div
          aria-labelledby={detailsId}
          className="launcher-template-checklist-body"
        >
          <section className="launcher-template-checklist-summary" aria-label="選択の要約">
            <h3>選択内容</h3>
            <dl>
              <div>
                <dt>動画</dt>
                <dd>{template.name}</dd>
              </div>
              {template.variants.map((variant) => {
                const optionId = choices[variant.id]
                const label = optionId
                  ? optionLabelFor(template, variant.id, optionId) ?? optionId
                  : '（未選択）'
                return (
                  <div key={variant.id}>
                    <dt>{variant.label}</dt>
                    <dd>{label}</dd>
                  </div>
                )
              })}
            </dl>
          </section>

          <div className="launcher-template-checklist-materials">
            {directionLines.length > 0 && (
              <section
                aria-label="演出指針"
                className="launcher-template-checklist-direction"
                role="region"
              >
                <h3>演出指針</h3>
                <ul className="launcher-template-guidance-list">
                  {directionLines.map((entry) => {
                    const label = entry.source
                      ? `${entry.label}（${entry.source}）`
                      : entry.label
                    return (
                      <li key={`${label}-${entry.text}`}>
                        <b>{label}</b>
                        <span>{entry.text}</span>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {(goodExamples.length > 0 || monoExamples.length > 0) && (
              <section
                aria-label="具体例"
                className="launcher-template-checklist-examples"
                role="region"
              >
                <h3>具体例</h3>
                {goodExamples.length > 0 && (
                  <div className="launcher-template-example-block">
                    <h4>良い例</h4>
                    <ul>
                      {goodExamples.map((entry) => (
                        <li key={`good-${entry.optionLabel}-${entry.text}`}>
                          <b>{entry.optionLabel}</b>
                          <span>{entry.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {monoExamples.length > 0 && (
                  <div className="launcher-template-example-block launcher-template-example-block-mono">
                    <h4>単調な例（避ける）</h4>
                    <ul>
                      {monoExamples.map((entry) => (
                        <li key={`mono-${entry.optionLabel}-${entry.text}`}>
                          <b>{entry.optionLabel}</b>
                          <span>{entry.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}

            {promptGuides.length > 0 && (
              <section
                aria-label="生成プロンプトの書式"
                className="launcher-template-checklist-guides"
                role="region"
              >
                <h3>生成プロンプトの書式</h3>
                {promptGuides.map((guide) => (
                  <div
                    className="launcher-template-guide-block"
                    key={guide.catalogId}
                  >
                    <h4>{guide.displayName}（{guide.catalogId}）</h4>
                    <p className="launcher-template-guide-disclaimer">{guide.disclaimer}</p>
                    <ul>
                      {guide.checklist.map((rule) => (
                        <li key={rule.id}>{rule.instruction}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            )}

            <section aria-label="必須の用意するもの" className="launcher-template-requirements" role="region">
              <h3>必須</h3>
              {required.length > 0 ? (
                <ul className="launcher-template-materials">
                  {required.map((input) => (
                    <li key={`required-${input.type}-${input.label}`}>
                      <b>{TEMPLATE_INPUT_TYPE_LABELS[input.type]}</b>
                      <span>{input.label}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>必須の素材指定はありません。</p>
              )}
            </section>

            <section aria-label="任意の用意するもの" className="launcher-template-requirements" role="region">
              <h3>任意</h3>
              {optional.length > 0 ? (
                <ul className="launcher-template-materials">
                  {optional.map((input) => (
                    <li key={`optional-${input.type}-${input.label}`}>
                      <b>{TEMPLATE_INPUT_TYPE_LABELS[input.type]}</b>
                      <span>{input.label}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>任意の素材指定はありません。</p>
              )}
            </section>

            {template.notFor.length > 0 && (
              <div
                aria-label="向かない用途の警告"
                className="launcher-template-checklist-warning"
                role="status"
              >
                <strong>向かない用途</strong>
                <ul>
                  {template.notFor.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </details>
    </section>
  )
}
