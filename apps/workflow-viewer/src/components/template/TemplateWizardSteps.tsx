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
      label: '型',
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
    label: 'チェックリスト',
  })

  return chips
}

export function TemplateWizardSteps({ template, state, onGoToStep }: TemplateWizardStepsProps) {
  if (state.step === 0 && !state.templateId) return null

  const chips = buildChips(template, state)

  return (
    <nav aria-label="ウィザードの進捗" className="launcher-template-wizard-steps">
      <ol>
        {chips.map((chip) => {
          const isCurrent = chip.step === state.step
          // 過去ステップのみ戻れる（現在・未来は disabled）
          const canGo = chip.step < state.step
          // 型チップだけ詳細名を a11y 名に含める（軸 option 名と衝突させない）
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
