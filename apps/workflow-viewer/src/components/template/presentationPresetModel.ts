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
  /** 非エンジニア向けの短い説明。未知 ID は null。 */
  description: string | null
  aspectRatio: PresentationAspectRatio | null
}

export type PresentationPresetSelection = {
  backend: string
  presetId: string
} | null

/** 正式対応 backend の表示順（第一スライス） */
export const PRESENTATION_PRESET_BACKENDS = ['remotion', 'hyperframes'] as const

export type PresentationPresetBackendId = (typeof PRESENTATION_PRESET_BACKENDS)[number]

/**
 * ブランド固有の presentation preset ID。
 * 汎用推薦から外し、UI では「ブランド固定」と明示する。
 * street-dialogue は backends/remotion/streetDialogue.js が PAKU PAKU を固定表示。
 */
export const BRAND_LOCKED_PRESENTATION_PRESET_IDS = [
  'street-dialogue-16x9',
  'tsugite-summer-camp-generated-16x9',
  'miraichi-lastcall-9x16',
  'orbital-showreel-16x9',
] as const

export function isBrandLockedPresentationPresetId(presetId: string): boolean {
  return (BRAND_LOCKED_PRESENTATION_PRESET_IDS as readonly string[]).includes(presetId)
}

const BACKEND_LABELS: Record<string, string> = {
  remotion: 'Remotion',
  hyperframes: 'HyperFrames',
}

/**
 * 用途が分かる一般向け表示名。未知 ID は labelForPresentationPreset が ID を返す。
 * API は id だけ返すため、表示用のローカル辞書。内部 ID / capabilities は不変。
 */
const PRESET_PURPOSE_LABELS: Record<string, string> = {
  'article-dialogue-16x9': '横型・会話で解説',
  'street-dialogue-16x9': '横型・テンポ重視の会話解説',
  'tsugite-summer-camp-generated-16x9': '横型・イベント／サービス告知',
  'miraichi-lastcall-9x16': '縦型・締切／申込案内',
  'orbital-showreel-16x9': '横型・作品ダイジェスト',
  'article-explainer-16x9': '横型・資料付き解説',
  'article-explainer-9x16': '縦型・資料付き解説',
}

/** 非エンジニア向けの短い説明。未知 ID は descriptionForPresentationPreset が null を返す。 */
const PRESET_PURPOSE_DESCRIPTIONS: Record<string, string> = {
  'article-dialogue-16x9':
    '記事やテーマを、会話のやりとりでわかりやすく伝える向きです。',
  'street-dialogue-16x9':
    'テンポよく会話が進む解説向きです。短くキャッチーに見せたいときに。',
  'tsugite-summer-camp-generated-16x9':
    'イベントやサービスの告知・募集を横型で伝える向きです。',
  'miraichi-lastcall-9x16':
    '締切や申込案内など、縦型のSNS向け案内向きです。',
  'orbital-showreel-16x9':
    '作品や事例をダイジェストで見せる向きです。',
  'article-explainer-16x9':
    '資料や図解を交えて解説する横型向けです。',
  'article-explainer-9x16':
    '資料や図解を交えて解説する縦型向けです。',
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

export function descriptionForPresentationPreset(presetId: string): string | null {
  return PRESET_PURPOSE_DESCRIPTIONS[presetId] ?? null
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
    description: descriptionForPresentationPreset(id),
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
    '## 仕上げの動き（実行候補）',
    '',
    `- **backend**: ${selection.backend}（${backendLabelFor(selection.backend)}）`,
    `- **preset**: \`${selection.presetId}\` — ${purpose}`,
    `- ${PRESENTATION_PRESET_SAFETY_NOTE}`,
    '',
  ]
  return lines.join('\n')
}
