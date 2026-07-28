import type { LauncherTemplate, TemplateWizardState } from './templateShelfModel'
import { checklistStep, optionLabelFor } from './templateShelfModel'

export interface TemplateWizardStepsProps {
  template: LauncherTemplate | null
  state: TemplateWizardState
  onGoToStep: (step: number) => void
}

interface ProgressChip {
  step: number
  label: string
  detail?: string
}

function buildChips(
  template: LauncherTemplate | null,
  state: TemplateWizardState,
): ProgressChip[] {
  const chips: ProgressChip[] = [
    {
      step: 0,
      label: '動画',
      detail: template?.valid ? template.name : undefined,
    },
  ]

  if (!template?.valid) return chips

  for (const [index, variant] of template.variants.entries()) {
    const choiceId = state.choices[variant.id]
    chips.push({
      step: index + 1,
      label: variant.label,
      detail: choiceId ? optionLabelFor(template, variant.id, choiceId) : undefined,
    })
  }

  chips.push({
    step: checklistStep(template.variants),
    label: '制作依頼',
  })

  return chips
}

export function TemplateWizardSteps({ template, state, onGoToStep }: TemplateWizardStepsProps) {
  if (state.step === 0 && !state.templateId) return null

  const chips = buildChips(template, state)
  const totalSteps = chips.length
  const currentStepNumber = Math.min(state.step + 1, totalSteps)
  const remaining = Math.max(totalSteps - currentStepNumber, 0)
  const progressLabel = remaining === 0
    ? `${currentStepNumber} / ${totalSteps} · 完了`
    : `${currentStepNumber} / ${totalSteps} · あと${remaining}つ`

  return (
    <nav aria-label="ウィザードの進捗" className="launcher-template-wizard-steps">
      <div className="launcher-template-wizard-progress-meta" aria-live="polite">
        <strong className="launcher-template-wizard-progress-count">{progressLabel}</strong>
        <ol aria-hidden="true" className="launcher-template-wizard-joinery">
          {chips.map((chip) => {
            const isDone = chip.step < state.step
            const isCurrent = chip.step === state.step
            return (
              <li
                data-current={isCurrent || undefined}
                data-done={isDone || undefined}
                key={`joinery-${chip.step}-${chip.label}`}
              />
            )
          })}
        </ol>
      </div>
      <ol className="launcher-template-wizard-step-list">
        {chips.map((chip) => {
          const isCurrent = chip.step === state.step
          // 過去ステップのみ戻れる（現在・未来は disabled）
          const canGo = chip.step < state.step
          // 動画チップだけ詳細名を a11y 名に含める（条件 option 名と衝突させない）
          const buttonLabel = chip.step === 0 && chip.detail
            ? `${chip.label}: ${chip.detail}`
            : chip.label

          return (
            <li data-current={isCurrent || undefined} key={`${chip.step}-${chip.label}`}>
              <button
                aria-current={isCurrent ? 'step' : undefined}
                aria-label={buttonLabel}
                disabled={!canGo}
                onClick={() => onGoToStep(chip.step)}
                type="button"
              >
                <span>{chip.label}</span>
                {chip.detail && <small aria-hidden="true">{chip.detail}</small>}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
