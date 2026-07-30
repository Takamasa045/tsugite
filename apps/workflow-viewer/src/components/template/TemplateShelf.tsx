import { ArrowLeft, LayoutTemplate, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { TemplateAxisStep } from './TemplateAxisStep'
import { TemplateChecklist } from './TemplateChecklist'
import { TemplateTypeCard } from './TemplateTypeCard'
import { TemplateWizardSteps } from './TemplateWizardSteps'
import {
  syncExpressionSelectionsFromPresentationPreset,
} from '../expression/expressionLibraryModel'
import type {
  PresentationPresetLoadState,
  PresentationPresetOption,
  PresentationPresetSelection,
} from './presentationPresetModel'
import { isSamePresentationPresetSelection } from './presentationPresetModel'
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
  presentationPresets?: readonly PresentationPresetOption[]
  presentationPresetLoadState?: PresentationPresetLoadState
  onRetryPresentationPresets?: () => void
  /** 片側 backend 不足などの非ブロッキング案内 */
  presentationPresetNotice?: string | null
  /** HyperFrames 公式 catalog など、棚内の読み取り専用 fetch に使う */
  fetcher?: typeof fetch
  /** ランチャー認証token。catalog GET に渡す */
  token?: string
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
    presentationPreset: patch.presentationPreset !== undefined
      ? patch.presentationPreset
      : (state.presentationPreset ?? null),
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
  presentationPresets,
  presentationPresetLoadState,
  onRetryPresentationPresets,
  presentationPresetNotice = null,
  fetcher,
  token = '',
  onOpenExpressions,
}: TemplateShelfProps) {
  const [state, setState] = useState<TemplateWizardState>(() => initialState ?? INITIAL_WIZARD_STATE)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [selectionConfirm, setSelectionConfirm] = useState<string | null>(null)
  const typeHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const focusTypeHeadingRef = useRef(false)

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

  // 表現棚で更新された候補 / preset を、棚をまたいで最終画面へ反映する
  useEffect(() => {
    if (!initialState) return
    setState((current) => {
      const nextSelections = initialState.expressionSelections ?? []
      const nextMode = initialState.expressionSelectionMode ?? 'unset'
      const nextPreset = initialState.presentationPreset ?? null
      const sameSelections = current.expressionSelections?.length === nextSelections.length
        && (current.expressionSelections ?? []).every(
          (entry, index) => entry.key === nextSelections[index]?.key,
        )
      const samePreset = isSamePresentationPresetSelection(
        current.presentationPreset ?? null,
        nextPreset,
      )
      if (
        sameSelections
        && current.expressionSelectionMode === nextMode
        && samePreset
      ) {
        return current
      }
      return {
        ...current,
        expressionSelections: nextSelections,
        expressionSelectionMode: nextMode,
        presentationPreset: nextPreset,
      }
    })
  }, [
    initialState?.expressionSelectionMode,
    initialState?.expressionSelections,
    initialState?.presentationPreset,
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

  function resetPresentationPresetKeepingAuxiliary(
    base: TemplateWizardState,
    patch: Partial<TemplateWizardState>,
  ): TemplateWizardState {
    // 仕上げの動きを未選択に戻すとき、表現由来 full も落として制作依頼の矛盾を防ぐ。補助は保持。
    const synced = syncExpressionSelectionsFromPresentationPreset(
      base.expressionSelections ?? [],
      null,
      null,
    )
    return withExpressionState(base, {
      ...patch,
      presentationPreset: null,
      expressionSelections: synced.selections,
      expressionSelectionMode: synced.mode,
    })
  }

  function rejectInvalid(template: LauncherTemplate) {
    setSelectionError(
      template.issue?.message
        ?? 'このテンプレートは表示情報を確認できません。選択できません。',
    )
    setSelectionConfirm(null)
    commit(resetPresentationPresetKeepingAuxiliary(state, {
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
    // 別テンプレート選択時は仕上げの動きを安全にリセット。補助表現は保持。
    commit(resetPresentationPresetKeepingAuxiliary(state, {
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
    commit(resetPresentationPresetKeepingAuxiliary(state, {
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
      presentationPreset: state.presentationPreset ?? null,
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
      presentationPreset: state.presentationPreset ?? null,
    }))
  }

  function handlePresentationPresetChange(selection: PresentationPresetSelection) {
    const option = selection
      ? (presentationPresets ?? []).find(
        (entry) => entry.backend === selection.backend && entry.id === selection.presetId,
      ) ?? null
      : null
    const synced = syncExpressionSelectionsFromPresentationPreset(
      state.expressionSelections ?? [],
      selection,
      option,
    )
    commit(withExpressionState(state, {
      presentationPreset: selection,
      expressionSelections: synced.selections,
      expressionSelectionMode: synced.mode,
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

        {loadState === 'loading' && (
          <div className="launcher-empty" aria-live="polite">
            <RefreshCw aria-hidden="true" className="is-spinning" size={22} />
            <strong>テンプレートを読み込んでいます…</strong>
          </div>
        )}

        {loadState === 'error' && (
          <div className="launcher-catalog-error" role="alert">
            <strong>テンプレートを読み込めませんでした。</strong>
            <p>カタログを確認して、もう一度読み込んでください。</p>
            {onRetry && (
              <button className="launcher-secondary" onClick={onRetry} type="button">
                <RefreshCw aria-hidden="true" size={16} />テンプレートをもう一度読み込む
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
                fetcher={fetcher}
                onOpenExpressions={onOpenExpressions
                  ? () => onOpenExpressions(selectedTemplate)
                  : undefined}
                onPresentationPresetChange={handlePresentationPresetChange}
                onRetryPresentationPresets={onRetryPresentationPresets}
                presentationPreset={state.presentationPreset ?? null}
                presentationPresetLoadState={presentationPresetLoadState}
                presentationPresetNotice={presentationPresetNotice}
                presentationPresets={presentationPresets}
                template={selectedTemplate}
                token={token}
              />
            )}
          </>
        )}
      </section>
    </section>
  )
}
