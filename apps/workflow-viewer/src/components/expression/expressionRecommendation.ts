/**
 * Deterministic local recommendation for the expression shelf.
 * No network, no AI API — versioned JA/EN lexicon + catalog metadata only.
 */

import type { ExpressionItem, PreviewFidelity } from './expressionLibraryModel'

export const LEXICON_VERSION = 'v1'

export type RecommendationAspect = '16:9' | '9:16' | '1:1' | 'any' | null
export type RecommendationPurpose =
  | 'explainer'
  | 'dialogue'
  | 'promo'
  | 'showreel'
  | 'data'
  | 'dev'
  | 'social'
  | 'other'
  | string
  | null

export type RecommendationReadiness = 'explore' | 'ready'

export interface RecommendationIntent {
  freeText: string
  aspect?: RecommendationAspect
  purpose?: RecommendationPurpose
  readiness?: RecommendationReadiness
  reducedMotion?: boolean
  brandFixed?: boolean
  avoid?: readonly string[]
}

export type RecommendationBand = 'recommend' | 'reference' | 'insufficient'

export interface RecommendationEntry {
  item: ExpressionItem
  score: number
  band: RecommendationBand
  reasons: string[]
  cautions: string[]
  executable: boolean
  previewFidelity: PreviewFidelity
}

export interface RecommendationResult {
  recommendations: RecommendationEntry[]
  clarification: string | null
  lexiconVersion: typeof LEXICON_VERSION
}

type LexiconBucket = {
  purpose: string
  terms: readonly string[]
}

/** Versioned bilingual lexicon. Keep stable for deterministic scoring. */
const PURPOSE_LEXICON: readonly LexiconBucket[] = [
  {
    purpose: 'explainer',
    terms: ['解説', '説明', 'explainer', 'explain', '記事', 'article', '資料', 'document', '学習', 'learn'],
  },
  {
    purpose: 'dialogue',
    terms: ['会話', 'dialogue', '掛け合い', '対談', 'talk', 'conversation', 'peer'],
  },
  {
    purpose: 'promo',
    terms: ['告知', '募集', '申込', '締切', 'promo', 'campaign', 'event', 'イベント', 'cta', 'lastcall'],
  },
  {
    purpose: 'showreel',
    terms: ['ダイジェスト', 'showreel', '作品', '事例', 'portfolio', 'reel', 'digest'],
  },
  {
    purpose: 'data',
    terms: ['データ', 'data', 'chart', '統計', 'statistics', 'グラフ', 'graph', '数値'],
  },
  {
    purpose: 'dev',
    terms: ['コード', 'code', 'terminal', '開発', 'dev', 'developer', 'ide', 'console'],
  },
  {
    purpose: 'social',
    terms: ['sns', 'social', '配信', 'stream', 'live', 'chat', '縦型', 'ショート'],
  },
] as const

const TONE_LEXICON = {
  calm: ['落ち着', '静か', 'calm', 'quiet', 'gentle', 'やわらか'],
  brisk: ['テンポ', '速い', 'brisk', 'fast', 'quick', 'キャッチー'],
  cinematic: ['シネマ', 'cinematic', 'dramatic', '劇的', 'flashy'],
  conversational: ['会話', 'dialogue', 'friendly', '掛け合い'],
  explanatory: ['解説', 'explainer', '資料', '説明'],
} as const

const FLASHY_TERMS = [
  'flashy',
  'cinematic',
  'particle',
  'burst',
  'shader',
  '3d',
  'dramatic',
  '派手',
  '過剰',
] as const

const REDUCED_MOTION_EXCLUDE = [
  'particle',
  'burst',
  'flashy',
  'shake',
  'glitch',
  'strobe',
] as const

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
}

function includesAny(haystack: string, terms: readonly string[]): boolean {
  return terms.some((term) => haystack.includes(normalizeText(term)))
}

function detectPurposes(intent: RecommendationIntent): string[] {
  const text = normalizeText([
    intent.freeText,
    intent.purpose ?? '',
  ].join(' '))
  const found = PURPOSE_LEXICON
    .filter((bucket) => includesAny(text, bucket.terms) || normalizeText(intent.purpose ?? '') === bucket.purpose)
    .map((bucket) => bucket.purpose)
  if (found.length > 0) return found
  if (intent.purpose && intent.purpose !== 'other') return [normalizeText(intent.purpose)]
  return []
}

function detectTones(text: string): string[] {
  return Object.entries(TONE_LEXICON)
    .filter(([, terms]) => includesAny(text, terms))
    .map(([tone]) => tone)
}

function hardExclude(
  item: ExpressionItem,
  intent: RecommendationIntent,
  text: string,
): string | null {
  if (intent.aspect && intent.aspect !== 'any' && item.aspect && item.aspect !== 'unknown') {
    if (item.aspect !== intent.aspect) return 'aspect-mismatch'
  }

  const avoid = (intent.avoid ?? []).map(normalizeText).filter(Boolean)
  if (avoid.length > 0) {
    const bag = normalizeText([
      item.title,
      item.description,
      item.nativeId,
      item.family,
      ...item.tags,
      ...item.features,
    ].join(' '))
    if (avoid.some((term) => bag.includes(term))) return 'avoid'
  }

  if (intent.reducedMotion) {
    const bag = normalizeText([...item.tags, ...item.features, item.title, item.description].join(' '))
    if (REDUCED_MOTION_EXCLUDE.some((term) => bag.includes(term))) return 'reduced-motion'
  }

  if (intent.brandFixed) {
    // ブランド固定用途: brandLock のない参考表現は除外。実行候補は可。
    if (item.source === 'reference-catalog' && !item.brandLock) return 'brand-lock'
  } else if (item.brandLock) {
    // 一般用途: ブランド固定 preset / 参考表現は汎用推薦から除外
    return 'brand-lock-generic'
  }

  if (intent.readiness === 'ready' && item.capability === 'reference-only') {
    return 'reference-only-when-ready'
  }

  // unused text reserved for future soft signals
  void text
  return null
}

function scoreItem(
  item: ExpressionItem,
  intent: RecommendationIntent,
  purposes: string[],
  tones: string[],
  text: string,
): { score: number; reasons: string[]; cautions: string[] } {
  let score = 20
  const reasons: string[] = []
  const cautions: string[] = []

  // Purpose / role / feature
  const itemBag = normalizeText([
    item.title,
    item.description,
    item.category,
    item.role,
    item.family,
    ...item.tags,
    ...item.features,
  ].join(' '))

  for (const purpose of purposes) {
    const bucket = PURPOSE_LEXICON.find((entry) => entry.purpose === purpose)
    if (!bucket) continue
    if (includesAny(itemBag, bucket.terms) || itemBag.includes(purpose)) {
      score += 18
      reasons.push(`目的「${purpose}」に合う語彙・役割`)
    }
  }

  // Free-text token overlap
  const tokens = tokenize(intent.freeText).filter((token) => token.length >= 2)
  let tokenHits = 0
  for (const token of tokens) {
    if (itemBag.includes(token)) tokenHits += 1
  }
  if (tokenHits > 0) {
    score += Math.min(24, tokenHits * 6)
    reasons.push('自由文の語句が一致')
  }

  // Aspect soft boost
  if (intent.aspect && intent.aspect !== 'any') {
    if (item.aspect === intent.aspect) {
      score += 12
      reasons.push(`比率 ${intent.aspect} が一致`)
    } else if (!item.aspect || item.aspect === 'unknown') {
      score += 2
    }
  }

  // Tone / pace
  for (const tone of tones) {
    if (item.tone.includes(tone) || includesAny(itemBag, TONE_LEXICON[tone as keyof typeof TONE_LEXICON] ?? [])) {
      score += 6
      reasons.push(`トーン「${tone}」が近い`)
    }
  }

  // Availability preference
  if (item.capability === 'declared-executable-candidate') {
    score += 8
    reasons.push('実行候補として宣言されている')
  } else if (item.capability === 'reference-only') {
    score += 2
    cautions.push('参考情報で、実行保証はありません')
  }

  if (intent.readiness === 'explore' && item.capability === 'reference-only') {
    score += 3
  }

  // Duration soft signal
  if (/\d+\s*秒/.test(intent.freeText) && item.durationSeconds) {
    score += 3
    reasons.push('尺の目安が近い')
  }

  // Excess motion penalty (default: prefer calmer)
  const flashyHits = FLASHY_TERMS.filter((term) => itemBag.includes(term)).length
  if (flashyHits > 0 && !includesAny(text, ['派手', 'flashy', 'cinematic', '劇的'])) {
    score -= Math.min(20, flashyHits * 6)
    cautions.push('過剰演出の可能性があるため減点')
  }

  // Never claim verified
  if (item.capability !== 'verified-executable') {
    cautions.push('現状は verified-executable ではありません')
  }
  cautions.push(item.previewFidelity === 'composition-storyboard'
    ? '表示は構成イメージです'
    : '表示は動きのイメージで、実際の出力ではありません')

  if (reasons.length === 0) {
    reasons.push('メタデータの部分一致')
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  return { score, reasons: dedupe(reasons), cautions: dedupe(cautions) }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

function bandFor(score: number): RecommendationBand {
  if (score >= 60) return 'recommend'
  if (score >= 45) return 'reference'
  return 'insufficient'
}

function compareEntries(left: RecommendationEntry, right: RecommendationEntry): number {
  if (right.score !== left.score) return right.score - left.score
  if (left.item.source !== right.item.source) {
    return left.item.source === 'presentation-preset' ? -1 : 1
  }
  return left.item.key.localeCompare(right.item.key)
}

function diversify(entries: RecommendationEntry[], limit: number): RecommendationEntry[] {
  const picked: RecommendationEntry[] = []
  const usedFamilies = new Set<string>()
  for (const entry of entries) {
    if (picked.length >= limit) break
    if (usedFamilies.has(entry.item.family)) continue
    picked.push(entry)
    usedFamilies.add(entry.item.family)
  }
  // If under-filled, allow same-family fill deterministically
  if (picked.length < limit) {
    for (const entry of entries) {
      if (picked.length >= limit) break
      if (picked.some((item) => item.item.key === entry.item.key)) continue
      picked.push(entry)
    }
  }
  return picked
}

export function recommendExpressions(
  items: readonly ExpressionItem[],
  intent: RecommendationIntent,
): RecommendationResult {
  const text = normalizeText(intent.freeText ?? '')
  const purposes = detectPurposes(intent)
  const tones = detectTones(text)
  const scored: RecommendationEntry[] = []

  for (const item of items) {
    const excluded = hardExclude(item, intent, text)
    if (excluded) continue
    const { score, reasons, cautions } = scoreItem(item, intent, purposes, tones, text)
    if (score < 45) continue
    scored.push({
      item,
      score,
      band: bandFor(score),
      reasons,
      cautions,
      executable: item.capability !== 'reference-only',
      previewFidelity: item.previewFidelity,
    })
  }

  scored.sort(compareEntries)
  const recommendations = diversify(scored, 3)

  if (recommendations.length === 0) {
    return {
      recommendations: [],
      clarification: '比率・目的・実行候補（未検証）かどうか、どれを優先しますか？',
      lexiconVersion: LEXICON_VERSION,
    }
  }

  return {
    recommendations,
    clarification: null,
    lexiconVersion: LEXICON_VERSION,
  }
}
