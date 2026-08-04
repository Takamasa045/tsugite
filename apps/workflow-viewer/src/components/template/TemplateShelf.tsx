import { ArrowLeft, LayoutTemplate, RefreshCw } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { TemplateAxisStep } from './TemplateAxisStep'
import { TemplateChecklist } from './TemplateChecklist'
import { TemplateTypeCard } from './TemplateTypeCard'
import { TemplateWizardSteps } from './TemplateWizardSteps'
import { ownsRetryFocusHandoff } from './retryFocusHandoff'
import {
  applyAxisChoice,
  checklistStep,
  fillDefaultsToChecklist,
  INITIAL_WIZARD_STATE,
  initialChoicesForTemplate,
  optionLabelFor,
  type LauncherTemplate,
  type TemplateLoadState,
  type TemplateWizardState,
} from './templateShelfModel'

export type { TemplateWizardState }

export interface TemplateShelfProps {
  templates: LauncherTemplate[]
  loadState?: TemplateLoadState
  onRetry?: () => void
  onStateChange?: (state: TemplateWizardState) => void
  initialState?: TemplateWizardState
  onSelectedTemplateChange?: (template: LauncherTemplate | null) => void
  /** テンプレートから表現棚へ。intent seed 付きで開く */
  onOpenExpressions?: (template: LauncherTemplate) => void
}

function withExpressionState(
  state: TemplateWizardState,
  patch: Partial<TemplateWizardState>,
): TemplateWizardState {
  const next: TemplateWizardState = {
    ...state,
    ...patch,
    templateId: patch.templateId !== undefined ? patch.templateId : state.templateId,
    choices: patch.choices ?? state.choices,
    step: patch.step ?? state.step,
    expressionSelections: patch.expressionSelections
      ?? state.expressionSelections
      ?? [],
    expressionSelectionMode: patch.expressionSelectionMode
      ?? state.expressionSelectionMode
      ?? 'unset',
  }
  return next
}

export function TemplateShelf({
  templates,
  loadState = 'ready',
  onRetry,
  onStateChange,
  initialState,
  onSelectedTemplateChange,
  onOpenExpressions,
}: TemplateShelfProps) {
  const [state, setState] = useState<TemplateWizardState>(() => initialState ?? INITIAL_WIZARD_STATE)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [selectionConfirm, setSelectionConfirm] = useState<string | null>(null)
  const typeHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const focusTypeHeadingRef = useRef(false)
  const catalogRetryButtonRef = useRef<HTMLButtonElement | null>(null)
  const prevLoadStateRef = useRef(loadState)
  /** True only after the user starts retry; not the same as catalogRetrySurfaceActive. */
  const retryHandoffPendingRef = useRef(false)
  /** True from first catalog error until ready — keeps retry DOM through loading. */
  const [catalogRetrySurfaceActive, setCatalogRetrySurfaceActive] = useState(
    () => loadState === 'error',
  )

  const isCatalogLoading = loadState === 'loading'
  const isCatalogError = loadState === 'error'
  const showCatalogRetryControl =
    Boolean(onRetry)
    && (isCatalogError || (isCatalogLoading && catalogRetrySurfaceActive))

  // Retry stays mounted error→loading; hand off focus only while user-owned.
  useLayoutEffect(() => {
    const prev = prevLoadStateRef.current
    prevLoadStateRef.current = loadState

    if (loadState === 'error') {
      setCatalogRetrySurfaceActive(true)
      // Re-failure after loading: restore only if retry still owns focus.
      if (prev === 'loading') {
        if (
          retryHandoffPendingRef.current
          && ownsRetryFocusHandoff(catalogRetryButtonRef.current)
        ) {
          catalogRetryButtonRef.current?.focus({ preventScroll: true })
        } else {
          retryHandoffPendingRef.current = false
        }
      }
      return
    }

    if (loadState === 'ready') {
      const pending = retryHandoffPendingRef.current
      const shouldHandoff = pending
        && (prev === 'loading' || prev === 'error')
        && ownsRetryFocusHandoff(catalogRetryButtonRef.current)
      retryHandoffPendingRef.current = false
      if (catalogRetrySurfaceActive) setCatalogRetrySurfaceActive(false)
      if (shouldHandoff) {
        // Owned success handoff: first valid template action, else type heading.
        // Initial automatic loading never sets pending, so it does not focus.
        const section = typeHeadingRef.current?.closest('section')
        const firstAction = section?.querySelector<HTMLButtonElement>(
          '.launcher-template-card-actions button:not([disabled])',
        )
        if (firstAction) {
          firstAction.focus()
        } else {
          typeHeadingRef.current?.focus()
        }
      }
    }
  }, [loadState, catalogRetrySurfaceActive])

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === state.templateId) ?? null,
    [state.templateId, templates],
  )

  useEffect(() => {
    onStateChange?.(state)
  }, [onStateChange, state])

  useEffect(() => {
    onSelectedTemplateChange?.(selectedTemplate)
  }, [onSelectedTemplateChange, selectedTemplate])

  // 表現棚で更新された候補を、棚をまたいで最終画面へ反映する
  useEffect(() => {
    if (!initialState) return
    setState((current) => {
      const nextSelections = initialState.expressionSelections ?? []
      const nextMode = initialState.expressionSelectionMode ?? 'unset'
      const sameSelections = current.expressionSelections?.length === nextSelections.length
        && (current.expressionSelections ?? []).every(
          (entry, index) => entry.key === nextSelections[index]?.key,
        )
      if (
        sameSelections
        && current.expressionSelectionMode === nextMode
      ) {
        return current
      }
      return {
        ...current,
        expressionSelections: nextSelections,
        expressionSelectionMode: nextMode,
      }
    })
  }, [
    initialState?.expressionSelectionMode,
    initialState?.expressionSelections,
  ])

  useEffect(() => {
    if (!focusTypeHeadingRef.current) return
    focusTypeHeadingRef.current = false
    typeHeadingRef.current?.focus({ preventScroll: true })
  }, [state.step])

  function commit(next: TemplateWizardState) {
    setState(next)
  }

  function announceSelection(label: string) {
    setSelectionConfirm(`${label}を選びました。戻って変更できます。`)
  }

  function resetForTemplate(
    base: TemplateWizardState,
    patch: Partial<TemplateWizardState>,
  ): TemplateWizardState {
    // テンプレートを替えるときは全体構成だけを外し、補助表現は引き継ぐ。
    const expressionSelections = (base.expressionSelections ?? []).filter((entry) => (
      entry.source !== 'presentation-preset' || entry.role !== 'full-composition'
    ))
    return withExpressionState(base, {
      ...patch,
      expressionSelections,
      expressionSelectionMode: expressionSelections.length > 0 ? 'explicit' : 'unset',
    })
  }

  function rejectInvalid(template: LauncherTemplate) {
    setSelectionError(
      template.issue?.message
        ?? 'このテンプレートは表示情報を確認できません。選択できません。',
    )
    setSelectionConfirm(null)
    commit(resetForTemplate(state, {
      templateId: null,
      choices: {},
      step: 0,
    }))
  }

  function handleSelectDetail(templateId: string) {
    const template = templates.find((entry) => entry.id === templateId)
    if (!template) return

    if (!template.valid) {
      rejectInvalid(template)
      return
    }

    setSelectionError(null)
    announceSelection(template.name)
    const choices = initialChoicesForTemplate(template)
    const step = template.variants.length === 0 ? checklistStep(template.variants) : 1
    commit(resetForTemplate(state, {
      templateId: template.id,
      choices,
      step,
    }))
  }

  function handleQuickStart(templateId: string) {
    const template = templates.find((entry) => entry.id === templateId)
    if (!template) return

    if (!template.valid) {
      rejectInvalid(template)
      return
    }

    setSelectionError(null)
    announceSelection(template.name)
    const result = fillDefaultsToChecklist(template.variants, {})
    commit(resetForTemplate(state, {
      templateId: template.id,
      choices: result.choices,
      step: result.step,
    }))
  }

  function handleOpenExpressions(templateId: string) {
    const template = templates.find((entry) => entry.id === templateId)
    if (!template?.valid) {
      if (template) rejectInvalid(template)
      return
    }
    onOpenExpressions?.(template)
  }

  function handleAxisSelect(axisIndex: number, optionId: string) {
    if (!selectedTemplate?.valid) return
    const axis = selectedTemplate.variants[axisIndex]
    const optionLabel = axis
      ? optionLabelFor(selectedTemplate, axis.id, optionId) ?? optionId
      : optionId
    const result = applyAxisChoice(
      selectedTemplate.variants,
      state.choices,
      axisIndex,
      optionId,
    )
    announceSelection(optionLabel)
    commit(withExpressionState(state, {
      templateId: selectedTemplate.id,
      choices: result.choices,
      step: result.step,
    }))
  }

  function handleSkipWithDefaults() {
    if (!selectedTemplate?.valid) return
    const result = fillDefaultsToChecklist(selectedTemplate.variants, state.choices)
    setSelectionConfirm('おすすめ設定を使います。戻って変更できます。')
    commit(withExpressionState(state, {
      templateId: selectedTemplate.id,
      choices: result.choices,
      step: result.step,
    }))
  }

  function handleGoToStep(step: number) {
    if (step < 0) return
    if (step === 0) {
      focusTypeHeadingRef.current = true
      commit({ ...state, step: 0 })
      return
    }
    // 未来ステップへの前進はパンくずでは許可しない（到達済み / 現在以下のみ）
    if (step > state.step) return
    if (!selectedTemplate?.valid) return
    const maxStep = checklistStep(selectedTemplate.variants)
    commit({ ...state, step: Math.min(step, maxStep) })
  }

  function handleBack() {
    if (state.step <= 0) return
    handleGoToStep(state.step - 1)
  }

  const axisIndex = state.step >= 1 && selectedTemplate?.valid
    ? state.step - 1
    : -1
  const activeVariant = selectedTemplate?.valid && axisIndex >= 0 && axisIndex < selectedTemplate.variants.length
    ? selectedTemplate.variants[axisIndex]
    : null
  const onChecklist = Boolean(
    selectedTemplate?.valid
    && state.step === checklistStep(selectedTemplate.variants),
  )
  const backLabel = state.step === 1 ? '一覧に戻る' : '戻る'
  // 軸見出しは TemplateAxisStep / 成果見出しは TemplateChecklist が担う。
  const headingText = state.step === 0
    ? '何を作りたい？'
    : onChecklist
      ? '確認してコピー'
      : '条件を選ぶ'

  return (
    <section
      aria-labelledby="launcher-templates-tab"
      className="launcher-workbench launcher-template-wizard"
      data-wizard-step={state.step}
      id="launcher-templates-panel"
      role="tabpanel"
    >
      <section
        aria-labelledby="template-list-title"
        className="launcher-projects launcher-template-shelf launcher-template-wizard-main"
      >
        <div className="launcher-section-heading launcher-template-wizard-heading">
          <div>
            {state.step > 0 && (
              <button
                className="launcher-template-back"
                onClick={handleBack}
                type="button"
              >
                <ArrowLeft aria-hidden="true" size={16} />
                {backLabel}
              </button>
            )}
            <span className="eyebrow">動画づくり</span>
            <h2
              id="template-list-title"
              ref={typeHeadingRef}
              tabIndex={state.step === 0 ? -1 : undefined}
            >
              {headingText}
            </h2>
          </div>
          {loadState === 'ready' && state.step === 0 && (
            <span className="launcher-count">全{templates.length}件</span>
          )}
        </div>

        <p
          aria-live="polite"
          className="launcher-template-selection-confirm"
          data-empty={!selectionConfirm || undefined}
        >
          {selectionConfirm ?? ''}
        </p>

        {/* Initial load only — no retry control (avoids accidental action on first paint). */}
        {isCatalogLoading && !catalogRetrySurfaceActive && (
          <div className="launcher-empty" aria-live="polite">
            <RefreshCw aria-hidden="true" className="is-spinning" size={22} />
            <strong>テンプレートを読み込んでいます…</strong>
          </div>
        )}

        {/* Keep retry mounted across error → loading so focus does not fall to body. */}
        {showCatalogRetryControl && (
          <div
            className={isCatalogError ? 'launcher-catalog-error' : 'launcher-empty'}
            role={isCatalogError ? 'alert' : undefined}
            aria-busy={isCatalogLoading || undefined}
            aria-live={isCatalogLoading ? 'polite' : undefined}
          >
            {isCatalogError && (
              <>
                <strong>テンプレートを読み込めませんでした。</strong>
                <p>カタログを確認して、もう一度読み込んでください。</p>
              </>
            )}
            {isCatalogLoading && (
              <strong>テンプレートを読み込んでいます…</strong>
            )}
            {onRetry && (
              <button
                ref={catalogRetryButtonRef}
                aria-busy={isCatalogLoading || undefined}
                aria-disabled={isCatalogLoading || undefined}
                className="launcher-secondary"
                onClick={() => {
                  // Soft-disable: keep focus on this node (native disabled drops to body in Chromium).
                  if (isCatalogLoading) return
                  retryHandoffPendingRef.current = true
                  onRetry()
                }}
                type="button"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={isCatalogLoading ? 'is-spinning' : undefined}
                  size={16}
                />
                {isCatalogLoading
                  ? '読み込んでいます…'
                  : 'テンプレートをもう一度読み込む'}
              </button>
            )}
          </div>
        )}

        {loadState === 'ready' && templates.length === 0 && (
          <div className="launcher-empty">
            <LayoutTemplate aria-hidden="true" size={24} />
            <strong>表示できるテンプレートはまだありません。</strong>
            <p>templates直下にtemplate.yamlを用意すると、ここに表示されます。</p>
          </div>
        )}

        {loadState === 'ready' && templates.length > 0 && (
          <>
            {(state.step > 0 || selectedTemplate) && (
              <TemplateWizardSteps
                onGoToStep={handleGoToStep}
                state={state}
                template={selectedTemplate}
              />
            )}

            {state.step === 0 && (
              <>
                {selectionError && (
                  <div className="launcher-project-issue" role="status">
                    <strong>このテンプレートは選択できません</strong>
                    <p>{selectionError}</p>
                  </div>
                )}
                <p className="launcher-template-wizard-lead">
                  作りたい動画を選んでください。おすすめ設定ならすぐ制作依頼を作れます。
                  この画面では生成・実行・Gate更新はしません。
                </p>
                <div className="launcher-template-list">
                  {templates.map((template) => (
                    <TemplateTypeCard
                      key={template.id}
                      onOpenExpressions={onOpenExpressions ? handleOpenExpressions : undefined}
                      onQuickStart={handleQuickStart}
                      onSelectDetail={handleSelectDetail}
                      selected={template.id === state.templateId}
                      template={template}
                    />
                  ))}
                </div>
              </>
            )}

            {state.step > 0 && activeVariant && selectedTemplate?.valid && (
              <TemplateAxisStep
                key={activeVariant.id}
                onSelect={(optionId) => handleAxisSelect(axisIndex, optionId)}
                onSkipWithDefaults={handleSkipWithDefaults}
                selectedOptionId={state.choices[activeVariant.id]}
                variant={activeVariant}
              />
            )}

            {onChecklist && selectedTemplate?.valid && (
              <TemplateChecklist
                choices={state.choices}
                expressionSelectionMode={state.expressionSelectionMode ?? 'unset'}
                expressionSelections={state.expressionSelections ?? []}
                onOpenExpressions={onOpenExpressions
                  ? () => onOpenExpressions(selectedTemplate)
                  : undefined}
                template={selectedTemplate}
              />
            )}
          </>
        )}
      </section>
    </section>
  )
}
