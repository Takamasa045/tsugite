export interface LauncherTemplate {
  id: string
  name: string
  summary: string
  category: string
  useCases: string[]
  duration: string
  aspectRatio: string
  speakers?: number
  requiredInputs: string[]
  requiredInputDetails: Array<{
    type: 'text' | 'image' | 'audio' | 'video' | 'data' | 'other'
    label: string
    required?: boolean
  }>
  preview: {
    frames: Array<{
      kind: 'product' | 'person' | 'interface' | 'parts' | 'hands' | 'result' | 'event' | 'text'
      label: string
    }>
    flow: string[]
  } | null
  notFor: string[]
  variants: Array<{
    id: string
    label: string
    defaultOptionId?: string
    options: Array<{
      id: string
      label: string
      description: string
    }>
  }>
  tags: string[]
  audio: string
  status: 'stable' | 'experimental' | 'deprecated' | 'unknown'
  distribution: 'bundled' | 'local-only' | 'unknown'
  valid: boolean
  issue?: { code: string; message: string }
}

export type TemplateVariant = LauncherTemplate['variants'][number]
export type TemplateVariantOption = TemplateVariant['options'][number]
export type TemplateInputDetail = LauncherTemplate['requiredInputDetails'][number]

export interface TemplateWizardState {
  templateId: string | null
  choices: Readonly<Record<string, string>>
  /** 0=型, 1..n=軸, n+1=チェックリスト */
  step: number
}

export const INITIAL_WIZARD_STATE: TemplateWizardState = {
  templateId: null,
  choices: {},
  step: 0,
}

export interface TemplateListResponse {
  ok: true
  templates: LauncherTemplate[]
}

export type TemplateLoadState = 'idle' | 'loading' | 'ready' | 'error'
export type TemplateTone = 'product' | 'explainer' | 'assembly' | 'seminar'
export type TemplateInputType = LauncherTemplate['requiredInputDetails'][number]['type']

export const TEMPLATE_STATUS_LABELS: Record<LauncherTemplate['status'], string> = {
  stable: '安定版',
  experimental: '試験中',
  deprecated: '非推奨',
  unknown: '要確認',
}

export const DISTRIBUTION_LABELS: Record<LauncherTemplate['distribution'], string> = {
  bundled: '同梱',
  'local-only': 'ローカル限定',
  unknown: '区分を確認',
}

export const TEMPLATE_INPUT_TYPE_LABELS: Record<TemplateInputType, string> = {
  text: 'テキスト',
  image: '画像',
  audio: '音声',
  video: '動画',
  data: 'データ',
  other: 'その他',
}

export const FALLBACK_TEMPLATE_PREVIEW: NonNullable<LauncherTemplate['preview']> = {
  frames: [
    { kind: 'text', label: '導入' },
    { kind: 'interface', label: '本編' },
    { kind: 'result', label: 'まとめ' },
  ],
  flow: ['導入', '本編', 'まとめ'],
}

export function templateTone(category: string): TemplateTone {
  if (/(商品|EC|サービス)/i.test(category)) return 'product'
  if (/(組み立て|手順|組立)/.test(category)) return 'assembly'
  if (/(セミナー|イベント|告知|ショート|シュート)/.test(category)) return 'seminar'
  return 'explainer'
}

export function hasUsableTemplatePreview(
  preview: LauncherTemplate['preview'],
): preview is NonNullable<LauncherTemplate['preview']> {
  return preview !== null
    && preview.frames.length === 3
    && preview.flow.length >= 3
    && preview.flow.length <= 5
}

export function templatePreview(template: LauncherTemplate): NonNullable<LauncherTemplate['preview']> {
  return hasUsableTemplatePreview(template.preview) ? template.preview : FALLBACK_TEMPLATE_PREVIEW
}

function isStringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every((value) => typeof value === 'string')
}

function isTemplateVariant(input: unknown): input is LauncherTemplate['variants'][number] {
  return typeof input === 'object' && input !== null
    && 'id' in input && typeof input.id === 'string'
    && 'label' in input && typeof input.label === 'string'
    && (!('defaultOptionId' in input) || input.defaultOptionId === undefined || typeof input.defaultOptionId === 'string')
    && 'options' in input && Array.isArray(input.options) && input.options.every((option) => (
      typeof option === 'object' && option !== null
      && 'id' in option && typeof option.id === 'string'
      && 'label' in option && typeof option.label === 'string'
      && 'description' in option && typeof option.description === 'string'
    ))
}

function isTemplateInputDetail(input: unknown): input is LauncherTemplate['requiredInputDetails'][number] {
  return typeof input === 'object' && input !== null
    && 'type' in input && typeof input.type === 'string'
    && ['text', 'image', 'audio', 'video', 'data', 'other'].includes(input.type)
    && 'label' in input && typeof input.label === 'string'
    && (!('required' in input) || input.required === undefined || typeof input.required === 'boolean')
}

function isTemplatePreview(input: unknown): input is LauncherTemplate['preview'] {
  if (input === null) return true
  return typeof input === 'object' && input !== null
    && 'frames' in input && Array.isArray(input.frames) && input.frames.every((frame) => (
      typeof frame === 'object' && frame !== null
      && 'kind' in frame && typeof frame.kind === 'string'
      && ['product', 'person', 'interface', 'parts', 'hands', 'result', 'event', 'text'].includes(frame.kind)
      && 'label' in frame && typeof frame.label === 'string'
    ))
    && 'flow' in input && isStringArray(input.flow)
}

export function isLauncherTemplate(input: unknown): input is LauncherTemplate {
  return typeof input === 'object' && input !== null
    && 'id' in input && typeof input.id === 'string'
    && 'name' in input && typeof input.name === 'string'
    && 'summary' in input && typeof input.summary === 'string'
    && 'category' in input && typeof input.category === 'string'
    && 'useCases' in input && isStringArray(input.useCases)
    && 'duration' in input && typeof input.duration === 'string'
    && 'aspectRatio' in input && typeof input.aspectRatio === 'string'
    && (!('speakers' in input) || input.speakers === undefined || typeof input.speakers === 'number')
    && 'requiredInputs' in input && isStringArray(input.requiredInputs)
    && 'requiredInputDetails' in input && Array.isArray(input.requiredInputDetails) && input.requiredInputDetails.every(isTemplateInputDetail)
    && 'preview' in input && isTemplatePreview(input.preview)
    && 'notFor' in input && isStringArray(input.notFor)
    && 'variants' in input && Array.isArray(input.variants) && input.variants.every(isTemplateVariant)
    && 'tags' in input && isStringArray(input.tags)
    && 'audio' in input && typeof input.audio === 'string'
    && 'status' in input && ['stable', 'experimental', 'deprecated', 'unknown'].includes(String(input.status))
    && 'distribution' in input && ['bundled', 'local-only', 'unknown'].includes(String(input.distribution))
    && 'valid' in input && typeof input.valid === 'boolean'
    && (!('issue' in input) || input.issue === undefined || (
      typeof input.issue === 'object' && input.issue !== null
      && 'code' in input.issue && typeof input.issue.code === 'string'
      && 'message' in input.issue && typeof input.issue.message === 'string'
    ))
}

export function isTemplateListResponse(input: unknown): input is TemplateListResponse {
  return typeof input === 'object' && input !== null && 'ok' in input && input.ok === true
    && 'templates' in input && Array.isArray(input.templates) && input.templates.every(isLauncherTemplate)
}

/** チェックリスト step（軸数 n のとき n+1） */
export function checklistStep(variants: readonly TemplateVariant[]): number {
  return variants.length + 1
}

export function defaultOptionIdFor(variant: TemplateVariant): string | undefined {
  return variant.defaultOptionId ?? variant.options[0]?.id
}

/** 型選択直後の choices（先頭軸の default のみ事前選択） */
export function initialChoicesForTemplate(template: LauncherTemplate): Record<string, string> {
  const first = template.variants[0]
  if (!first?.defaultOptionId) return {}
  return { [first.id]: first.defaultOptionId }
}

/**
 * 軸 option 選択。
 * - 既存と異なる選択なら下流 choices をリセットし、次軸 default は付けない
 * - 初回選択 / 同一 option 再確定なら、次軸に default があれば事前選択
 * - 自動で次 step へ進む
 */
export function applyAxisChoice(
  variants: readonly TemplateVariant[],
  choices: Readonly<Record<string, string>>,
  axisIndex: number,
  optionId: string,
): { choices: Record<string, string>; step: number } {
  const axis = variants[axisIndex]
  if (!axis) {
    return { choices: { ...choices }, step: checklistStep(variants) }
  }

  const previous = choices[axis.id]
  const isChange = previous !== undefined && previous !== optionId
  const nextChoices: Record<string, string> = { ...choices, [axis.id]: optionId }

  if (isChange) {
    for (let index = axisIndex + 1; index < variants.length; index += 1) {
      delete nextChoices[variants[index]!.id]
    }
  }

  const nextStep = axisIndex + 2
  if (nextStep <= variants.length) {
    const nextAxis = variants[nextStep - 1]!
    if (!isChange && nextAxis.defaultOptionId && nextChoices[nextAxis.id] === undefined) {
      nextChoices[nextAxis.id] = nextAxis.defaultOptionId
    }
  }

  return { choices: nextChoices, step: nextStep }
}

/** 未選択軸を default（無ければ先頭 option）で埋めてチェックリストへ */
export function fillDefaultsToChecklist(
  variants: readonly TemplateVariant[],
  choices: Readonly<Record<string, string>>,
): { choices: Record<string, string>; step: number } {
  const nextChoices: Record<string, string> = { ...choices }
  for (const variant of variants) {
    if (nextChoices[variant.id] !== undefined) continue
    const fallback = defaultOptionIdFor(variant)
    if (fallback) nextChoices[variant.id] = fallback
  }
  return { choices: nextChoices, step: checklistStep(variants) }
}

export function optionLabelFor(
  template: Pick<LauncherTemplate, 'variants'>,
  axisId: string,
  optionId: string,
): string | undefined {
  const variant = template.variants.find((entry) => entry.id === axisId)
  return variant?.options.find((option) => option.id === optionId)?.label
}

export function partitionRequiredInputs(details: readonly TemplateInputDetail[]): {
  required: TemplateInputDetail[]
  optional: TemplateInputDetail[]
} {
  const required: TemplateInputDetail[] = []
  const optional: TemplateInputDetail[] = []
  for (const detail of details) {
    if (detail.required === false) optional.push(detail)
    else required.push(detail)
  }
  return { required, optional }
}

export function buildTemplateBriefMarkdown(
  template: Pick<LauncherTemplate, 'name' | 'summary' | 'variants' | 'requiredInputDetails' | 'notFor' | 'audio'>,
  choices: Readonly<Record<string, string>>,
): string {
  const { required, optional } = partitionRequiredInputs(template.requiredInputDetails)
  const lines: string[] = [
    `# ${template.name}`,
    '',
    template.summary,
    '',
    '## 選択内容',
  ]

  for (const variant of template.variants) {
    const optionId = choices[variant.id]
    const option = variant.options.find((entry) => entry.id === optionId)
    lines.push(`- **${variant.label}**: ${option?.label ?? '（未選択）'}`)
  }

  lines.push('', '## 用意するもの', '', '### 必須')
  if (required.length === 0) {
    lines.push('- （なし）')
  } else {
    for (const input of required) {
      lines.push(`- ${input.label}（${TEMPLATE_INPUT_TYPE_LABELS[input.type]}）`)
    }
  }

  lines.push('', '### 任意')
  if (optional.length === 0) {
    lines.push('- （なし）')
  } else {
    for (const input of optional) {
      lines.push(`- ${input.label}（${TEMPLATE_INPUT_TYPE_LABELS[input.type]}）`)
    }
  }

  if (template.notFor.length > 0) {
    lines.push('', '## 向かない用途')
    for (const item of template.notFor) lines.push(`- ${item}`)
  }

  if (template.audio) {
    lines.push('', '## 音声', template.audio)
  }

  return `${lines.join('\n')}\n`
}
