import {
  formatExpressionCandidatesPromptSection,
  type ExpressionSelection,
  type ExpressionSelectionMode,
} from '../expression/expressionLibraryModel'

export type { ExpressionSelection, ExpressionSelectionMode }

export interface LauncherTemplateDirection {
  pacing?: string
  camera?: string
  lightColor?: string
  motif?: string
  transitions?: string
  audioSync?: string
}

export interface LauncherTemplateExamples {
  good: string[]
  monotonous: string[]
}

export interface LauncherTemplatePromptGuide {
  catalogId: string
  displayName: string
  checklist: Array<{ id: string; instruction: string }>
  disclaimer: string
}

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
  /** テンプレート単位の演出指針（任意）。制作ブリーフへ載せる。 */
  direction?: LauncherTemplateDirection
  promptGuideCatalog?: string
  promptGuides?: LauncherTemplatePromptGuide[]
  /**
   * AI が初案を出してよい項目（任意）。
   * 必須不足として止めず、正本素材と選択設定から提案する。
   */
  aiCanPropose?: string[]
  variants: Array<{
    id: string
    label: string
    defaultOptionId?: string
    options: Array<{
      id: string
      label: string
      description: string
      /** この option 選択時に base direction へ足す演出行（任意）。 */
      directionAdd?: LauncherTemplateDirection
      examples?: LauncherTemplateExamples
      promptGuideCatalog?: string
      /** base 任意入力を必須へ昇格する label 一覧（Phase 4）。 */
      requiredInputsAdd?: string[]
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
  /** 表現棚で明示選択した候補（全体構成1 + 補助最大2）。棚をまたいでも保持する。 */
  expressionSelections: ExpressionSelection[]
  /** unset=おすすめ候補を未選択 / explicit=表現棚または最終画面で明示選択 */
  expressionSelectionMode: ExpressionSelectionMode
}

export const INITIAL_WIZARD_STATE: TemplateWizardState = {
  templateId: null,
  choices: {},
  step: 0,
  expressionSelections: [],
  expressionSelectionMode: 'unset',
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

/** ブリーフ「演出指針」の表示順と日本語ラベル */
export const TEMPLATE_DIRECTION_FIELDS = [
  { key: 'pacing', label: 'テンポ' },
  { key: 'camera', label: 'カメラ' },
  { key: 'lightColor', label: '光と色' },
  { key: 'motif', label: 'モチーフ' },
  { key: 'transitions', label: 'トランジション' },
  { key: 'audioSync', label: '音との同期' },
] as const satisfies ReadonlyArray<{ key: keyof LauncherTemplateDirection; label: string }>

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

function isTemplateExamples(input: unknown): input is LauncherTemplateExamples {
  if (typeof input !== 'object' || input === null) return false
  const record = input as Record<string, unknown>
  const good = record.good
  const monotonous = record.monotonous
  const goodOk = good === undefined || (Array.isArray(good) && good.every((item) => typeof item === 'string'))
  const monoOk = monotonous === undefined
    || (Array.isArray(monotonous) && monotonous.every((item) => typeof item === 'string'))
  if (!goodOk || !monoOk) return false
  const goodCount = Array.isArray(good) ? good.length : 0
  const monoCount = Array.isArray(monotonous) ? monotonous.length : 0
  return goodCount + monoCount > 0
}

function isTemplatePromptGuide(input: unknown): input is LauncherTemplatePromptGuide {
  return typeof input === 'object' && input !== null
    && 'catalogId' in input && typeof input.catalogId === 'string'
    && 'displayName' in input && typeof input.displayName === 'string'
    && 'disclaimer' in input && typeof input.disclaimer === 'string'
    && 'checklist' in input && Array.isArray(input.checklist)
    && input.checklist.every((item) => (
      typeof item === 'object' && item !== null
      && 'id' in item && typeof item.id === 'string'
      && 'instruction' in item && typeof item.instruction === 'string'
    ))
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
      && (!('directionAdd' in option)
        || option.directionAdd === undefined
        || isTemplateDirection(option.directionAdd))
      && (!('examples' in option)
        || option.examples === undefined
        || isTemplateExamples(option.examples))
      && (!('promptGuideCatalog' in option)
        || option.promptGuideCatalog === undefined
        || typeof option.promptGuideCatalog === 'string')
      && (!('requiredInputsAdd' in option)
        || option.requiredInputsAdd === undefined
        || (Array.isArray(option.requiredInputsAdd)
          && option.requiredInputsAdd.every((label: unknown) => typeof label === 'string')))
    ))
}

function isTemplateInputDetail(input: unknown): input is LauncherTemplate['requiredInputDetails'][number] {
  return typeof input === 'object' && input !== null
    && 'type' in input && typeof input.type === 'string'
    && ['text', 'image', 'audio', 'video', 'data', 'other'].includes(input.type)
    && 'label' in input && typeof input.label === 'string'
    && (!('required' in input) || input.required === undefined || typeof input.required === 'boolean')
}

function isTemplateDirection(input: unknown): input is LauncherTemplateDirection {
  if (typeof input !== 'object' || input === null) return false
  const record = input as Record<string, unknown>
  const keys = TEMPLATE_DIRECTION_FIELDS.map((field) => field.key)
  let hasField = false
  for (const [key, value] of Object.entries(record)) {
    if (!(keys as string[]).includes(key)) return false
    if (value !== undefined) {
      if (typeof value !== 'string' || value.trim() === '') return false
      hasField = true
    }
  }
  return hasField
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
    && (!('direction' in input) || input.direction === undefined || isTemplateDirection(input.direction))
    && (!('promptGuideCatalog' in input)
      || input.promptGuideCatalog === undefined
      || typeof input.promptGuideCatalog === 'string')
    && (!('promptGuides' in input)
      || input.promptGuides === undefined
      || (Array.isArray(input.promptGuides) && input.promptGuides.every(isTemplatePromptGuide)))
    && (!('aiCanPropose' in input)
      || input.aiCanPropose === undefined
      || (Array.isArray(input.aiCanPropose)
        && input.aiCanPropose.length >= 1
        && input.aiCanPropose.length <= 12
        && input.aiCanPropose.every((item) => typeof item === 'string' && item.trim() !== '')))
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

/**
 * Phase 4: base required_inputs + 選択 option の required_inputs_add 和集合。
 * 未選択軸は default（無ければ先頭）で埋めて解決する。
 */
export function resolveRequiredInputDetails(
  template: Pick<LauncherTemplate, 'requiredInputDetails' | 'variants'>,
  choices: Readonly<Record<string, string>>,
): TemplateInputDetail[] {
  const promoted = new Set<string>()
  for (const variant of template.variants) {
    const optionId = choices[variant.id] ?? defaultOptionIdFor(variant)
    if (!optionId) continue
    const option = variant.options.find((entry) => entry.id === optionId)
    for (const label of option?.requiredInputsAdd ?? []) {
      if (label.trim()) promoted.add(label.trim())
    }
  }
  return template.requiredInputDetails.map((input) => {
    const baseRequired = input.required !== false
    return {
      ...input,
      required: baseRequired || promoted.has(input.label),
    }
  })
}

/**
 * AI 委任候補の防御的正規化。
 * - trim → 空除去 → 出現順で一意化（React key / 重複指示対策）
 * - 現在の選択で必須になった label と一致する候補は必須優先で除外（矛盾文を出さない）
 * schema が fail-closed でも、直呼び・緩いランタイムデータ向けの二重防御。
 */
export function resolveAiCanPropose(
  template: Pick<LauncherTemplate, 'aiCanPropose' | 'requiredInputDetails' | 'variants'>,
  choices: Readonly<Record<string, string>> = {},
): string[] {
  const requiredLabels = new Set(
    resolveRequiredInputDetails(template, choices)
      .filter((input) => input.required !== false)
      .map((input) => input.label.trim())
      .filter((label) => label.length > 0),
  )
  const seen = new Set<string>()
  const resolved: string[] = []
  for (const raw of template.aiCanPropose ?? []) {
    const item = raw.trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    if (requiredLabels.has(item)) continue
    resolved.push(item)
  }
  return resolved
}

export function listDirectionLines(
  direction: LauncherTemplateDirection | undefined,
): Array<{ label: string; text: string }> {
  if (!direction) return []
  const lines: Array<{ label: string; text: string }> = []
  for (const field of TEMPLATE_DIRECTION_FIELDS) {
    const text = direction[field.key]
    if (typeof text === 'string' && text.trim() !== '') {
      lines.push({ label: field.label, text: text.trim() })
    }
  }
  return lines
}

/**
 * base direction + 選択中 option の direction_add の和集合。
 * 同一キーは上書きせず、base を先に・各 option 追加を後に並べる。
 */
export function resolveDirectionLines(
  template: Pick<LauncherTemplate, 'direction' | 'variants'>,
  choices: Readonly<Record<string, string>>,
): Array<{ label: string; text: string; source?: string }> {
  const lines: Array<{ label: string; text: string; source?: string }> = []

  for (const entry of listDirectionLines(template.direction)) {
    lines.push(entry)
  }

  for (const variant of template.variants) {
    const optionId = choices[variant.id]
    if (!optionId) continue
    const option = variant.options.find((entry) => entry.id === optionId)
    if (!option?.directionAdd) continue
    for (const field of TEMPLATE_DIRECTION_FIELDS) {
      const text = option.directionAdd[field.key]
      if (typeof text === 'string' && text.trim() !== '') {
        lines.push({
          label: field.label,
          text: text.trim(),
          source: option.label,
        })
      }
    }
  }

  return lines
}

/** base + 選択 option の catalog id 和集合（宣言順・重複除去）。 */
export function resolvePromptGuideCatalogIds(
  template: Pick<LauncherTemplate, 'promptGuideCatalog' | 'variants'>,
  choices: Readonly<Record<string, string>>,
): string[] {
  const ids: string[] = []
  if (template.promptGuideCatalog) ids.push(template.promptGuideCatalog)
  for (const variant of template.variants) {
    const optionId = choices[variant.id]
    if (!optionId) continue
    const option = variant.options.find((entry) => entry.id === optionId)
    if (option?.promptGuideCatalog) ids.push(option.promptGuideCatalog)
  }
  return [...new Set(ids)]
}

export function resolvePromptGuidesForBrief(
  template: Pick<LauncherTemplate, 'promptGuideCatalog' | 'promptGuides' | 'variants'>,
  choices: Readonly<Record<string, string>>,
): LauncherTemplatePromptGuide[] {
  const wanted = new Set(resolvePromptGuideCatalogIds(template, choices))
  if (wanted.size === 0 || !template.promptGuides) return []
  return template.promptGuides.filter((guide) => wanted.has(guide.catalogId))
}

export function resolveExampleLines(
  template: Pick<LauncherTemplate, 'variants'>,
  choices: Readonly<Record<string, string>>,
): Array<{ kind: 'good' | 'monotonous'; optionLabel: string; text: string }> {
  const lines: Array<{ kind: 'good' | 'monotonous'; optionLabel: string; text: string }> = []
  for (const variant of template.variants) {
    const optionId = choices[variant.id]
    if (!optionId) continue
    const option = variant.options.find((entry) => entry.id === optionId)
    if (!option?.examples) continue
    for (const text of option.examples.good ?? []) {
      if (text.trim()) lines.push({ kind: 'good', optionLabel: option.label, text: text.trim() })
    }
    for (const text of option.examples.monotonous ?? []) {
      if (text.trim()) {
        lines.push({ kind: 'monotonous', optionLabel: option.label, text: text.trim() })
      }
    }
  }
  return lines
}

export function materialDeliveryInstruction(input: TemplateInputDetail): string {
  switch (input.type) {
    case 'text':
      return '本文を貼り付けるか、参照できるテキストファイルのパスを記載してください。'
    case 'image':
      return '画像を添付するか、参照できるファイルパスを記載してください。'
    case 'audio':
      return '音声ファイルを添付するか、参照できるファイルパスと使用範囲を記載してください。'
    case 'video':
      return '動画ファイルを添付するか、参照できるファイルパスと使用したい範囲を記載してください。'
    case 'data':
      return '正本のファイル・URL、または数値と出典を記載してください。'
    default:
      return '内容を記載するか、参照できるファイルパスを記載してください。'
  }
}

export function requiredMaterialNotices(
  inputs: readonly TemplateInputDetail[],
): string[] {
  const notices = [
    'この制作依頼と一緒に共有された素材だけを正本として扱います。',
  ]
  if (inputs.some((input) => input.type === 'image')) {
    notices.push('画像は提供されたファイルを正本として使い、似た画像を生成して置き換えません。')
  }
  if (inputs.some((input) => input.type === 'image' && /ロゴ|logo/i.test(input.label))) {
    notices.push('商品ロゴは提供された正本を使い、ロゴの文字・形・配色・余白を変更しないでください。')
  }
  if (inputs.some((input) => input.type === 'data')) {
    notices.push('価格・仕様・条件・実績などの事実は、共有された正本と出典だけを使います。')
  }
  notices.push('未提供の事実・実績・権利情報・正本素材を推測・創作しないでください。')
  return notices
}

export type TemplateProductionExpressionInput = {
  mode: ExpressionSelectionMode
  selections: readonly ExpressionSelection[]
}

export function buildTemplateProductionPrompt(
  template: Pick<
    LauncherTemplate,
    | 'name'
    | 'summary'
    | 'variants'
    | 'requiredInputDetails'
    | 'direction'
    | 'aiCanPropose'
  >,
  choices: Readonly<Record<string, string>>,
  expression: TemplateProductionExpressionInput = {
    mode: 'unset',
    selections: [],
  },
): string {
  const { required } = partitionRequiredInputs(
    resolveRequiredInputDetails(template, choices),
  )
  // 必須と一致する AI 候補は除外し、「質問して待つ」と「初案提示」の矛盾文を避ける。
  const aiCanPropose = resolveAiCanPropose(template, choices)
  const lines: string[] = [
    '# 制作依頼',
    '',
    `以下の条件で「${template.name}」を制作してください。`,
    '',
    '## 目的',
    '',
    template.summary,
    '',
    '## 今回の設定',
  ]

  for (const variant of template.variants) {
    const optionId = choices[variant.id] ?? defaultOptionIdFor(variant)
    const option = variant.options.find((entry) => entry.id === optionId)
    lines.push(`- **${variant.label}**: ${option?.label ?? '（未選択）'}`)
  }

  lines.push(
    '',
    '## 一緒に渡す必須素材',
    '',
    '次の素材を、この制作依頼と同じ会話に添付するか、参照できるファイルパス・本文・URLで共有してください。',
  )
  if (required.length === 0) {
    lines.push('- 特別な必須素材はありません。')
  } else {
    for (const input of required) {
      lines.push(
        `- **${input.label}**（${TEMPLATE_INPUT_TYPE_LABELS[input.type]}）`,
        `  - 渡し方: ${materialDeliveryInstruction(input)}`,
      )
    }
  }

  lines.push('', '## 素材の扱い')
  for (const notice of requiredMaterialNotices(required)) {
    lines.push(`- ${notice}`)
  }

  if (aiCanPropose.length > 0) {
    lines.push(
      '',
      '## AIに任せること',
      '',
      '次の項目は必須不足として止めず、正本素材と今回の設定から初案を提示してください。提案であることを明示してください。',
    )
    for (const item of aiCanPropose) {
      lines.push(`- ${item}`)
    }
  }

  const directionLines = resolveDirectionLines(template, choices)
  if (directionLines.length > 0) {
    lines.push('', '## 制作条件')
    for (const entry of directionLines) {
      const label = entry.source ? `${entry.label}（${entry.source}）` : entry.label
      lines.push(`- **${label}**: ${entry.text}`)
    }
  }

  const expressionSection = formatExpressionCandidatesPromptSection({
    mode: expression.mode,
    selections: expression.selections,
  })
  if (expressionSection) {
    lines.push('', ...expressionSection.trimEnd().split('\n'))
  }

  lines.push(
    '',
    '## 最初に行うこと',
    '',
    '1. 必須素材が揃っているか確認してください。',
    '2. 不足している必須項目だけを質問し、回答を待ってください。',
    '3. AIに任せることや未指定の表現は不足扱いせず、質問前提にせず、正本素材と今回の設定から初案を提示してください。提案であることを明示し、事実・実績・権利情報・正本素材は創作しないでください。',
    '4. 素材と前提が揃ったら、制作方針と進め方を短く提示してください。',
  )

  return `${lines.join('\n')}\n`
}
