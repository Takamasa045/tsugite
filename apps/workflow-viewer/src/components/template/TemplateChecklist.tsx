import { Check, ClipboardCopy, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'

import {
  EXPRESSION_SELECTION_COMBINE_NOTE,
  capabilityLabel,
  expressionRoleLabel,
  previewFidelityLabel,
  selectionModeLabel,
  type ExpressionSelection,
  type ExpressionSelectionMode,
} from '../expression/expressionLibraryModel'
import {
  isBrandLockedPresentationPresetId,
  isSamePresentationPresetSelection,
  optionKey,
  type PresentationPresetLoadState,
  type PresentationPresetOption,
  type PresentationPresetSelection,
} from './presentationPresetModel'
import { ownsRetryFocusHandoff } from './retryFocusHandoff'
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
  /** Remotion / HyperFrames の presentation preset 一覧（任意。未指定時は選択 UI を出さない） */
  presentationPresets?: readonly PresentationPresetOption[]
  presentationPresetLoadState?: PresentationPresetLoadState
  onRetryPresentationPresets?: () => void
  /**
   * 親（TemplateWizardState）が持つ選択。未指定時は内部 state（単体テスト向け）。
   * 指定時は controlled。同一テンプレートでは unmount 後も親が保持する。
   */
  presentationPreset?: PresentationPresetSelection
  onPresentationPresetChange?: (selection: PresentationPresetSelection) => void
  /** 片側 backend 不足など、候補は出せるが一部欠けるときの非ブロッキング案内 */
  presentationPresetNotice?: string | null
  /** 互換のため残す（表現棚へ移したため未使用） */
  fetcher?: typeof fetch
  /** 互換のため残す（表現棚へ移したため未使用） */
  token?: string
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
  presentationPresets,
  presentationPresetLoadState = 'idle',
  onRetryPresentationPresets,
  presentationPreset: presentationPresetProp,
  onPresentationPresetChange,
  presentationPresetNotice = null,
  expressionSelections = [],
  expressionSelectionMode = 'unset',
  onOpenExpressions,
}: TemplateChecklistProps) {
  const headingId = useId()
  const detailsId = useId()
  const presetHeadingId = useId()
  const expressionHeadingId = useId()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const presetHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const retryButtonRef = useRef<HTMLButtonElement | null>(null)
  const recommendedButtonRef = useRef<HTMLButtonElement | null>(null)
  const prevPresetLoadStateRef = useRef(presentationPresetLoadState)
  /** True only after the user starts retry; not the same as retrySurfaceActive. */
  const retryHandoffPendingRef = useRef(false)
  /** True from first error until ready/idle — keeps retry DOM through loading. */
  const [retrySurfaceActive, setRetrySurfaceActive] = useState(
    () => presentationPresetLoadState === 'error',
  )
  const showPresetPicker = presentationPresets !== undefined
    || presentationPresetLoadState === 'loading'
    || presentationPresetLoadState === 'error'
    || presentationPresetLoadState === 'ready'
  const isPresetControlled = presentationPresetProp !== undefined
  const [uncontrolledPreset, setUncontrolledPreset] = useState<PresentationPresetSelection>(null)
  const presentationPreset = isPresetControlled ? presentationPresetProp : uncontrolledPreset
  const setPresentationPreset = (next: PresentationPresetSelection) => {
    if (isPresetControlled) onPresentationPresetChange?.(next)
    else setUncontrolledPreset(next)
  }
  const isPresetLoading = presentationPresetLoadState === 'loading'
  const isPresetError = presentationPresetLoadState === 'error'
  const showPresetRetryControl =
    Boolean(onRetryPresentationPresets)
    && (isPresetError || (isPresetLoading && retrySurfaceActive))
  const productionPrompt = useMemo(
    () => buildTemplateProductionPrompt(template, choices, presentationPreset, {
      mode: expressionSelectionMode,
      selections: expressionSelections,
    }),
    [choices, expressionSelectionMode, expressionSelections, presentationPreset, template],
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
  const presetOptions = presentationPresets ?? []

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [template.id])

  useEffect(() => {
    // uncontrolled のみ: 型が変わったら選択をリセット（おすすめに任せる）
    // controlled 時は親（TemplateWizardState）が別テンプレート選択で null にする
    if (isPresetControlled) return
    setUncontrolledPreset(null)
  }, [isPresetControlled, template.id])

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

  // Retry control stays mounted across error → loading; hand off focus only while owned.
  useLayoutEffect(() => {
    const prev = prevPresetLoadStateRef.current
    prevPresetLoadStateRef.current = presentationPresetLoadState

    if (presentationPresetLoadState === 'error') {
      setRetrySurfaceActive(true)
      if (prev === 'loading') {
        if (
          retryHandoffPendingRef.current
          && ownsRetryFocusHandoff(retryButtonRef.current)
        ) {
          retryButtonRef.current?.focus({ preventScroll: true })
        } else {
          retryHandoffPendingRef.current = false
        }
      }
      return
    }

    if (presentationPresetLoadState === 'ready') {
      const pending = retryHandoffPendingRef.current
      const shouldHandoff = pending
        && (prev === 'loading' || prev === 'error')
        && ownsRetryFocusHandoff(retryButtonRef.current)
      retryHandoffPendingRef.current = false
      if (retrySurfaceActive) setRetrySurfaceActive(false)
      if (shouldHandoff) {
        // Owned success handoff: allow browser scroll into view (new DOM may be off-screen).
        // Re-error restore keeps preventScroll so the same retry control does not jump.
        if (recommendedButtonRef.current && !(recommendedButtonRef.current as HTMLButtonElement).disabled) {
          recommendedButtonRef.current.focus()
        } else {
          presetHeadingRef.current?.focus()
        }
      }
      return
    }

    if (presentationPresetLoadState === 'idle') {
      retryHandoffPendingRef.current = false
      setRetrySurfaceActive(false)
    }
  }, [presentationPresetLoadState, retrySurfaceActive])

  function selectRecommended() {
    setPresentationPreset(null)
  }

  function selectPreset(option: PresentationPresetOption) {
    setPresentationPreset({ backend: option.backend, presetId: option.id })
  }

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

      {showPresetPicker && (
        <section
          aria-labelledby={presetHeadingId}
          className="launcher-template-checklist-presets"
          role="region"
        >
          <div className="launcher-template-checklist-presets-heading">
            <span>任意</span>
            <h3 id={presetHeadingId} ref={presetHeadingRef} tabIndex={-1}>
              制作依頼に指定できる仕上げ
            </h3>
            <p>
              制作依頼に指定できる仕上げです。参考表現一覧とは別枠です。
              ここでは制作依頼に追加するだけです。生成・インストール・書き出し・承認状態の更新はしません。
              未選択は「おすすめ候補を未選択」として制作依頼に明記します。
            </p>
          </div>

          {/* Initial load only — no retry control (avoids accidental action on first paint). */}
          {isPresetLoading && !retrySurfaceActive && (
            <div className="launcher-template-preset-state" aria-busy="true" aria-live="polite">
              <RefreshCw aria-hidden="true" className="is-spinning" size={18} />
              <strong>仕上げの動きを読み込んでいます…</strong>
            </div>
          )}

          {showPresetRetryControl && (
            <div
              className={
                isPresetError
                  ? 'launcher-template-preset-state launcher-template-preset-state-error'
                  : 'launcher-template-preset-state'
              }
              role={isPresetError ? 'alert' : undefined}
              aria-busy={isPresetLoading || undefined}
              aria-live={isPresetLoading ? 'polite' : undefined}
            >
              {isPresetError && (
                <>
                  <strong>仕上げの動きを読み込めませんでした。</strong>
                  <p>一覧を確認して、もう一度読み込んでください。未選択のまま制作依頼をコピーできます。</p>
                </>
              )}
              {isPresetLoading && (
                <strong>仕上げの動きを読み込んでいます…</strong>
              )}
              {onRetryPresentationPresets && (
                <button
                  ref={retryButtonRef}
                  aria-busy={isPresetLoading || undefined}
                  aria-disabled={isPresetLoading || undefined}
                  className="launcher-secondary"
                  onClick={() => {
                    // Soft-disable: keep focus on this node (native disabled drops to body in Chromium).
                    if (isPresetLoading) return
                    retryHandoffPendingRef.current = true
                    onRetryPresentationPresets()
                  }}
                  type="button"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={isPresetLoading ? 'is-spinning' : undefined}
                    size={16}
                  />
                  {isPresetLoading
                    ? '読み込んでいます…'
                    : '仕上げの動きをもう一度読み込む'}
                </button>
              )}
            </div>
          )}

          {presentationPresetLoadState === 'ready' && presetOptions.length === 0 && (
            <p className="launcher-template-preset-state" role="status">
              表示できる仕上げの動きはまだありません。おすすめに任せて制作依頼をコピーできます。
            </p>
          )}

          {presentationPresetNotice && presentationPresetLoadState === 'ready' && (
            <p className="launcher-template-preset-state" role="status">
              {presentationPresetNotice}
            </p>
          )}

          {(presentationPresetLoadState === 'ready' || presentationPresetLoadState === 'idle')
            && presetOptions.length > 0 && (
            <div
              aria-label="仕上げの動きの候補"
              className="launcher-template-preset-options"
              role="group"
            >
              <button
                ref={recommendedButtonRef}
                aria-pressed={presentationPreset === null}
                className="launcher-template-preset-option"
                onClick={selectRecommended}
                type="button"
              >
                <span className="launcher-template-preset-option-topline">
                  <strong>おすすめに任せる</strong>
                  <small>おすすめ候補を未選択</small>
                </span>
                <span className="launcher-template-preset-option-description">
                  仕上げの動きを明示指定しません。制作依頼には「おすすめ候補を未選択」と残します。
                </span>
              </button>
              {presetOptions.map((option) => {
                const selected = isSamePresentationPresetSelection(presentationPreset, {
                  backend: option.backend,
                  presetId: option.id,
                })
                const aspect = option.aspectRatio ?? '比率未記載'
                const brandLocked = isBrandLockedPresentationPresetId(option.id)
                const brandLabel = brandLocked ? 'ブランド固定' : null
                // 表示中の label / backend / aspect / ブランド固定をすべて accessible name に含める
                const accessibleName = [
                  option.label,
                  option.backendLabel,
                  aspect,
                  ...(brandLabel ? [brandLabel] : []),
                ].join('、')
                return (
                  <button
                    aria-label={accessibleName}
                    aria-pressed={selected}
                    className="launcher-template-preset-option"
                    key={optionKey(option)}
                    onClick={() => selectPreset(option)}
                    type="button"
                  >
                    <span className="launcher-template-preset-option-topline">
                      <strong aria-hidden="true">{option.label}</strong>
                      <small aria-hidden="true">{option.backendLabel}</small>
                      <small aria-hidden="true">{aspect}</small>
                      {brandLabel && (
                        <small aria-hidden="true">{brandLabel}</small>
                      )}
                    </span>
                    {option.description && (
                      <span className="launcher-template-preset-option-description">
                        {option.description}
                      </span>
                    )}
                    <span className="launcher-template-preset-option-tech">
                      <code>{option.id}</code>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>
      )}

      <section
        aria-labelledby={expressionHeadingId}
        className="launcher-template-checklist-expressions"
        role="region"
      >
        <div className="launcher-template-checklist-presets-heading">
          <span>任意</span>
          <h3 id={expressionHeadingId}>選んだ表現</h3>
          <p>
            表現棚で選んだ候補です。{EXPRESSION_SELECTION_COMBINE_NOTE}
            巨大な一覧の埋め込みは置かず、表現タブへ移動して選びます。
          </p>
        </div>
        <p className="launcher-template-preset-state" role="status">
          状態: {selectionModeLabel(expressionSelectionMode)}
        </p>
        {expressionSelections.length === 0 ? (
          <p className="launcher-template-preset-state">
            まだ表現候補を明示選択していません。
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
        {onOpenExpressions && (
          <button
            className="launcher-secondary"
            data-expression-return-trigger=""
            data-template-id={template.id}
            onClick={onOpenExpressions}
            type="button"
          >
            <Sparkles aria-hidden="true" size={16} />
            表現を変更
          </button>
        )}
        {!onOpenExpressions && (
          <p className="launcher-template-preset-state">
            上部ナビの「表現」タブから候補を選べます。
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
          目的・選択内容・必須素材・制作条件・仕上げの動き・表現候補
          だけをコピーします。
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
