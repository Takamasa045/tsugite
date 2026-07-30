/**
 * Presentation preset（backend capabilities が宣言する仕上げ構成）の UI 契約。
 * HyperFrames 公式 catalog や motion cue とは別物。実行保証はしない。
 */

export type PresentationPresetLoadState = 'idle' | 'loading' | 'ready' | 'error'
export type PresentationAspectRatio = '16:9' | '9:16'

/** Wire payload from GET /api/presets?backend=… */
export interface PresentationPresetListResponse {
  ok: true
  backend: string
  presets: string[]
}

/** UI row: backend + preset id を一意に扱う */
export interface PresentationPresetOption {
  backend: string
  backendLabel: string
  id: string
  label: string
  aspectRatio: PresentationAspectRatio | null
}

export type PresentationPresetSelection = {
  backend: string
  presetId: string
} | null

/** 正式対応 backend の表示順（第一スライス） */
export const PRESENTATION_PRESET_BACKENDS = ['remotion', 'hyperframes'] as const

export type PresentationPresetBackendId = (typeof PRESENTATION_PRESET_BACKENDS)[number]

const BACKEND_LABELS: Record<string, string> = {
  remotion: 'Remotion',
  hyperframes: 'HyperFrames',
}

/**
 * 用途が分かる日本語ラベル。未知 ID は labelForPresentationPreset が ID を返す。
 * API は id だけ返すため、表示用のローカル辞書。
 */
const PRESET_PURPOSE_LABELS: Record<string, string> = {
  'article-dialogue-16x9': '記事の掛け合い解説',
  'street-dialogue-16x9': 'ストリート風の掛け合い',
  'tsugite-summer-camp-generated-16x9': 'サマーキャンプ風の生成映像',
  'miraichi-lastcall-9x16': '縦型のラストコール',
  'orbital-showreel-16x9': 'オービタル・ショーリール',
  'article-explainer-16x9': '記事の解説スライド',
  'article-explainer-9x16': '縦型の記事解説',
}

export const PRESENTATION_PRESET_SAFETY_NOTE =
  '選択した構成が利用可能か validate と Gate 1 で確認し、非対応なら勝手に別presetへ変えず確認する'

export function backendLabelFor(backend: string): string {
  return BACKEND_LABELS[backend] ?? backend
}

export function aspectRatioFromPresetId(presetId: string): PresentationAspectRatio | null {
  if (/-16x9$/i.test(presetId) || /16x9/i.test(presetId)) return '16:9'
  if (/-9x16$/i.test(presetId) || /9x16/i.test(presetId)) return '9:16'
  return null
}

export function labelForPresentationPreset(presetId: string): string {
  return PRESET_PURPOSE_LABELS[presetId] ?? presetId
}

export function isPresentationPresetListResponse(
  input: unknown,
): input is PresentationPresetListResponse {
  return typeof input === 'object'
    && input !== null
    && 'ok' in input
    && input.ok === true
    && 'backend' in input
    && typeof input.backend === 'string'
    && input.backend.length > 0
    && 'presets' in input
    && Array.isArray(input.presets)
    && input.presets.every((entry) => typeof entry === 'string' && entry.length > 0)
}

export function toPresentationPresetOptions(
  backend: string,
  presetIds: readonly string[],
): PresentationPresetOption[] {
  return presetIds.map((id) => ({
    backend,
    backendLabel: backendLabelFor(backend),
    id,
    label: labelForPresentationPreset(id),
    aspectRatio: aspectRatioFromPresetId(id),
  }))
}

export function mergePresentationPresetOptions(
  responses: readonly PresentationPresetListResponse[],
): PresentationPresetOption[] {
  const byBackend = new Map(responses.map((entry) => [entry.backend, entry.presets] as const))
  const options: PresentationPresetOption[] = []
  for (const backend of PRESENTATION_PRESET_BACKENDS) {
    const presets = byBackend.get(backend)
    if (!presets) continue
    options.push(...toPresentationPresetOptions(backend, presets))
  }
  // 想定外 backend が混ざっても隠さない
  for (const response of responses) {
    if ((PRESENTATION_PRESET_BACKENDS as readonly string[]).includes(response.backend)) continue
    options.push(...toPresentationPresetOptions(response.backend, response.presets))
  }
  return options
}

export function selectionKey(selection: NonNullable<PresentationPresetSelection>): string {
  return `${selection.backend}::${selection.presetId}`
}

export function optionKey(option: PresentationPresetOption): string {
  return `${option.backend}::${option.id}`
}

export function isSamePresentationPresetSelection(
  left: PresentationPresetSelection,
  right: PresentationPresetSelection,
): boolean {
  if (left === null && right === null) return true
  if (left === null || right === null) return false
  return left.backend === right.backend && left.presetId === right.presetId
}

/** 制作依頼本文へ載せる presentation preset 節。未選択なら空文字。 */
export function formatPresentationPresetPromptSection(
  selection: PresentationPresetSelection,
): string {
  if (!selection) return ''
  const label = labelForPresentationPreset(selection.presetId)
  const aspect = aspectRatioFromPresetId(selection.presetId)
  const aspectText = aspect ? `（${aspect}）` : ''
  const purpose = label === selection.presetId
    ? selection.presetId
    : `${label}${aspectText}`
  const lines = [
    '## 仕上げの動き（presentation preset）',
    '',
    `- **backend**: ${selection.backend}（${backendLabelFor(selection.backend)}）`,
    `- **preset**: \`${selection.presetId}\` — ${purpose}`,
    `- ${PRESENTATION_PRESET_SAFETY_NOTE}`,
    '',
  ]
  return lines.join('\n')
}
