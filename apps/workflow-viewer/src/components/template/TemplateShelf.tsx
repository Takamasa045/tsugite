import { LayoutTemplate, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { TemplateAxisStep } from './TemplateAxisStep'
import { TemplateChecklist } from './TemplateChecklist'
import { TemplateTypeCard } from './TemplateTypeCard'
import { TemplateWizardSteps } from './TemplateWizardSteps'
import {
  applyAxisChoice,
  checklistStep,
  fillDefaultsToChecklist,
  INITIAL_WIZARD_STATE,
  initialChoicesForTemplate,
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
}

export function TemplateShelf({
  templates,
  loadState = 'ready',
  onRetry,
  onStateChange,
  initialState,
  onSelectedTemplateChange,
}: TemplateShelfProps) {
  const [state, setState] = useState<TemplateWizardState>(() => initialState ?? INITIAL_WIZARD_STATE)
  const [selectionError, setSelectionError] = useState<string | null>(null)
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

  useEffect(() => {
    if (!focusTypeHeadingRef.current) return
    focusTypeHeadingRef.current = false
    typeHeadingRef.current?.focus()
  }, [state.step])

  function commit(next: TemplateWizardState) {
    setState(next)
  }

  function handleSelectTemplate(templateId: string) {
    const template = templates.find((entry) => entry.id === templateId)
    if (!template) return

    if (!template.valid) {
      setSelectionError(
        template.issue?.message
          ?? 'このテンプレートは表示情報を確認できません。選択できません。',
      )
      commit({ templateId: null, choices: {}, step: 0 })
      return
    }

    setSelectionError(null)
    const choices = initialChoicesForTemplate(template)
    const step = template.variants.length === 0 ? checklistStep(template.variants) : 1
    commit({ templateId: template.id, choices, step })
  }

  function handleAxisSelect(axisIndex: number, optionId: string) {
    if (!selectedTemplate?.valid) return
    const result = applyAxisChoice(
      selectedTemplate.variants,
      state.choices,
      axisIndex,
      optionId,
    )
    commit({
      templateId: selectedTemplate.id,
      choices: result.choices,
      step: result.step,
    })
  }

  function handleSkipWithDefaults() {
    if (!selectedTemplate?.valid) return
    const result = fillDefaultsToChecklist(selectedTemplate.variants, state.choices)
    commit({
      templateId: selectedTemplate.id,
      choices: result.choices,
      step: result.step,
    })
  }

  function handleGoToStep(step: number) {
    if (step < 0) return
    if (step === 0) {
      focusTypeHeadingRef.current = true
      commit({ ...state, step: 0 })
      return
    }
    if (!selectedTemplate?.valid) return
    const maxStep = checklistStep(selectedTemplate.variants)
    if (step > maxStep || step > state.step) {
      // 未来ステップへの前進はパンくずでは許可しない（到達済み / 現在以下のみ）
      if (step > state.step) return
    }
    commit({ ...state, step: Math.min(step, maxStep) })
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

  return (
    <section
      aria-labelledby="launcher-templates-tab"
      className="launcher-workbench launcher-template-wizard"
      id="launcher-templates-panel"
      role="tabpanel"
    >
      <section
        aria-labelledby="template-list-title"
        className="launcher-projects launcher-template-shelf launcher-template-wizard-main"
      >
        <div className="launcher-section-heading">
          <div>
            <span className="eyebrow">型の棚</span>
            <h2
              id="template-list-title"
              ref={typeHeadingRef}
              tabIndex={state.step === 0 ? -1 : undefined}
            >
              {state.step === 0 ? 'テンプレートを選ぶ' : '型のウィザード'}
            </h2>
          </div>
          {loadState === 'ready' && state.step === 0 && (
            <span className="launcher-count">全{templates.length}件</span>
          )}
        </div>

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
                <div className="launcher-template-list">
                  {templates.map((template) => (
                    <TemplateTypeCard
                      key={template.id}
                      onSelect={handleSelectTemplate}
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
                template={selectedTemplate}
              />
            )}
          </>
        )}
      </section>
    </section>
  )
}
