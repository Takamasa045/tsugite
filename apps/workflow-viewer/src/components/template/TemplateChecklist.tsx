import { Check, ClipboardCopy, Sparkles } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import {
  EXPRESSION_SELECTION_COMBINE_NOTE,
  capabilityLabel,
  expressionRoleLabel,
  formatExpressionCandidatesPromptSection,
  previewFidelityLabel,
  selectionModeLabel,
  type ExpressionSelection,
  type ExpressionSelectionMode,
} from '../expression/expressionLibraryModel'
import { ExpressionFreeformExport } from '../expression/ExpressionFreeformExport'
import {
  buildTemplateProductionPrompt,
  materialDeliveryInstruction,
  optionLabelFor,
  partitionRequiredInputs,
  requiredMaterialNotices,
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
  expressionSelections?: readonly ExpressionSelection[]
  expressionSelectionMode?: ExpressionSelectionMode
  /** 表現棚を開く（埋め込み catalog の代わり） */
  onOpenExpressions?: () => void
}

const CLIPBOARD_WRITE_TIMEOUT_MS = 1_500

function copyWithHiddenTextarea(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false

  // textarea.select() moves focus; restore the caller after remove so Chromium
  // does not leave focus on body (copy success/fail and generation stay unchanged).
  const previousActive = document.activeElement
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('aria-hidden', 'true')
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.append(textarea)
  textarea.select()

  try {
    return document.execCommand('copy')
  } finally {
    textarea.remove()
    if (
      previousActive instanceof HTMLElement
      && previousActive.isConnected
    ) {
      previousActive.focus({ preventScroll: true })
    }
  }
}

function writeClipboardText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('Clipboard write timed out'))
    }, CLIPBOARD_WRITE_TIMEOUT_MS)

    Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(
      () => {
        window.clearTimeout(timeout)
        resolve()
      },
      (error) => {
        window.clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

export function TemplateChecklist({
  template,
  choices,
  expressionSelections = [],
  expressionSelectionMode = 'unset',
  onOpenExpressions,
}: TemplateChecklistProps) {
  const headingId = useId()
  const detailsId = useId()
  const expressionHeadingId = useId()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  // 制作依頼本文には表現選択を一切混ぜない（表現は別プロンプトとしてコピー）
  const productionPrompt = useMemo(
    () => buildTemplateProductionPrompt(template, choices),
    [choices, template],
  )
  const expressionPrompt = useMemo(
    () => formatExpressionCandidatesPromptSection({
      mode: expressionSelectionMode,
      selections: expressionSelections,
    }),
    [expressionSelectionMode, expressionSelections],
  )
  const resolvedInputs = useMemo(
    () => resolveRequiredInputDetails(template, choices),
    [choices, template],
  )
  const { required, optional } = useMemo(
    () => partitionRequiredInputs(resolvedInputs),
    [resolvedInputs],
  )
  const materialNotices = useMemo(
    () => requiredMaterialNotices(required),
    [required],
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
  /** Bumps when productionPrompt changes; only matching generation may settle copy UI. */
  const copyGenerationRef = useRef(0)
  const productionPromptRef = useRef(productionPrompt)
  productionPromptRef.current = productionPrompt
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [template.id])

  // Prompt body change invalidates in-flight copy UI (stale A must not overwrite B).
  useEffect(() => {
    copyGenerationRef.current += 1
    setCopyState('idle')
  }, [productionPrompt])

  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [copyState])

  async function handleCopy() {
    // Snapshot body at click; generation must still match on settle.
    const generation = copyGenerationRef.current
    const textSnapshot = productionPrompt
    const settleIfCurrent = (next: 'copied' | 'failed') => {
      if (generation !== copyGenerationRef.current) return
      if (textSnapshot !== productionPromptRef.current) return
      setCopyState(next)
    }
    try {
      // ローカルのアプリ内ブラウザでは Clipboard API が応答しない場合がある。
      // ユーザー操作中に使える同期コピーを先に試し、未対応なら標準 API へ戻す。
      if (copyWithHiddenTextarea(textSnapshot)) {
        settleIfCurrent('copied')
        return
      }
      await writeClipboardText(textSnapshot)
      settleIfCurrent('copied')
    } catch {
      settleIfCurrent('failed')
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="launcher-template-checklist"
    >
      <div className="launcher-template-checklist-heading">
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>制作依頼ができました</h2>
        <p>
          {template.name} の制作依頼です。先に必須素材を確認し、本文と一緒に画像やファイルを渡してください。
        </p>
      </div>

      <section
        aria-label="コピー前に用意する必須素材"
        className="launcher-template-checklist-handoff"
        role="region"
      >
        <div className="launcher-template-checklist-handoff-heading">
          <span>コピーする前に</span>
          <h3>この制作依頼と一緒に渡す素材</h3>
          <p>
            画像やファイル自体はコピーされません。貼り付け先の会話へ添付するか、
            AIが参照できるファイルパスを伝えてください。
          </p>
        </div>
        {required.length > 0 ? (
          <ul className="launcher-template-handoff-materials">
            {required.map((input) => (
              <li key={`handoff-${input.type}-${input.label}`}>
                <b>{TEMPLATE_INPUT_TYPE_LABELS[input.type]}</b>
                <div>
                  <strong>{input.label}</strong>
                  <span>{materialDeliveryInstruction(input)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="launcher-template-handoff-empty">必須の素材指定はありません。</p>
        )}
        <ul className="launcher-template-handoff-notices">
          {materialNotices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby={expressionHeadingId}
        className="launcher-template-checklist-expressions"
        role="region"
      >
        <div className="launcher-template-checklist-expression-heading">
          <h3 id={expressionHeadingId}>選んだ表現</h3>
          <p>
            表現棚で選んだコピー候補です。{EXPRESSION_SELECTION_COMBINE_NOTE}
            制作依頼本文とは別の表現プロンプトとしてコピーできます。
            巨大な一覧の埋め込みは置かず、表現タブへ移動して選びます。
          </p>
        </div>
        <p className="launcher-template-expression-state" role="status">
          状態: {selectionModeLabel(expressionSelectionMode)}
        </p>
        {expressionSelections.length === 0 ? (
          <p className="launcher-template-expression-state">
            まだコピー候補を明示選択していません。
          </p>
        ) : (
          <ul className="launcher-template-expression-selection-list">
            {expressionSelections.map((selection) => (
              <li key={selection.key}>
                <strong>{selection.title}</strong>
                <small>{expressionRoleLabel(selection.role)}</small>
                <small>{selection.provider} / {selection.nativeId}</small>
                <small>{capabilityLabel(selection.capability)}</small>
                <small>{previewFidelityLabel(selection.previewFidelity)}</small>
                <span>{selection.reason}</span>
              </li>
            ))}
          </ul>
        )}
        <ExpressionFreeformExport
          exportText={expressionPrompt}
          heading="選んだ表現のプロンプト"
          description="制作依頼本文には自動では入りません。下のボタンを押したときだけ、表現プロンプトをローカルにコピーします。"
          previewLabel="選んだ表現のプロンプト"
          copyLabel="表現プロンプトをコピー"
        />
        {onOpenExpressions && (
          <button
            className="launcher-secondary"
            data-expression-return-trigger=""
            data-template-id={template.id}
            onClick={onOpenExpressions}
            type="button"
          >
            <Sparkles aria-hidden="true" size={16} />
            コピー候補を変更
          </button>
        )}
        {!onOpenExpressions && (
          <p className="launcher-template-expression-state">
            上部ナビの「表現」タブからコピー候補を選べます。
          </p>
        )}
      </section>

      <div className="launcher-template-checklist-primary">
        <button
          className="launcher-primary"
          onClick={() => void handleCopy()}
          type="button"
        >
          {copyState === 'copied' ? (
            <>
              <Check aria-hidden="true" size={16} />
              制作依頼をコピーしました
            </>
          ) : (
            <>
              <ClipboardCopy aria-hidden="true" size={16} />
              制作依頼だけをコピー
            </>
          )}
        </button>
        <p className="launcher-template-checklist-copy-scope">
          目的・選択内容・必須素材・制作条件だけをコピーします。
          表現プロンプトは上の「表現プロンプトをコピー」から別にコピーしてください。
          任意素材や「向かない用途」はコピーしません。
        </p>
        {copyState === 'failed' && (
          <p role="alert">
            制作依頼をクリップボードへコピーできませんでした。本文を選択して手動でコピーしてください。
          </p>
        )}
        {copyState === 'copied' && (
          <p aria-live="polite" className="launcher-template-checklist-copy-status">
            制作依頼をコピーしました
          </p>
        )}
      </div>

      <section
        aria-label="制作依頼 Markdown"
        className="launcher-template-checklist-brief"
        role="region"
      >
        <h3>そのまま貼れる制作依頼</h3>
        <pre aria-label="制作依頼本文">{productionPrompt}</pre>
      </section>

      <div className="launcher-readonly-note">
        <strong>閲覧専用</strong>
        <p>
          この画面では生成・実行・Gate更新をしません。制作依頼の控えコピーだけできます。
          コピー後、必須素材と一緒に制作担当のAIへ渡してください。
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

            {template.audio && (
              <section
                aria-label="音声と表示の注意"
                className="launcher-template-checklist-audio"
                role="region"
              >
                <h3>音声と表示の注意</h3>
                <p>{template.audio}</p>
              </section>
            )}
          </div>
        </div>
      </details>
    </section>
  )
}
