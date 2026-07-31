/**
 * Deterministic conceptual preview specs for expression cards.
 * Built only from metadata (id / title / description / tags / role).
 * Never claims to be a real render or official catalog implementation.
 */

import type {
  ExpressionAspect,
  ExpressionItem,
  ExpressionRole,
  ExpressionSource,
  PreviewFidelity,
} from './expressionLibraryModel'

/** Shared sample text rendered in every expression preview. */
export const EXPRESSION_PREVIEW_SAMPLE_TEXT = 'TSUGITE 継ぎ手'

export type PreviewMotionFamily =
  | 'typewriter'
  | 'fade'
  | 'slide'
  | 'wipe'
  | 'scale'
  | 'rotate'
  | 'pulse'
  | 'bars'
  | 'line-draw'
  | 'orbit'
  | 'glitch'
  | 'stack'

export type PreviewDirection = 'up' | 'down' | 'left' | 'right' | 'in' | 'out'

export interface ExpressionPreviewSpec {
  /** Stable signature so identical metadata always yields the same motion. */
  signature: string
  family: PreviewMotionFamily
  direction: PreviewDirection
  distance: number
  delayMs: number
  durationMs: number
  staggerMs: number
  intensity: number
  sampleText: string
  /** Short Japanese note: what this sample is / is not. */
  fidelityNote: string
  /** Short Japanese note for the motion family (for aria / caption). */
  familyLabel: string
  conceptualOnly: true
  fidelity: PreviewFidelity
  source: ExpressionSource
  role: ExpressionRole
  aspect: ExpressionAspect
}

export type ExpressionPreviewInput = Pick<
  ExpressionItem,
  | 'nativeId'
  | 'title'
  | 'description'
  | 'tags'
  | 'role'
  | 'source'
  | 'previewFidelity'
  | 'aspect'
  | 'category'
  | 'features'
  | 'pace'
  | 'tone'
  | 'family'
>

const FAMILY_LABELS: Record<PreviewMotionFamily, string> = {
  typewriter: '文字が順に出る',
  fade: 'ふわっと現れる',
  slide: 'スライドして入る',
  wipe: '拭き取るように切り替わる',
  scale: '拡大・縮小する',
  rotate: '回転しながら現れる',
  pulse: 'リズムよく点滅する',
  bars: '棒が伸びる',
  'line-draw': '線が描かれる',
  orbit: '円を描いて回る',
  glitch: '一瞬ずらして強調する',
  stack: '重なって並ぶ',
}

const DIRECTIONS: PreviewDirection[] = ['up', 'down', 'left', 'right', 'in', 'out']

/**
 * Internal capability / plumbing tags must not drive motion family.
 * These appear on presentation presets (e.g. executable-candidate contains "cut").
 */
const INTERNAL_MOTION_TAG_BLOCKLIST = new Set([
  'presentation-preset',
  'executable-candidate',
  'declared-executable-candidate',
  'reference-only',
  'verified-executable',
  'brand-lock',
  'brand',
  'fixed',
  'aspect-unknown',
  '16:9',
  '9:16',
  '1:1',
  'remotion',
  'hyperframes',
  'editframe',
])

/** FNV-1a 32-bit — pure, stable across runtimes. */
export function stableHash(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function pickFromHash<T>(hash: number, items: readonly T[], salt = 0): T {
  return items[(hash + salt) % items.length]!
}

function metadataBag(input: ExpressionPreviewInput): string {
  return [
    input.nativeId,
    input.title,
    input.description,
    input.role,
    input.source,
    input.category,
    input.family,
    ...input.tags,
    ...input.features,
    ...input.pace,
    ...input.tone,
  ].join('\u0001').toLowerCase()
}

function isInternalMotionToken(token: string): boolean {
  return INTERNAL_MOTION_TAG_BLOCKLIST.has(token.toLowerCase())
}

/**
 * Motion-keyword corpus: human-facing metadata only.
 * Internal capability tags (executable-candidate etc.) are excluded.
 */
function motionSearchCorpus(input: ExpressionPreviewInput): string {
  const allowedTags = [...input.tags, ...input.features]
    .filter((token) => token && !isInternalMotionToken(token))
  return [
    input.nativeId,
    input.title,
    input.description,
    input.category,
    input.family,
    ...allowedTags,
  ].join(' ').toLowerCase()
}

/**
 * English terms match on word/token boundaries so "cut" does not hit
 * "executable-candidate". Japanese / CJK terms use substring match.
 */
function matchesMotionKeyword(corpus: string, pattern: RegExp): boolean {
  return pattern.test(corpus)
}

/**
 * Keyword → family mapping. First match wins (order is intentional).
 * Module-level so 100+ catalog items do not reallocate RegExp/arrays per call.
 */
const MOTION_KEYWORD_RULES: ReadonlyArray<{ re: RegExp; family: PreviewMotionFamily }> = [
  { re: /\btypewriter\b|タイプライタ|\bcaption\b|字幕|text[-\s]?overlay|文字|type[-\s]?text/, family: 'typewriter' },
  { re: /\bglitch\b|グリッチ|\bdistort\b|\bjitter\b|ノイズ/, family: 'glitch' },
  { re: /\bwipe\b|ワイプ|reveal[-\s]?wipe|\bcurtain\b/, family: 'wipe' },
  { re: /\borbit\b|\borbital\b|circle[-\s]?path|回転軌道|\bsatellite\b/, family: 'orbit' },
  { re: /\bdraw\b|\bstroke\b|path[-\s]?anim|line[-\s]?draw|線描|手書き/, family: 'line-draw' },
  { re: /\bbar\b|\bbars\b|\bchart\b|\bgraph\b|\bhistogram\b|データ|図表|\bstats\b|\bcounter\b/, family: 'bars' },
  { re: /\bstack\b|\blayer\b|card[-\s]?stack|重な|カード積み/, family: 'stack' },
  { re: /\bpulse\b|\bbreathe\b|\bheartbeat\b|点滅|鼓動|\bblink\b/, family: 'pulse' },
  { re: /\bscale\b|\bzoom\b|\bpop\b|拡大|縮小/, family: 'scale' },
  { re: /\brotate\b|\bspin\b|\bturn\b|回転/, family: 'rotate' },
  { re: /\bslide\b|\bswipe\b|\bpan\b|スライド|横滑り/, family: 'slide' },
  { re: /\bfade\b|\bdissolve\b|cross[-\s]?fade|フェード|溶ける/, family: 'fade' },
  { re: /\bshader\b|\bmesh\b|\bparticle\b|\b3d\b|シェーダ|パーティクル/, family: 'orbit' },
  // \bcut\b: token boundary — must not match inside "executable-candidate"
  { re: /\btransition\b|切替|切り替え|\bcut\b/, family: 'wipe' },
  { re: /\bsocial\b|\bchip\b|\bbadge\b|\bsns\b|配信/, family: 'stack' },
  { re: /\bcode\b|\bterminal\b|\bdev\b|コード|ターミナル/, family: 'line-draw' },
]

/**
 * Keyword → family mapping. First match wins (order is intentional).
 * Role is used as a soft prior when no strong keyword hits.
 */
function resolveFamily(input: ExpressionPreviewInput, hash: number): PreviewMotionFamily {
  const text = motionSearchCorpus(input)

  for (const rule of MOTION_KEYWORD_RULES) {
    if (matchesMotionKeyword(text, rule.re)) return rule.family
  }

  switch (input.role) {
    case 'text-overlay':
      return 'typewriter'
    case 'data-viz':
      return 'bars'
    case 'code-dev':
      return 'line-draw'
    case 'transition':
      return 'wipe'
    case '3d-shader':
      return 'orbit'
    case 'social':
      return 'stack'
    case 'full-composition':
      return pickFromHash(hash, ['stack', 'slide', 'fade', 'scale'] as const, 1)
    case 'auxiliary':
      return pickFromHash(hash, ['fade', 'pulse', 'slide', 'scale'] as const, 2)
    default:
      return pickFromHash(
        hash,
        ['fade', 'slide', 'scale', 'pulse', 'rotate', 'stack'] as const,
        3,
      )
  }
}

function fidelityNoteFor(input: ExpressionPreviewInput): string {
  if (input.source === 'reference-catalog') {
    return 'メタデータから作った概念見本。公式実装の再現ではありません'
  }
  if (input.previewFidelity === 'media-preview') {
    return '実preview / 実映像'
  }
  // presentation preset: conceptual sample from name/description — not real composition/motion
  return '候補名や説明から作った概念見本。実際の構成・動きの再現ではありません'
}

/**
 * Build a pure, deterministic preview spec from expression metadata.
 * Same input always yields the same signature and motion parameters.
 */
export function buildExpressionPreviewSpec(input: ExpressionPreviewInput): ExpressionPreviewSpec {
  const bag = metadataBag(input)
  const hash = stableHash(bag)
  const family = resolveFamily(input, hash)
  const direction = pickFromHash(hash, DIRECTIONS, 11)
  // Vary distance / timing by hash so same-role items still differ.
  const distance = 8 + (hash % 18) // 8–25
  const durationMs = 1200 + (hash % 1400) // 1.2s–2.6s
  const delayMs = (hash >>> 8) % 400
  const staggerMs = 40 + ((hash >>> 16) % 120)
  const intensity = clamp(0.35 + ((hash % 50) / 100), 0.35, 0.85)
  const signature = [
    family,
    direction,
    distance,
    durationMs,
    delayMs,
    staggerMs,
    Math.round(intensity * 100),
  ].join('|')

  return {
    signature,
    family,
    direction,
    distance,
    delayMs,
    durationMs,
    staggerMs,
    intensity,
    sampleText: EXPRESSION_PREVIEW_SAMPLE_TEXT,
    fidelityNote: fidelityNoteFor(input),
    familyLabel: FAMILY_LABELS[family],
    conceptualOnly: true,
    fidelity: input.previewFidelity,
    source: input.source,
    role: input.role,
    aspect: input.aspect,
  }
}

/** CSS custom properties derived from a preview spec (transform/opacity only). */
export function previewSpecCssVars(spec: ExpressionPreviewSpec): Record<string, string> {
  const axis =
    spec.direction === 'left' || spec.direction === 'right'
      ? 'x'
      : spec.direction === 'up' || spec.direction === 'down'
        ? 'y'
        : 'scale'
  const signed =
    spec.direction === 'left' || spec.direction === 'up' || spec.direction === 'in'
      ? -spec.distance
      : spec.distance

  return {
    '--expr-preview-duration': `${spec.durationMs}ms`,
    '--expr-preview-delay': `${spec.delayMs}ms`,
    '--expr-preview-stagger': `${spec.staggerMs}ms`,
    '--expr-preview-distance': `${signed}px`,
    '--expr-preview-intensity': String(spec.intensity),
    '--expr-preview-axis': axis,
  }
}
