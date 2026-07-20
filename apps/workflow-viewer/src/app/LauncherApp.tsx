import {
  ArrowRight,
  BookOpen,
  Clapperboard,
  Clock3,
  FolderOpen,
  LayoutTemplate,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface LauncherProject {
  id: string
  name: string
  slug: string
  runId: string
  revision: string
  status: string
  updatedAt?: string | null
  hasViewer: boolean
  viewerUrl?: string
  thumbnailUrl?: string
  valid: boolean
  refreshable: boolean
  issue?: string
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

interface ProjectListResponse {
  ok: true
  projects: LauncherProject[]
}

interface TemplateListResponse {
  ok: true
  templates: LauncherTemplate[]
}

type FeedbackStage = 'observed' | 'recurring' | 'promoted' | 'verified'
type FeedbackSignal = 'prefer' | 'avoid' | 'keep'
type FeedbackPromotionKind = 'template' | 'constraint' | 'validator' | 'qa' | 'rule' | 'documentation'

interface FeedbackPromotion {
  projectId: string
  projectName: string
  kind: FeedbackPromotionKind
  target: string
  promotedAt?: string
}

interface FeedbackPromotionProposal {
  projectId: string
  projectName: string
  id: string
  kind: FeedbackPromotionKind
  target: string
  changeSummary: string
  verification: string
  decision: 'pending' | 'approved' | 'rejected'
  source?: {
    kind: FeedbackAutomationSourceKind
    workflowId: string
    runId?: string
  }
  decidedAt?: string
  decidedBy?: 'human'
}

interface FeedbackIssue {
  code: string
  message: string
  projectName: string
  line?: number
  path?: string
}

interface FeedbackPreference {
  key: string
  category: string
  signal: FeedbackSignal
  stage: FeedbackStage
  summary: string
  projectCount: number
  projectNames: string[]
  runIds: string[]
  evidence: string[]
  promotion?: FeedbackPromotion
  promotions: FeedbackPromotion[]
  promotionProposal?: FeedbackPromotionProposal
  lastSeenAt: string
}

interface FeedbackAggregate {
  metrics: Partial<Record<FeedbackStage, number>> & { issues?: number }
  preferences: FeedbackPreference[]
  issues: FeedbackIssue[]
}

interface FeedbackResponse {
  ok: true
  feedback: FeedbackAggregate
}

interface RefreshResponse {
  ok: true
  viewerUrl: string
  project: LauncherProject
}

interface RefreshErrorResponse {
  ok: false
  issue: {
    code: string
    message: string
  }
}

interface LauncherAppProps {
  fetcher?: typeof fetch
  navigate?: (url: string) => void
  token?: string
}

type Shelf = 'projects' | 'templates' | 'feedback'
type TemplateLoadState = 'idle' | 'loading' | 'ready' | 'error'
type FeedbackLoadState = 'idle' | 'loading' | 'ready' | 'error'
type PromotionDecisionState = 'idle' | 'saving' | 'error'
type ProjectFilter = 'all' | 'active' | 'waiting' | 'completed' | 'invalid'
type FeedbackFilter = 'all' | FeedbackStage

const defaultFetcher: typeof fetch = (...args) => window.fetch(...args)
const PROJECT_PAGE_SIZE = 12
const FEEDBACK_PAGE_SIZE = 24
const FEEDBACK_ISSUE_DISPLAY_LIMIT = 5
const FEEDBACK_AUTOMATION_SOURCE_KINDS = [
  'codex_automation',
  'claude_desktop_automation',
  'claude_code_automation',
] as const
type FeedbackAutomationSourceKind = typeof FEEDBACK_AUTOMATION_SOURCE_KINDS[number]

function isFeedbackAutomationSourceKind(input: unknown): input is FeedbackAutomationSourceKind {
  return typeof input === 'string'
    && FEEDBACK_AUTOMATION_SOURCE_KINDS.includes(input as FeedbackAutomationSourceKind)
}

function pendingPromotionPreferences(feedback: FeedbackAggregate): FeedbackPreference[] {
  return feedback.preferences.filter((preference) => (
    preference.promotionProposal?.decision === 'pending'
    && isFeedbackAutomationSourceKind(preference.promotionProposal.source?.kind)
    && preference.promotionProposal.source.workflowId === 'tsugite-learning-promotion-review'
  ))
}

const PROJECT_FILTERS: Array<{ id: ProjectFilter; label: string }> = [
  { id: 'all', label: 'すべて' },
  { id: 'active', label: '制作中' },
  { id: 'waiting', label: '確認待ち' },
  { id: 'completed', label: '完了' },
  { id: 'invalid', label: '要確認' },
]

const STATUS_LABELS: Record<string, string> = {
  planned: '準備中',
  pending: '準備中',
  running: '制作中',
  rendering: '書き出し中',
  awaiting_gate_1: '制作方針の確認待ち',
  awaiting_gate_2: '素材の確認待ち',
  awaiting_gate_3: '完成動画の確認待ち',
  completed: '完了',
  aborted: '中止',
  error: '要確認',
}

const TEMPLATE_STATUS_LABELS: Record<LauncherTemplate['status'], string> = {
  stable: '安定版',
  experimental: '試験中',
  deprecated: '非推奨',
  unknown: '要確認',
}

const DISTRIBUTION_LABELS: Record<LauncherTemplate['distribution'], string> = {
  bundled: '同梱',
  'local-only': 'ローカル限定',
  unknown: '区分を確認',
}

type TemplateTone = 'product' | 'explainer' | 'assembly' | 'seminar'
type TemplateInputType = LauncherTemplate['requiredInputDetails'][number]['type']

const TEMPLATE_INPUT_TYPE_LABELS: Record<TemplateInputType, string> = {
  text: 'テキスト',
  image: '画像',
  audio: '音声',
  video: '動画',
  data: 'データ',
  other: 'その他',
}

const FALLBACK_TEMPLATE_PREVIEW: NonNullable<LauncherTemplate['preview']> = {
  frames: [
    { kind: 'text', label: '導入' },
    { kind: 'interface', label: '本編' },
    { kind: 'result', label: 'まとめ' },
  ],
  flow: ['導入', '本編', 'まとめ'],
}

function templateTone(category: string): TemplateTone {
  if (/(商品|EC|サービス)/i.test(category)) return 'product'
  if (/(組み立て|手順|組立)/.test(category)) return 'assembly'
  if (/(セミナー|イベント|告知|ショート|シュート)/.test(category)) return 'seminar'
  return 'explainer'
}

function hasUsableTemplatePreview(
  preview: LauncherTemplate['preview'],
): preview is NonNullable<LauncherTemplate['preview']> {
  return preview !== null
    && preview.frames.length === 3
    && preview.flow.length >= 3
    && preview.flow.length <= 5
}

function templatePreview(template: LauncherTemplate): NonNullable<LauncherTemplate['preview']> {
  return hasUsableTemplatePreview(template.preview) ? template.preview : FALLBACK_TEMPLATE_PREVIEW
}

const FEEDBACK_STAGE_LABELS: Record<FeedbackStage, string> = {
  observed: '記録',
  recurring: '学習中',
  promoted: '反映済み',
  verified: '効果確認済み',
}

const FEEDBACK_STAGE_MARKS: Record<FeedbackStage, string> = {
  observed: '壱',
  recurring: '弐',
  promoted: '参',
  verified: '肆',
}

const FEEDBACK_APPLICATION_LABELS: Record<FeedbackStage, string> = {
  observed: 'まず1件を記録',
  recurring: '同じ傾向を確認中',
  promoted: '制作ルールに反映済み',
  verified: '反映後の効果を確認済み',
}

const FEEDBACK_STAGE_DESCRIPTIONS: Record<FeedbackStage, string> = {
  observed: '別の案件でも同じ傾向があるかを見ます。',
  recurring: '複数の案件で同じ傾向を確認しています。',
  promoted: 'テンプレートやルールなど、制作に使う場所へ反映しました。',
  verified: '反映後の案件で、期待した改善を確認できました。',
}

const FEEDBACK_NEXT_STAGE_LABELS: Record<FeedbackStage, string> = {
  observed: '別の案件でも同じ傾向があるか確認',
  recurring: '反映する内容を実装',
  promoted: '後続案件で効果を確認',
  verified: '完了（継続して確認）',
}

const FEEDBACK_NEXT_ACTIONS: Record<FeedbackStage, string> = {
  observed: '同じ好みや失敗が別案件でも起きたら、同じ key で記録します。',
  recurring: '反映する内容を実装し、テストします。完了後に「反映済み」になります。',
  promoted: '反映後の後続案件を確認し、改善できたら「効果確認済み」になります。',
  verified: '追加作業はありません。後続案件でも問題がないかを確認します。',
}

const FEEDBACK_SIGNAL_LABELS: Record<FeedbackSignal, string> = {
  prefer: '取り入れたい',
  avoid: '避けたい',
  keep: '維持したい',
}

const FEEDBACK_PROMOTION_LABELS: Record<FeedbackPromotionKind, string> = {
  template: 'テンプレート',
  constraint: '制約',
  validator: '検証ルール',
  qa: 'QA',
  rule: '運用ルール',
  documentation: 'ドキュメント',
}

const FEEDBACK_PROPOSAL_DECISION_LABELS: Record<FeedbackPromotionProposal['decision'], string> = {
  pending: '昇格承認待ち',
  approved: '承認済み',
  rejected: '見送り済み',
}

const FEEDBACK_STAGES = Object.keys(FEEDBACK_STAGE_LABELS) as FeedbackStage[]
const SHELVES: Shelf[] = ['projects', 'templates', 'feedback']

function feedbackNextStageLabel(preference: FeedbackPreference): string {
  if (preference.stage !== 'recurring' || !preference.promotionProposal) {
    return FEEDBACK_NEXT_STAGE_LABELS[preference.stage]
  }
  if (preference.promotionProposal.decision === 'pending') return '昇格案を確認し、人が承認または見送り'
  if (preference.promotionProposal.decision === 'approved') return '共有先へ反映し、テストして反映済みへ'
  return '新しい根拠が集まるまで学習中を継続'
}

function feedbackNextAction(preference: FeedbackPreference): string {
  if (preference.stage !== 'recurring' || !preference.promotionProposal) {
    return FEEDBACK_NEXT_ACTIONS[preference.stage]
  }
  if (preference.promotionProposal.decision === 'pending') {
    return '昇格案の根拠、反映先、変更内容、検証方法を確認し、人が承認または見送りを選びます。'
  }
  if (preference.promotionProposal.decision === 'approved') {
    return '承認は記録済みです。共有先へ実装し、テストが終わったら「反映済み」にします。'
  }
  return '今回は実装しません。新しい根拠や別の昇格案が揃うまで「学習中」を継続します。'
}

function launcherToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="tsugite-launcher-token"]')?.content ?? ''
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? '状況を確認中'
}

function formatUpdatedAt(value?: string | null): string {
  if (!value) return '更新記録なし'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '更新記録なし'
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function latestPromotionAt(preference: FeedbackPreference): string | undefined {
  return preference.promotions.reduce<string | undefined>((latest, promotion) => (
    !promotion.promotedAt || (latest && latest >= promotion.promotedAt) ? latest : promotion.promotedAt
  ), undefined)
}

function feedbackDecisionLabel(decision: FeedbackPromotionProposal['decision']): string {
  return decision === 'approved' ? '承認' : decision === 'rejected' ? '見送り' : '判断待ち'
}

function projectMatchesFilter(project: LauncherProject, filter: ProjectFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'invalid') return !project.valid || !project.refreshable || Boolean(project.issue)
  if (!project.valid) return false
  if (filter === 'completed') return project.status === 'completed'
  if (filter === 'waiting') return project.status.startsWith('awaiting_gate_')
  return !['completed', 'aborted'].includes(project.status)
    && !project.status.startsWith('awaiting_gate_')
}

function projectUpdatedAtMs(project: LauncherProject): number {
  const timestamp = project.updatedAt ? Date.parse(project.updatedAt) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : 0
}

function compareProjectsByRecentUpdate(left: LauncherProject, right: LauncherProject): number {
  return projectUpdatedAtMs(right) - projectUpdatedAtMs(left)
    || left.name.localeCompare(right.name, 'ja')
}

function isLauncherProject(input: unknown): input is LauncherProject {
  return typeof input === 'object' && input !== null
    && 'id' in input && typeof input.id === 'string'
    && 'name' in input && typeof input.name === 'string'
    && 'slug' in input && typeof input.slug === 'string'
    && 'runId' in input && typeof input.runId === 'string'
    && 'revision' in input && typeof input.revision === 'string'
    && 'status' in input && typeof input.status === 'string'
    && (!('updatedAt' in input) || input.updatedAt === undefined || input.updatedAt === null || typeof input.updatedAt === 'string')
    && 'hasViewer' in input && typeof input.hasViewer === 'boolean'
    && (!('viewerUrl' in input) || input.viewerUrl === undefined || typeof input.viewerUrl === 'string')
    && (!('thumbnailUrl' in input) || input.thumbnailUrl === undefined || typeof input.thumbnailUrl === 'string')
    && 'valid' in input && typeof input.valid === 'boolean'
    && 'refreshable' in input && typeof input.refreshable === 'boolean'
    && (!('issue' in input) || input.issue === undefined || typeof input.issue === 'string')
}

function isProjectListResponse(input: unknown): input is ProjectListResponse {
  return typeof input === 'object' && input !== null && 'ok' in input && input.ok === true
    && 'projects' in input && Array.isArray(input.projects) && input.projects.every(isLauncherProject)
}

function isTemplateListResponse(input: unknown): input is TemplateListResponse {
  return typeof input === 'object' && input !== null && 'ok' in input && input.ok === true
    && 'templates' in input && Array.isArray(input.templates) && input.templates.every(isLauncherTemplate)
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

function isLauncherTemplate(input: unknown): input is LauncherTemplate {
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

function isFeedbackPromotion(input: unknown): input is FeedbackPromotion {
  return typeof input === 'object' && input !== null
    && 'projectId' in input && typeof input.projectId === 'string'
    && 'projectName' in input && typeof input.projectName === 'string'
    && 'kind' in input && typeof input.kind === 'string' && input.kind in FEEDBACK_PROMOTION_LABELS
    && 'target' in input && typeof input.target === 'string'
    && (!('promotedAt' in input) || input.promotedAt === undefined || typeof input.promotedAt === 'string')
}

function isFeedbackPromotionProposal(input: unknown): input is FeedbackPromotionProposal {
  return isFeedbackPromotion(input)
    && 'id' in input && typeof input.id === 'string'
    && 'changeSummary' in input && typeof input.changeSummary === 'string'
    && 'verification' in input && typeof input.verification === 'string'
    && 'decision' in input && ['pending', 'approved', 'rejected'].includes(String(input.decision))
    && (!('source' in input) || input.source === undefined || (
      typeof input.source === 'object' && input.source !== null
      && 'kind' in input.source && isFeedbackAutomationSourceKind(input.source.kind)
      && 'workflowId' in input.source && typeof input.source.workflowId === 'string'
      && (!('runId' in input.source) || input.source.runId === undefined || typeof input.source.runId === 'string')
    ))
    && (!('decidedAt' in input) || input.decidedAt === undefined || typeof input.decidedAt === 'string')
    && (!('decidedBy' in input) || input.decidedBy === undefined || input.decidedBy === 'human')
}

function isFeedbackIssue(input: unknown): input is FeedbackIssue {
  return typeof input === 'object' && input !== null
    && 'code' in input && typeof input.code === 'string'
    && 'message' in input && typeof input.message === 'string'
    && 'projectName' in input && typeof input.projectName === 'string'
    && (!('line' in input) || input.line === undefined || typeof input.line === 'number')
    && (!('path' in input) || input.path === undefined || typeof input.path === 'string')
}

function isFeedbackPreference(input: unknown): input is FeedbackPreference {
  if (typeof input !== 'object' || input === null) return false
  return 'key' in input && typeof input.key === 'string'
    && 'category' in input && typeof input.category === 'string'
    && 'signal' in input && typeof input.signal === 'string' && input.signal in FEEDBACK_SIGNAL_LABELS
    && 'stage' in input && typeof input.stage === 'string' && input.stage in FEEDBACK_STAGE_LABELS
    && 'summary' in input && typeof input.summary === 'string'
    && 'projectCount' in input && typeof input.projectCount === 'number'
    && 'projectNames' in input && Array.isArray(input.projectNames) && input.projectNames.every((value) => typeof value === 'string')
    && 'runIds' in input && Array.isArray(input.runIds) && input.runIds.every((value) => typeof value === 'string')
    && 'evidence' in input && Array.isArray(input.evidence) && input.evidence.every((value) => typeof value === 'string')
    && (!('promotion' in input) || input.promotion === undefined || isFeedbackPromotion(input.promotion))
    && 'promotions' in input && Array.isArray(input.promotions) && input.promotions.every(isFeedbackPromotion)
    && (!('promotionProposal' in input) || input.promotionProposal === undefined || isFeedbackPromotionProposal(input.promotionProposal))
    && 'lastSeenAt' in input && typeof input.lastSeenAt === 'string'
}

function isFeedbackResponse(input: unknown): input is FeedbackResponse {
  if (typeof input !== 'object' || input === null || !('ok' in input) || input.ok !== true) return false
  if (!('feedback' in input) || typeof input.feedback !== 'object' || input.feedback === null) return false
  return 'metrics' in input.feedback && typeof input.feedback.metrics === 'object'
    && input.feedback.metrics !== null
    && 'preferences' in input.feedback && Array.isArray(input.feedback.preferences)
    && input.feedback.preferences.every(isFeedbackPreference)
    && 'issues' in input.feedback && Array.isArray(input.feedback.issues)
    && input.feedback.issues.every(isFeedbackIssue)
}

function isRefreshResponse(input: unknown): input is RefreshResponse {
  return typeof input === 'object' && input !== null && 'ok' in input && input.ok === true
    && 'viewerUrl' in input && typeof input.viewerUrl === 'string'
}

function isRefreshErrorResponse(input: unknown): input is RefreshErrorResponse {
  if (typeof input !== 'object' || input === null || !('ok' in input) || input.ok !== false) return false
  if (!('issue' in input) || typeof input.issue !== 'object' || input.issue === null) return false
  return 'code' in input.issue && typeof input.issue.code === 'string'
    && 'message' in input.issue && typeof input.issue.message === 'string'
}

export function LauncherApp({
  fetcher = defaultFetcher,
  navigate = (url) => window.location.assign(url),
  token = launcherToken(),
}: LauncherAppProps) {
  const [activeShelf, setActiveShelf] = useState<Shelf>('projects')
  const [projects, setProjects] = useState<LauncherProject[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>('all')
  const [visibleProjectCount, setVisibleProjectCount] = useState(PROJECT_PAGE_SIZE)
  const [loading, setLoading] = useState(true)
  const [projectListRefreshing, setProjectListRefreshing] = useState(false)
  const [projectListRefreshError, setProjectListRefreshError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [templates, setTemplates] = useState<LauncherTemplate[]>([])
  const [templateLoadState, setTemplateLoadState] = useState<TemplateLoadState>('idle')
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [templateQuery, setTemplateQuery] = useState('')
  const [templateCategory, setTemplateCategory] = useState('すべて')
  const [feedback, setFeedback] = useState<FeedbackAggregate | null>(null)
  const [feedbackLoadState, setFeedbackLoadState] = useState<FeedbackLoadState>('idle')
  const [selectedFeedbackKey, setSelectedFeedbackKey] = useState<string | null>(null)
  const [feedbackFilter, setFeedbackFilter] = useState<FeedbackFilter>('all')
  const [visibleFeedbackCount, setVisibleFeedbackCount] = useState(FEEDBACK_PAGE_SIZE)
  const [promotionDecisionState, setPromotionDecisionState] = useState<PromotionDecisionState>('idle')
  const [promotionDecisionError, setPromotionDecisionError] = useState<string | null>(null)
  const templateDetailHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const focusTemplateDetailRef = useRef(false)

  const acceptFeedback = useCallback((nextFeedback: FeedbackAggregate) => {
    setFeedback(nextFeedback)
    setSelectedFeedbackKey((current) => (
      current && nextFeedback.preferences
        .slice(0, FEEDBACK_PAGE_SIZE)
        .some((preference) => preference.key === current)
        ? current
        : nextFeedback.preferences[0]?.key ?? null
    ))
  }, [])

  const loadProjects = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    if (background) {
      setProjectListRefreshing(true)
      setProjectListRefreshError(null)
    } else {
      setLoading(true)
      setLoadError(null)
    }
    try {
      const response = await fetcher('/api/projects', { headers: { accept: 'application/json' } })
      const payload: unknown = await response.json()
      if (!response.ok || !isProjectListResponse(payload)) throw new Error('invalid project list')
      setProjects(payload.projects)
      setSelectedId((current) => {
        if (current && payload.projects.some((project) => project.id === current)) return current
        const recentlyUpdatedProjects = [...payload.projects].sort(compareProjectsByRecentUpdate)
        return recentlyUpdatedProjects.find((project) => project.valid)?.id
          ?? recentlyUpdatedProjects[0]?.id
          ?? null
      })
    } catch {
      if (background) {
        setProjectListRefreshError('制作案件を再読み込みできませんでした。現在の表示はそのまま利用できます。')
      } else {
        setLoadError('制作案件を読み込めませんでした。ランチャーを起動し直すか、もう一度読み込んでください。')
      }
    } finally {
      if (background) setProjectListRefreshing(false)
      else setLoading(false)
    }
  }, [fetcher])

  const loadTemplates = useCallback(async () => {
    setTemplateLoadState('loading')
    try {
      const response = await fetcher('/api/templates', { headers: { accept: 'application/json' } })
      const payload: unknown = await response.json()
      if (!response.ok || !isTemplateListResponse(payload)) throw new Error('invalid template list')
      setTemplates(payload.templates)
      setSelectedTemplateId((current) => {
        if (current && payload.templates.some((template) => template.id === current)) return current
        return payload.templates.find((template) => template.valid)?.id ?? payload.templates[0]?.id ?? null
      })
      setTemplateLoadState('ready')
    } catch {
      setTemplateLoadState('error')
    }
  }, [fetcher])

  const loadFeedback = useCallback(async () => {
    setVisibleFeedbackCount(FEEDBACK_PAGE_SIZE)
    setFeedbackLoadState('loading')
    try {
      const response = await fetcher('/api/feedback', { headers: { accept: 'application/json' } })
      const payload: unknown = await response.json()
      if (!response.ok || !isFeedbackResponse(payload)) throw new Error('invalid feedback')
      acceptFeedback(payload.feedback)
      setFeedbackLoadState('ready')
    } catch {
      setFeedbackLoadState('error')
    }
  }, [acceptFeedback, fetcher])

  useEffect(() => {
    void loadProjects()
  }, [loadAttempt, loadProjects])

  useEffect(() => {
    void loadFeedback()
  }, [loadFeedback])

  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ja')
    return projects
      .filter((project) => projectMatchesFilter(project, projectFilter))
      .filter((project) => !normalized || [project.name, project.slug, project.runId]
        .some((value) => value.toLocaleLowerCase('ja').includes(normalized)))
      .sort(compareProjectsByRecentUpdate)
  }, [projectFilter, projects, query])

  const visibleProjects = filteredProjects.slice(0, visibleProjectCount)
  const remainingProjectCount = Math.max(0, filteredProjects.length - visibleProjects.length)

  useEffect(() => {
    setVisibleProjectCount(PROJECT_PAGE_SIZE)
  }, [projectFilter, query])

  const templateCategories = useMemo(() => [
    'すべて',
    ...Array.from(new Set(templates.filter((template) => template.valid).map((template) => template.category))),
  ], [templates])

  const filteredTemplates = useMemo(() => {
    const normalized = templateQuery.trim().toLocaleLowerCase('ja')
    return templates.filter((template) => {
      if (templateCategory !== 'すべて' && template.category !== templateCategory) return false
      if (!normalized) return true
      return [
        template.name,
        template.summary,
        template.category,
        template.duration,
        ...template.useCases,
        ...template.tags,
        ...template.notFor,
        ...template.requiredInputDetails.flatMap((input) => [input.label, TEMPLATE_INPUT_TYPE_LABELS[input.type]]),
        ...(template.preview?.frames.map((frame) => frame.label) ?? []),
        ...(template.preview?.flow ?? []),
        ...template.variants.flatMap((variant) => [
          variant.label,
          ...variant.options.flatMap((option) => [option.label, option.description]),
        ]),
      ].some((value) => value.toLocaleLowerCase('ja').includes(normalized))
    })
  }, [templateCategory, templateQuery, templates])

  useEffect(() => {
    if (activeShelf !== 'templates' || filteredTemplates.length === 0) return
    setSelectedTemplateId((current) => (
      current && filteredTemplates.some((template) => template.id === current)
        ? current
        : filteredTemplates.find((template) => template.valid)?.id ?? filteredTemplates[0]!.id
    ))
  }, [activeShelf, filteredTemplates])

  const filteredFeedback = useMemo(() => (
    feedback?.preferences.filter((preference) => feedbackFilter === 'all' || preference.stage === feedbackFilter) ?? []
  ), [feedback, feedbackFilter])
  const feedbackStageCounts = useMemo(() => FEEDBACK_STAGES.reduce<Record<FeedbackStage, number>>((counts, stage) => {
    counts[stage] = feedback?.preferences.filter((preference) => preference.stage === stage).length ?? 0
    return counts
  }, { observed: 0, recurring: 0, promoted: 0, verified: 0 }), [feedback])
  const selected = projects.find((project) => project.id === selectedId) ?? null
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null
  const relatedTemplates = selectedTemplate?.valid
    ? templates.filter((template) => (
      template.valid
      && template.id !== selectedTemplate.id
      && template.category === selectedTemplate.category
    )).concat(templates.filter((template) => (
      template.valid
      && template.id !== selectedTemplate.id
      && template.category !== selectedTemplate.category
      && templateTone(template.category) === templateTone(selectedTemplate.category)
    ))).slice(0, 3)
    : []
  const selectedFeedback = filteredFeedback.find((preference) => preference.key === selectedFeedbackKey)
    ?? filteredFeedback[0]
    ?? null
  const visibleFeedback = filteredFeedback.slice(0, visibleFeedbackCount)
  const remainingFeedbackCount = Math.max(0, filteredFeedback.length - visibleFeedback.length)
  const pendingPromotions = useMemo(() => (
    feedback ? pendingPromotionPreferences(feedback) : []
  ), [feedback])
  const pendingPromotionCount = pendingPromotions.length

  useEffect(() => {
    if (!focusTemplateDetailRef.current || !selectedTemplateId) return
    focusTemplateDetailRef.current = false
    templateDetailHeadingRef.current?.focus()
  }, [selectedTemplateId])

  const projectSummary = useMemo(() => ({
    active: projects.filter((project) => projectMatchesFilter(project, 'active')).length,
    waiting: projects.filter((project) => projectMatchesFilter(project, 'waiting')).length,
    completed: projects.filter((project) => projectMatchesFilter(project, 'completed')).length,
  }), [projects])

  useEffect(() => {
    setVisibleFeedbackCount(FEEDBACK_PAGE_SIZE)
    setSelectedFeedbackKey((current) => (
      current && filteredFeedback.some((preference) => preference.key === current)
        ? current
        : filteredFeedback[0]?.key ?? null
    ))
  }, [feedbackFilter, filteredFeedback])

  const selectShelf = (shelf: Shelf) => {
    setActiveShelf(shelf)
    if (shelf === 'templates' && templateLoadState === 'idle') void loadTemplates()
    if (shelf === 'feedback') {
      setVisibleFeedbackCount(FEEDBACK_PAGE_SIZE)
      setSelectedFeedbackKey((current) => (
        current && filteredFeedback.slice(0, FEEDBACK_PAGE_SIZE).some((preference) => preference.key === current)
          ? current
          : filteredFeedback[0]?.key ?? current
      ))
      if (feedbackLoadState === 'idle') void loadFeedback()
    }
  }

  const handleShelfKeyDown = (event: KeyboardEvent<HTMLButtonElement>, shelf: Shelf) => {
    let nextIndex: number | null = null
    const currentIndex = SHELVES.indexOf(shelf)
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % SHELVES.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + SHELVES.length) % SHELVES.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = SHELVES.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextShelf = SHELVES[nextIndex]!
    selectShelf(nextShelf)
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]
      ?.focus()
  }

  const openProject = async (project: LauncherProject) => {
    setSelectedId(project.id)
    setRefreshError(null)
    if (!project.valid || !project.refreshable || refreshing || projectListRefreshing) return
    setRefreshing(true)
    setOpeningProjectId(project.id)
    let failureDetail = '設定と成果物を確認して、もう一度お試しください。'
    try {
      const response = await fetcher(`/api/projects/${encodeURIComponent(project.id)}/refresh`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-tsugite-token': token,
        },
        body: '{}',
      })
      const payload: unknown = await response.json()
      if (!response.ok || !isRefreshResponse(payload)) {
        if (isRefreshErrorResponse(payload)) failureDetail = payload.issue.message
        throw new Error('refresh failed')
      }
      navigate(payload.viewerUrl)
    } catch {
      setRefreshError(`最新の制作記録を開けませんでした。${failureDetail}`)
    } finally {
      setRefreshing(false)
      setOpeningProjectId(null)
    }
  }

  const selectProject = (project: LauncherProject) => {
    setSelectedId(project.id)
    setRefreshError(null)
  }

  const openProjectFromThumbnail = async (project: LauncherProject) => {
    selectProject(project)
    if (project.valid && project.refreshable) {
      await openProject(project)
      return
    }
    if (project.hasViewer && project.viewerUrl) navigate(project.viewerUrl)
  }

  const decidePromotion = async (decision: 'approved' | 'rejected') => {
    const proposal = selectedFeedback?.promotionProposal
    if (!selectedFeedback || !proposal || proposal.decision !== 'pending' || promotionDecisionState === 'saving') return
    setPromotionDecisionState('saving')
    setPromotionDecisionError(null)
    try {
      const response = await fetcher(`/api/feedback/${encodeURIComponent(proposal.projectId)}/promotion-decision`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-tsugite-token': token,
        },
        body: JSON.stringify({ key: selectedFeedback.key, proposalId: proposal.id, decision }),
      })
      const payload: unknown = await response.json()
      if (
        response.status === 409
        && isRefreshErrorResponse(payload)
        && payload.issue.code === 'feedback.proposal_already_decided'
      ) {
        await loadFeedback()
        setPromotionDecisionState('idle')
        return
      }
      if (!response.ok || typeof payload !== 'object' || payload === null || !('ok' in payload) || payload.ok !== true) {
        throw new Error('promotion decision failed')
      }
      setFeedback((current) => current ? {
        ...current,
        preferences: current.preferences.map((preference) => (
          preference.key === selectedFeedback.key && preference.promotionProposal
            ? {
                ...preference,
                promotionProposal: {
                  ...preference.promotionProposal,
                  decision,
                  decidedAt: new Date().toISOString(),
                  decidedBy: 'human' as const,
                },
              }
            : preference
        )),
      } : current)
      setPromotionDecisionState('idle')
    } catch {
      setPromotionDecisionState('error')
      setPromotionDecisionError('承認結果を記録できませんでした。内容を確認してもう一度お試しください。')
    }
  }

  const refreshSelected = async () => {
    if (selected) await openProject(selected)
  }

  if (loading) {
    return <main className="launcher-state" aria-live="polite">制作案件を読み込んでいます…</main>
  }

  if (loadError) {
    return (
      <main className="launcher-state launcher-state-error" role="alert">
        <span className="eyebrow">TSUGITE / 制作の見取図</span>
        <h1>制作案件を開けません</h1>
        <p>{loadError}</p>
        <button className="launcher-primary" onClick={() => setLoadAttempt((value) => value + 1)} type="button">
          <RefreshCw aria-hidden="true" size={17} />
          もう一度読み込む
        </button>
      </main>
    )
  }

  return (
    <main className="launcher-shell">
      <section aria-label="制作の見取図" className="launcher-hero">
        <nav className="launcher-hero-nav">
          <div className="launcher-wordmark">
            <img alt="" aria-hidden="true" className="launcher-favicon-mark" src="./assets/tsugite-favicon.png" />
            <span><strong>TSUGITE</strong><small>PRODUCTION ARCHIVE</small></span>
          </div>
          <div aria-label="表示する棚" className="launcher-shelf-tabs" role="tablist">
            <button
              aria-controls="launcher-projects-panel"
              aria-selected={activeShelf === 'projects'}
              id="launcher-projects-tab"
              onClick={() => selectShelf('projects')}
              onKeyDown={(event) => handleShelfKeyDown(event, 'projects')}
              role="tab"
              tabIndex={activeShelf === 'projects' ? 0 : -1}
              type="button"
            >
              <FolderOpen aria-hidden="true" size={17} />制作案件
            </button>
            <button
              aria-controls="launcher-templates-panel"
              aria-selected={activeShelf === 'templates'}
              id="launcher-templates-tab"
              onClick={() => selectShelf('templates')}
              onKeyDown={(event) => handleShelfKeyDown(event, 'templates')}
              role="tab"
              tabIndex={activeShelf === 'templates' ? 0 : -1}
              type="button"
            >
              <LayoutTemplate aria-hidden="true" size={17} />テンプレート
            </button>
            <button
              aria-label="好み・学び"
              aria-controls="launcher-feedback-panel"
              aria-describedby={pendingPromotionCount > 0 ? 'launcher-feedback-pending-count' : undefined}
              aria-selected={activeShelf === 'feedback'}
              id="launcher-feedback-tab"
              onClick={() => selectShelf('feedback')}
              onKeyDown={(event) => handleShelfKeyDown(event, 'feedback')}
              role="tab"
              tabIndex={activeShelf === 'feedback' ? 0 : -1}
              type="button"
            >
              <BookOpen aria-hidden="true" size={17} />好み・学び
              {pendingPromotionCount > 0 && (
                <span className="launcher-shelf-badge" id="launcher-feedback-pending-count">
                  <span aria-hidden="true">{pendingPromotionCount}</span>
                  <span className="sr-only">確認待ちの学び {pendingPromotionCount}件</span>
                </span>
              )}
            </button>
          </div>
        </nav>

        <div className="launcher-hero-content">
          <div aria-hidden="true" className="launcher-hero-joinery"><span /><i /></div>
          <div className="launcher-hero-copy">
            <span className="eyebrow">映像制作の玄関 / PRODUCTION LAUNCHER</span>
            <h1>制作の見取図を開く</h1>
            <p>案件の現在地を見渡し、最新の制作記録へ。作りたい映像に合う型も、同じ棚から探せます。</p>
          </div>
          <aside aria-label="現在の棚" className="launcher-hero-note">
            <small>現在の棚 / CURRENT SHELF</small>
            <strong>{activeShelf === 'projects' ? '制作案件' : activeShelf === 'templates' ? 'テンプレート' : '好み・学び'}</strong>
            <span>{activeShelf === 'projects'
              ? '最近更新した順に並んでいます'
              : activeShelf === 'templates'
                ? '用途と必要素材を比較できます'
                : '制作から育った知見を確認できます'}</span>
          </aside>
        </div>

        <dl aria-label="制作案件の状況" className="launcher-hero-metrics">
          <div><dt>全案件</dt><dd>{projects.length}</dd></div>
          <div><dt>進行中</dt><dd>{projectSummary.active}</dd></div>
          <div><dt>確認待ち</dt><dd>{projectSummary.waiting}</dd></div>
          <div><dt>完了</dt><dd>{projectSummary.completed}</dd></div>
        </dl>
      </section>

      <ol aria-label="見取図を開く手順" className="launcher-joinery">
        {activeShelf === 'projects' ? (
          <>
            <li data-active="true"><span>一</span><strong>選ぶ</strong></li>
            <li data-active={selected !== null}><span>二</span><strong>最新にする</strong></li>
            <li data-active="false"><span>三</span><strong>見る</strong></li>
          </>
        ) : activeShelf === 'templates' ? (
          <>
            <li data-active="true"><span>一</span><strong>見つける</strong></li>
            <li data-active={selectedTemplate !== null}><span>二</span><strong>比べる</strong></li>
            <li data-active={selectedTemplate?.valid === true}><span>三</span><strong>必要素材を見る</strong></li>
          </>
        ) : (
          <>
            <li data-active="true"><span>一</span><strong>観測する</strong></li>
            <li data-active={feedbackLoadState === 'ready'}><span>二</span><strong>育てる</strong></li>
            <li data-active={selectedFeedback?.stage === 'verified'}><span>三</span><strong>確かめる</strong></li>
          </>
        )}
      </ol>

      {activeShelf === 'projects' ? (
        <section aria-labelledby="launcher-projects-tab" className="launcher-workbench" id="launcher-projects-panel" role="tabpanel">
          <section aria-busy={projectListRefreshing} aria-labelledby="project-list-title" className="launcher-projects">
            <div className="launcher-section-heading">
              <div>
                <span className="eyebrow">制作棚</span>
                <h2 id="project-list-title">制作案件を選ぶ</h2>
              </div>
              <div className="launcher-project-list-actions">
                <span className="launcher-count">全{projects.length}件 / 表示{visibleProjects.length}件</span>
                <button
                  aria-busy={projectListRefreshing}
                  className="launcher-secondary launcher-project-list-refresh"
                  disabled={projectListRefreshing || refreshing}
                  onClick={() => {
                    if (!refreshing) void loadProjects({ background: true })
                  }}
                  type="button"
                >
                  <RefreshCw aria-hidden="true" className={projectListRefreshing ? 'is-spinning' : undefined} size={15} />
                  {projectListRefreshing ? '制作案件を再読み込み中…' : '制作案件を再読み込み'}
                </button>
              </div>
            </div>

            {projectListRefreshError && (
              <p className="launcher-project-list-refresh-error" role="alert">{projectListRefreshError}</p>
            )}

            {projects.length > 0 && (
              <div className="launcher-project-tools">
                <label className="launcher-search">
                  <Search aria-hidden="true" size={17} />
                  <span className="sr-only">制作案件を検索</span>
                  <input
                    aria-label="制作案件を検索"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="名前やrun IDで絞り込む"
                    type="search"
                    value={query}
                  />
                </label>
                <div aria-label="制作状況で絞り込む" className="launcher-project-filter">
                  {PROJECT_FILTERS.map((filter) => (
                    <button
                      aria-label={filter.id === 'all' ? 'すべての制作状況を表示' : `${filter.label}で絞り込む`}
                      aria-pressed={projectFilter === filter.id}
                      key={filter.id}
                      onClick={() => setProjectFilter(filter.id)}
                      type="button"
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {projects.length === 0 ? (
              <div className="launcher-empty">
                <FolderOpen aria-hidden="true" size={24} />
                <strong>表示できる制作案件はまだありません。</strong>
                <p>projectsフォルダにproject.yamlを用意すると、ここに表示されます。</p>
              </div>
            ) : filteredProjects.length === 0 ? (
              <div className="launcher-empty"><strong>検索条件に合う制作案件はありません。</strong></div>
            ) : (
              <div className="launcher-project-list">
                {visibleProjects.map((project) => (
                  <article
                    className="launcher-project-card"
                    data-busy={openingProjectId === project.id}
                    data-invalid={!project.valid}
                    data-selected={project.id === selectedId}
                    data-unrefreshable={project.valid && !project.refreshable}
                    data-warning={project.valid && project.refreshable && Boolean(project.issue)}
                    key={project.id}
                  >
                    <span aria-hidden="true" className="launcher-project-notch" />
                    <button
                      aria-busy={openingProjectId === project.id}
                      aria-label={project.valid && project.refreshable
                        ? `${project.name}の3Dワークフローを最新にして開く`
                        : project.hasViewer && project.viewerUrl
                          ? `${project.name}の前回の3Dワークフローを開く`
                          : `${project.name}の3Dワークフローはまだ開けません`}
                      className="launcher-project-thumbnail-button"
                      disabled={
                        refreshing
                        || projectListRefreshing
                        || (!project.valid || !project.refreshable) && (!project.hasViewer || !project.viewerUrl)
                      }
                      onClick={() => void openProjectFromThumbnail(project)}
                      type="button"
                    >
                      <span className="launcher-project-thumbnail">
                        {project.thumbnailUrl ? (
                          <img alt="" loading="lazy" src={project.thumbnailUrl} />
                        ) : (
                          <span className="launcher-project-thumbnail-empty">
                            <Clapperboard aria-hidden="true" size={24} />
                            <small>制作記録</small>
                          </span>
                        )}
                        <span className="launcher-project-open-cue">
                          3Dワークフローを開く
                        </span>
                        <span className="launcher-project-status">
                          {openingProjectId === project.id
                            ? '開いています…'
                            : !project.valid
                              ? '設定の確認が必要'
                              : !project.refreshable
                                ? '最新状態に更新できません'
                                : project.issue
                                  ? '実行条件の確認が必要'
                                  : statusLabel(project.status)}
                        </span>
                      </span>
                    </button>
                    <button
                      aria-describedby={project.issue || !project.valid || !project.refreshable ? `launcher-project-issue-${project.id}` : undefined}
                      aria-label={!project.valid
                        ? `${project.name}の設定を確認`
                        : !project.refreshable
                          ? `${project.name}の更新できない理由を確認`
                          : project.issue
                            ? `${project.name}の注意事項を確認`
                            : `${project.name}の制作工程を選ぶ`}
                      aria-pressed={project.id === selectedId}
                      className="launcher-project-select"
                      disabled={refreshing || projectListRefreshing}
                      onClick={() => selectProject(project)}
                      type="button"
                    >
                      <span className="launcher-project-copy">
                        <span className="launcher-project-name" role="heading" aria-level={3}>{project.name}</span>
                        <small>{project.slug}</small>
                        <span className="sr-only">
                          {!project.valid
                            ? '設定の確認が必要'
                            : !project.refreshable
                              ? '最新状態に更新できません'
                              : project.issue
                                ? '実行条件の確認が必要'
                                : statusLabel(project.status)}
                        </span>
                        {(project.issue || !project.valid || !project.refreshable) && (
                          <span className="launcher-project-card-issue" id={`launcher-project-issue-${project.id}`}>
                            {project.issue ?? (project.valid
                              ? '現在のバックエンドでは更新できません。'
                              : '設定ファイルを読み込めませんでした。')}
                          </span>
                        )}
                        <span className="launcher-project-card-footer">
                          <small>{formatUpdatedAt(project.updatedAt)}</small>
                          <span>工程と操作 <ArrowRight aria-hidden="true" size={17} /></span>
                        </span>
                      </span>
                    </button>
                  </article>
                ))}
              </div>
            )}
            {remainingProjectCount > 0 && (
              <button
                className="launcher-load-more"
                onClick={() => setVisibleProjectCount((count) => count + PROJECT_PAGE_SIZE)}
                type="button"
              >
                残り{remainingProjectCount}件を表示
              </button>
            )}
          </section>

          <aside aria-label="選択した制作案件" className="launcher-selection launcher-project-selection">
            <span className="eyebrow">選択中の木札</span>
            {selected ? (
              <>
                <h2>{selected.name}</h2>
                <dl className="launcher-project-meta">
                  <div><dt>現在の状況</dt><dd>{selected.valid ? statusLabel(selected.status) : '設定の確認が必要'}</dd></div>
                  <div><dt>制作記録</dt><dd>{selected.runId}</dd></div>
                  <div><dt>最終更新</dt><dd><Clock3 aria-hidden="true" size={15} />{formatUpdatedAt(selected.updatedAt)}</dd></div>
                </dl>

                {(selected.issue || !selected.valid || !selected.refreshable) && (
                  <div className="launcher-project-issue" role="status">
                    <strong>{!selected.valid
                      ? 'この案件はまだ更新できません'
                      : selected.refreshable
                        ? 'Viewerは更新できますが実行条件の確認が必要です'
                        : '最新状態に更新できません'}</strong>
                    <p>{selected.issue ?? (selected.valid
                      ? '現在のバックエンドではこの案件を更新できません。'
                      : '設定ファイルを読み込めませんでした。')}</p>
                    <small>{!selected.valid
                      ? 'project.yamlと参照ファイルを確認してください。'
                      : selected.refreshable
                        ? 'Viewer表示だけを安全に更新します。制作実行前にバックエンド能力を確認してください。'
                        : '前回の表示がある場合は、更新せずに開けます。'}</small>
                  </div>
                )}
                {refreshError && <p className="launcher-refresh-error" role="alert">{refreshError}</p>}

                <div className="launcher-actions">
                  <button
                    className="launcher-primary"
                    disabled={!selected.valid || !selected.refreshable || refreshing || projectListRefreshing}
                    onClick={() => void refreshSelected()}
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" className={refreshing ? 'is-spinning' : undefined} size={17} />
                    {refreshing ? '制作の記録を更新しています…' : '最新状態に更新して開く'}
                  </button>
                  {selected.hasViewer && selected.viewerUrl && (
                    <button className="launcher-secondary" disabled={refreshing || projectListRefreshing} onClick={() => navigate(selected.viewerUrl!)} type="button">
                      前回の表示を開く
                      <ArrowRight aria-hidden="true" size={16} />
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className="launcher-selection-empty">左の制作棚から、確認したい案件を選んでください。</p>
            )}
          </aside>
        </section>
      ) : activeShelf === 'templates' ? (
        <section aria-labelledby="launcher-templates-tab" className="launcher-workbench" id="launcher-templates-panel" role="tabpanel">
          <section aria-labelledby="template-list-title" className="launcher-projects launcher-template-shelf">
            <div className="launcher-section-heading">
              <div>
                <span className="eyebrow">型の棚</span>
                <h2 id="template-list-title">テンプレートを選ぶ</h2>
              </div>
              {templateLoadState === 'ready' && (
                <span className="launcher-count">全{templates.length}件 / 表示{filteredTemplates.length}件</span>
              )}
            </div>

            {templateLoadState === 'loading' && (
              <div className="launcher-empty" aria-live="polite">
                <RefreshCw aria-hidden="true" className="is-spinning" size={22} />
                <strong>テンプレートを読み込んでいます…</strong>
              </div>
            )}
            {templateLoadState === 'error' && (
              <div className="launcher-catalog-error" role="alert">
                <strong>テンプレートを読み込めませんでした。</strong>
                <p>カタログを確認して、もう一度読み込んでください。</p>
                <button className="launcher-secondary" onClick={() => void loadTemplates()} type="button">
                  <RefreshCw aria-hidden="true" size={16} />テンプレートをもう一度読み込む
                </button>
              </div>
            )}
            {templateLoadState === 'ready' && templates.length === 0 && (
              <div className="launcher-empty">
                <LayoutTemplate aria-hidden="true" size={24} />
                <strong>表示できるテンプレートはまだありません。</strong>
                <p>templates直下にtemplate.yamlを用意すると、ここに表示されます。</p>
              </div>
            )}
            {templateLoadState === 'ready' && templates.length > 0 && (
              <>
                <label className="launcher-search">
                  <Search aria-hidden="true" size={17} />
                  <span className="sr-only">テンプレートを検索</span>
                  <input
                    aria-label="テンプレートを検索"
                    onChange={(event) => setTemplateQuery(event.target.value)}
                    placeholder="用途・名前・タグで絞り込む"
                    type="search"
                    value={templateQuery}
                  />
                </label>
                <div aria-label="用途で絞り込む" className="launcher-category-filter">
                  {templateCategories.map((category) => (
                    <button
                      aria-pressed={templateCategory === category}
                      key={category}
                      onClick={() => setTemplateCategory(category)}
                      type="button"
                      aria-label={category === 'すべて' ? 'すべての用途を表示' : `${category}で絞り込む`}
                    >
                      {category}
                    </button>
                  ))}
                </div>

                {filteredTemplates.length === 0 ? (
                  <div className="launcher-empty"><strong>条件に合うテンプレートはありません。</strong></div>
                ) : (
                  <div className="launcher-template-list">
                    {filteredTemplates.map((template) => {
                      const preview = template.valid ? templatePreview(template) : null
                      const inputTypes = template.valid
                        ? Array.from(new Set(template.requiredInputDetails.map((input) => input.type)))
                        : []
                      const previewIsReady = template.valid && hasUsableTemplatePreview(template.preview)
                      const a11yDescriptionId = `launcher-template-card-a11y-${template.id}`
                      return (
                        <button
                          aria-describedby={template.valid ? a11yDescriptionId : undefined}
                          aria-label={`${template.name}を選ぶ`}
                          aria-pressed={template.id === selectedTemplateId}
                          className="launcher-template-card"
                          data-category={template.valid ? template.category : '要確認'}
                          data-invalid={!template.valid}
                          data-status={template.status}
                          data-tone={template.valid ? templateTone(template.category) : undefined}
                          key={template.id}
                          onClick={() => setSelectedTemplateId(template.id)}
                          type="button"
                        >
                          <span className="launcher-template-card-topline">
                            <span>{template.valid ? TEMPLATE_STATUS_LABELS[template.status] : '設定を確認'}</span>
                            <small>{template.valid ? `${template.duration} · ${template.aspectRatio}` : template.id}</small>
                          </span>
                          <span className="launcher-template-card-name" role="heading" aria-level={3}>{template.name}</span>
                          <span className="launcher-template-card-summary">
                            {template.valid ? template.summary : template.issue?.message ?? 'メタデータを読み込めませんでした。'}
                          </span>
                          {template.valid && preview && (
                            <span className="launcher-template-storyboard">
                              <span className="launcher-template-storyboard-heading">
                                <b>構成イメージ</b>
                                {!previewIsReady && <small>プレビュー準備中</small>}
                              </span>
                              <span className="launcher-template-frames">
                                {preview.frames.slice(0, 3).map((frame, index) => (
                                  <span
                                    aria-label={`${index + 1}コマ目: ${frame.label}`}
                                    className="launcher-template-frame"
                                    data-kind={frame.kind}
                                    key={`${frame.kind}-${frame.label}`}
                                    role="img"
                                  >
                                    <span aria-hidden="true" className="launcher-template-frame-visual" />
                                    <small aria-hidden="true">{frame.label}</small>
                                  </span>
                                ))}
                              </span>
                              <span className="launcher-template-flow">
                                {preview.flow.join(' → ')}
                              </span>
                            </span>
                          )}
                          {template.valid && (
                            <>
                              <span className="sr-only" id={a11yDescriptionId}>
                                {template.duration}、{template.aspectRatio}。構成: {preview?.flow.join('、')}。必要素材: {inputTypes.length > 0
                                  ? inputTypes.map((type) => TEMPLATE_INPUT_TYPE_LABELS[type]).join('、')
                                  : '指定なし'}。
                              </span>
                              <span className="launcher-template-card-footer">
                                <span className="launcher-template-card-tags">
                                  <b>{template.category}</b>
                                  {template.tags.slice(0, 1).map((tag) => <i key={tag}>{tag}</i>)}
                                </span>
                                <span aria-label="必要素材タイプ" className="launcher-template-input-types">
                                  {inputTypes.map((type) => <i key={type}>{TEMPLATE_INPUT_TYPE_LABELS[type]}</i>)}
                                </span>
                              </span>
                            </>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </section>

          <aside aria-label="選択したテンプレート" className="launcher-selection launcher-template-detail">
            <span className="eyebrow">選択中の型</span>
            {selectedTemplate ? (
              selectedTemplate.valid ? (
                <>
                  <div className="launcher-template-detail-heading">
                    <h2 ref={templateDetailHeadingRef} tabIndex={-1}>{selectedTemplate.name}</h2>
                    <span>{TEMPLATE_STATUS_LABELS[selectedTemplate.status]}</span>
                  </div>
                  <p className="launcher-template-summary">{selectedTemplate.summary}</p>
                  <dl className="launcher-project-meta">
                    <div><dt>用途</dt><dd>{selectedTemplate.category}</dd></div>
                    <div><dt>出力</dt><dd>{selectedTemplate.duration} / {selectedTemplate.aspectRatio}</dd></div>
                    {selectedTemplate.speakers !== undefined && (
                      <div><dt>登場人数</dt><dd><Users aria-hidden="true" size={15} />{selectedTemplate.speakers}人</dd></div>
                    )}
                    <div><dt>配布区分</dt><dd>{DISTRIBUTION_LABELS[selectedTemplate.distribution]}</dd></div>
                  </dl>
                  <section className="launcher-template-timeline">
                    <div>
                      <h3>構成の流れ</h3>
                      <small>構成イメージです。実際の成果を保証する表示ではありません。</small>
                    </div>
                    <ol>
                      {templatePreview(selectedTemplate).flow.slice(0, 5).map((step, index) => (
                        <li key={`${index}-${step}`}><span>{String(index + 1).padStart(2, '0')}</span><strong>{step}</strong></li>
                      ))}
                    </ol>
                  </section>
                  <div className="launcher-template-fit-grid">
                    <section className="launcher-template-requirements">
                      <h3>向いている用途</h3>
                      <ul>
                        {selectedTemplate.useCases.map((useCase) => <li key={useCase}>{useCase}</li>)}
                      </ul>
                    </section>
                    <section className="launcher-template-requirements launcher-template-not-for">
                      <h3>向かない用途</h3>
                      {selectedTemplate.notFor.length > 0 ? (
                        <ul>{selectedTemplate.notFor.map((useCase) => <li key={useCase}>{useCase}</li>)}</ul>
                      ) : <p>指定なし。素材と構成を確認して判断します。</p>}
                    </section>
                  </div>
                  <section className="launcher-template-requirements">
                    <h3>用意するもの</h3>
                    <ul className="launcher-template-materials">
                      {selectedTemplate.requiredInputDetails.map((input) => (
                        <li key={`${input.type}-${input.label}`}>
                          <b>{TEMPLATE_INPUT_TYPE_LABELS[input.type]}</b>
                          <span>{input.label}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                  {selectedTemplate.variants.length > 0 && (
                    <section className="launcher-template-variants">
                      <h3>選べるバリエーション</h3>
                      <div>
                        {selectedTemplate.variants.map((variant) => (
                          <article key={variant.id}>
                            <h4>{variant.label}</h4>
                            <ul>
                              {variant.options.map((option) => (
                                <li key={option.id}>
                                  <strong>
                                    {option.label}
                                    {option.id === variant.defaultOptionId && <small>推奨</small>}
                                  </strong>
                                  <span>{option.description}</span>
                                </li>
                              ))}
                            </ul>
                          </article>
                        ))}
                      </div>
                    </section>
                  )}
                  <section className="launcher-template-requirements">
                    <h3>音声</h3>
                    <p>{selectedTemplate.audio}</p>
                  </section>
                  {relatedTemplates.length > 0 && (
                    <section className="launcher-template-related">
                      <h3>同じ系統のテンプレート</h3>
                      <div>
                        {relatedTemplates.map((template) => (
                          <button
                            aria-label={`${template.name} ${template.duration} · ${template.aspectRatio}`}
                            key={template.id}
                            onClick={() => {
                              focusTemplateDetailRef.current = true
                              setSelectedTemplateId(template.id)
                            }}
                            type="button"
                          >
                            <span>{template.name}</span>
                            <small>{template.duration} · {template.aspectRatio}</small>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                  <div className="launcher-readonly-note">
                    <strong>閲覧専用</strong>
                    <p>この棚からコピー・生成・実行は行いません。内容を確認してからREADMEの手順で制作案件を用意してください。</p>
                  </div>
                </>
              ) : (
                <>
                  <h2>{selectedTemplate.name}</h2>
                  <div className="launcher-project-issue" role="status">
                    <strong>このテンプレートは表示情報を確認できません</strong>
                    <p>{selectedTemplate.issue?.message ?? 'template.yamlを読み込めませんでした。'}</p>
                    <small>{selectedTemplate.issue?.code ?? 'template_metadata.invalid'}</small>
                  </div>
                </>
              )
            ) : (
              <p className="launcher-selection-empty">左の型の棚から、用途に合うテンプレートを選んでください。</p>
            )}
          </aside>
        </section>
      ) : (
        <section aria-labelledby="launcher-feedback-tab" className="launcher-feedback-panel" id="launcher-feedback-panel" role="tabpanel">
          {feedbackLoadState === 'loading' && (
            <div aria-busy="true" aria-live="polite" className="launcher-empty launcher-feedback-state">
              <RefreshCw aria-hidden="true" className="is-spinning" size={22} />
              <strong>好み・学びを整理しています…</strong>
            </div>
          )}
          {feedbackLoadState === 'error' && (
            <div className="launcher-catalog-error launcher-feedback-state" role="alert">
              <strong>好み・学びを読み込めませんでした。</strong>
              <p>学びの記録を確認して、もう一度読み込んでください。</p>
              <button className="launcher-secondary" onClick={() => void loadFeedback()} type="button">
                <RefreshCw aria-hidden="true" size={16} />好み・学びをもう一度読み込む
              </button>
            </div>
          )}
          {feedbackLoadState === 'ready' && feedback && (
            <>
              <header className="launcher-feedback-heading">
                <div>
                  <span className="eyebrow">学びの棚</span>
                  <h2>制作に活かす学び</h2>
                  <p>案件で見つけたことを記録し、同じ傾向を確かめ、制作ルールに反映します。</p>
                </div>
                <span className="launcher-count">
                  全{feedback.preferences.length}件 / 表示{visibleFeedback.length}件
                </span>
              </header>

              {pendingPromotions.length > 0 && (
                <section
                  aria-labelledby="launcher-feedback-pickup-heading"
                  className="launcher-feedback-pickup"
                >
                  <header>
                    <div>
                      <span className="launcher-feedback-pickup-kicker">確認待ち</span>
                      <h3 id="launcher-feedback-pickup-heading">確認してほしい学び</h3>
                      <p>繰り返し見つかった傾向です。反映先と検証方法を確かめ、承認または見送りを選んでください。</p>
                    </div>
                    <strong aria-label={`確認待ち ${pendingPromotionCount}件`}>
                      {pendingPromotionCount}件
                    </strong>
                  </header>
                  <ul>
                    {pendingPromotions.map((preference) => (
                      <li key={preference.promotionProposal!.id}>
                        <button
                          aria-label={`「${preference.summary}」の昇格案を確認`}
                          onClick={() => {
                            setFeedbackFilter('all')
                            setSelectedFeedbackKey(preference.key)
                            setPromotionDecisionState('idle')
                            setPromotionDecisionError(null)
                          }}
                          type="button"
                        >
                          <span className="launcher-feedback-pickup-meta">
                            <b>{preference.category}</b>
                            <small>{FEEDBACK_PROMOTION_LABELS[preference.promotionProposal!.kind]}</small>
                          </span>
                          <strong>{preference.summary}</strong>
                          <span>
                            反映先 <code>{preference.promotionProposal!.target}</code>
                          </span>
                          <ArrowRight aria-hidden="true" size={18} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <dl aria-label="学びの4段階" className="launcher-feedback-metrics">
                {FEEDBACK_STAGES.map((stage) => (
                  <div data-stage={stage} key={stage}>
                    <dt>
                      <span aria-hidden="true">{FEEDBACK_STAGE_MARKS[stage]}</span>
                      {FEEDBACK_STAGE_LABELS[stage]} <small>/ 到達済み</small>
                    </dt>
                    <dd>{feedback.metrics[stage] ?? 0}</dd>
                  </div>
                ))}
              </dl>

              <div aria-label="状態で絞り込む" className="launcher-feedback-filters" role="group">
                <button
                  aria-label={`すべて ${feedback.preferences.length}件`}
                  aria-pressed={feedbackFilter === 'all'}
                  onClick={() => setFeedbackFilter('all')}
                  type="button"
                >
                  <span>すべて</span>
                  <b>{feedback.preferences.length}件</b>
                </button>
                {FEEDBACK_STAGES.map((stage) => (
                  <button
                    aria-label={`${FEEDBACK_STAGE_LABELS[stage]} ${feedbackStageCounts[stage]}件`}
                    aria-pressed={feedbackFilter === stage}
                    data-stage={stage}
                    key={stage}
                    onClick={() => setFeedbackFilter(stage)}
                    type="button"
                  >
                    <span>{FEEDBACK_STAGE_LABELS[stage]}</span>
                    <b>{feedbackStageCounts[stage]}件</b>
                  </button>
                ))}
              </div>

              <section aria-label="記録の状態" className="launcher-feedback-stage-guide">
                <header>
                  <div>
                    <span className="launcher-feedback-guide-kicker">4つの状態</span>
                    <h3>この記録は今どこ？</h3>
                  </div>
                  <p>記録、学習中、反映済み、効果確認済みのどれかが、今の状態です。</p>
                </header>
                <ol>
                  {FEEDBACK_STAGES.map((stage) => (
                    <li data-stage={stage} key={stage}>
                      <span>{FEEDBACK_STAGE_MARKS[stage]}</span>
                      <div>
                        <strong>{FEEDBACK_STAGE_LABELS[stage]}</strong>
                        <b>{FEEDBACK_APPLICATION_LABELS[stage]}</b>
                        <p>{FEEDBACK_STAGE_DESCRIPTIONS[stage]}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="launcher-feedback-guide-note"><strong>承認は状態ではありません。</strong> 承認日時は、反映前の確認として詳細に表示します。</p>
              </section>

              {feedback.issues.length > 0 && (
                <section aria-label="読み取り警告" className="launcher-feedback-issues" role="status">
                  <strong>読み取りを確認したい記録が{feedback.issues.length}件あります。</strong>
                  <ul>
                    {feedback.issues.slice(0, FEEDBACK_ISSUE_DISPLAY_LIMIT).map((issue, index) => (
                      <li key={`${issue.projectName}-${issue.code}-${issue.line ?? 'unknown'}-${index}`}>
                        <span className="launcher-feedback-issue-meta">
                          <b>{issue.projectName}</b>
                          <code>{issue.code}</code>
                          {issue.line !== undefined && <small>{issue.line}行</small>}
                          {issue.path && <code>{issue.path}</code>}
                        </span>
                        <p>{issue.message}</p>
                      </li>
                    ))}
                  </ul>
                  {feedback.issues.length > FEEDBACK_ISSUE_DISPLAY_LIMIT && (
                    <small className="launcher-feedback-issue-remaining">
                      ほか{feedback.issues.length - FEEDBACK_ISSUE_DISPLAY_LIMIT}件
                    </small>
                  )}
                </section>
              )}

              {feedback.preferences.length === 0 ? (
                <div className="launcher-empty launcher-feedback-state">
                  <BookOpen aria-hidden="true" size={24} />
                  <strong>まだ整理された好み・学びはありません。</strong>
                  <p><code>pipeline feedback</code>で記録した<code>feedback.jsonl</code>が蓄積すると、ここに表示されます。</p>
                </div>
              ) : filteredFeedback.length === 0 ? (
                <div className="launcher-empty launcher-feedback-state">
                  <BookOpen aria-hidden="true" size={24} />
                  <strong>{feedbackFilter === 'all' ? '該当する好み・学びはありません。' : `${FEEDBACK_STAGE_LABELS[feedbackFilter]}の好み・学びはありません。`}</strong>
                  <button className="launcher-secondary" onClick={() => setFeedbackFilter('all')} type="button">
                    すべての状態を表示
                  </button>
                </div>
              ) : (
                <div className="launcher-feedback-workbench">
                  <section aria-label="好み・学びの一覧" className="launcher-feedback-list">
                    {visibleFeedback.map((preference) => {
                      const stageLabel = FEEDBACK_STAGE_LABELS[preference.stage] ?? '段階を確認'
                      const signalLabel = FEEDBACK_SIGNAL_LABELS[preference.signal] ?? '傾向を確認'
                      const representativePromotion = preference.promotions[0]
                      const remainingPromotionCount = Math.max(0, preference.promotions.length - 1)
                      return (
                        <button
                          aria-label={`${preference.summary}の詳細を見る`}
                          aria-pressed={preference.key === selectedFeedbackKey}
                          className="launcher-feedback-card"
                          data-stage={preference.stage}
                          key={preference.key}
                          onClick={() => {
                            setSelectedFeedbackKey(preference.key)
                            setPromotionDecisionState('idle')
                            setPromotionDecisionError(null)
                          }}
                          type="button"
                        >
                          <span className="launcher-feedback-card-stage">
                            <b aria-hidden="true">{FEEDBACK_STAGE_MARKS[preference.stage] ?? '・'}</b>
                            <span>現在の段階 / {stageLabel}</span>
                          </span>
                          <span className="launcher-feedback-card-summary" role="heading" aria-level={3}>{preference.summary}</span>
                          <span className="launcher-feedback-card-meta">
                            <i>{preference.category}</i>
                            <i>{signalLabel}</i>
                            <i>{preference.projectCount}案件</i>
                          </span>
                          <span className="launcher-feedback-card-promotion">
                            <small>昇格先</small>
                            <strong>{representativePromotion?.target ?? 'まだ設定されていません'}</strong>
                            {representativePromotion?.promotedAt && (
                              <span className="launcher-feedback-card-timestamp">反映 {formatUpdatedAt(representativePromotion.promotedAt)}</span>
                            )}
                            {remainingPromotionCount > 0 && <span>ほか{remainingPromotionCount}件</span>}
                          </span>
                          {preference.stage === 'recurring' && (
                            <span
                              className="launcher-feedback-card-approval"
                              data-decision={preference.promotionProposal?.decision ?? 'preparing'}
                            >
                              {preference.promotionProposal
                                ? FEEDBACK_PROPOSAL_DECISION_LABELS[preference.promotionProposal.decision]
                                : '昇格案の準備待ち'}
                            </span>
                          )}
                          {preference.stage === 'recurring' && preference.promotionProposal?.decidedAt && (
                            <span className="launcher-feedback-card-timestamp">
                              {feedbackDecisionLabel(preference.promotionProposal.decision)} {formatUpdatedAt(preference.promotionProposal.decidedAt)}
                            </span>
                          )}
                          <span className="launcher-feedback-card-verification">
                            {preference.stage === 'verified' ? '◆' : '◇'} {FEEDBACK_APPLICATION_LABELS[preference.stage]}
                          </span>
                        </button>
                      )
                    })}
                    {remainingFeedbackCount > 0 && (
                      <button
                        className="launcher-load-more launcher-feedback-load-more"
                        onClick={() => setVisibleFeedbackCount((count) => count + FEEDBACK_PAGE_SIZE)}
                        type="button"
                      >
                        残り{remainingFeedbackCount}件を表示
                      </button>
                    )}
                  </section>

                  <aside aria-label="選択した好み・学び" className="launcher-selection launcher-feedback-detail">
                    <span className="eyebrow">選択中の学び</span>
                    {selectedFeedback ? (
                      <>
                        <div className="launcher-feedback-detail-heading">
                          <span aria-hidden="true">{FEEDBACK_STAGE_MARKS[selectedFeedback.stage] ?? '・'}</span>
                          <div>
                            <small>{FEEDBACK_STAGE_LABELS[selectedFeedback.stage] ?? '段階を確認'}</small>
                            <h2>{selectedFeedback.summary}</h2>
                          </div>
                        </div>
                        <dl className="launcher-project-meta">
                          <div><dt>分類</dt><dd>{selectedFeedback.category}</dd></div>
                          <div><dt>傾向</dt><dd>{FEEDBACK_SIGNAL_LABELS[selectedFeedback.signal] ?? '確認中'}</dd></div>
                          <div>
                            <dt>適用確認</dt>
                            <dd>{FEEDBACK_APPLICATION_LABELS[selectedFeedback.stage]}</dd>
                          </div>
                          <div><dt>次の段階</dt><dd>{feedbackNextStageLabel(selectedFeedback)}</dd></div>
                          {selectedFeedback.promotionProposal?.decidedAt && (
                            <div><dt>{feedbackDecisionLabel(selectedFeedback.promotionProposal.decision)}日時</dt><dd>{formatUpdatedAt(selectedFeedback.promotionProposal.decidedAt)}</dd></div>
                          )}
                          {latestPromotionAt(selectedFeedback) && (
                            <div><dt>最終反映</dt><dd>{formatUpdatedAt(latestPromotionAt(selectedFeedback))}</dd></div>
                          )}
                          <div><dt>最終記録</dt><dd>{formatUpdatedAt(selectedFeedback.lastSeenAt)}</dd></div>
                        </dl>

                        {selectedFeedback.promotionProposal && selectedFeedback.stage === 'recurring' && (
                          <section className="launcher-feedback-detail-section launcher-feedback-approval" aria-live="polite">
                            <div className="launcher-feedback-approval-heading">
                              <h3>昇格承認</h3>
                              <strong data-decision={selectedFeedback.promotionProposal.decision}>
                                {FEEDBACK_PROPOSAL_DECISION_LABELS[selectedFeedback.promotionProposal.decision]}
                              </strong>
                            </div>
                            <dl>
                              <div>
                                <dt>反映先</dt>
                                <dd>{FEEDBACK_PROMOTION_LABELS[selectedFeedback.promotionProposal.kind]} / <code>{selectedFeedback.promotionProposal.target}</code></dd>
                              </div>
                              <div><dt>変更内容</dt><dd>{selectedFeedback.promotionProposal.changeSummary}</dd></div>
                              <div><dt>検証方法</dt><dd>{selectedFeedback.promotionProposal.verification}</dd></div>
                              <div><dt>提案元</dt><dd>{selectedFeedback.promotionProposal.projectName}</dd></div>
                            </dl>
                            {selectedFeedback.promotionProposal.decision === 'pending' ? (
                              <div className="launcher-feedback-approval-actions">
                                <button
                                  disabled={promotionDecisionState === 'saving'}
                                  onClick={() => void decidePromotion('approved')}
                                  type="button"
                                >
                                  {promotionDecisionState === 'saving' ? '記録中…' : '昇格を承認'}
                                </button>
                                <button
                                  className="launcher-secondary"
                                  disabled={promotionDecisionState === 'saving'}
                                  onClick={() => void decidePromotion('rejected')}
                                  type="button"
                                >
                                  今回は見送る
                                </button>
                              </div>
                            ) : (
                              <p>
                                {selectedFeedback.promotionProposal.decision === 'approved'
                                  ? '人の承認を記録しました。共有ルールへ反映し、テストした後に「反映済み」へ進みます。'
                                  : '今回は見送りました。新しい根拠が集まるまで「学習中」を継続します。'}
                              </p>
                            )}
                            {promotionDecisionError && <p className="launcher-feedback-approval-error" role="alert">{promotionDecisionError}</p>}
                          </section>
                        )}

                        <section className="launcher-feedback-detail-section launcher-feedback-next-action">
                          <h3>次にすること</h3>
                          <p>{feedbackNextAction(selectedFeedback)}</p>
                        </section>

                        <section className="launcher-feedback-detail-section">
                          <h3>{selectedFeedback.promotions.length > 0 || !selectedFeedback.promotionProposal ? '昇格先' : '反映済みの昇格先'}</h3>
                          {selectedFeedback.promotions.length > 0 ? (
                            <ul className="launcher-feedback-promotions">
                              {selectedFeedback.promotions.map((promotion, index) => (
                                <li key={`${promotion.projectId}-${promotion.kind}-${promotion.target}-${index}`}>
                                  <span>{FEEDBACK_PROMOTION_LABELS[promotion.kind] ?? '反映先'} / {promotion.projectName}</span>
                                  <code>{promotion.target}</code>
                                  {promotion.promotedAt && <small>反映 {formatUpdatedAt(promotion.promotedAt)}</small>}
                                </li>
                              ))}
                            </ul>
                          ) : <p>{selectedFeedback.promotionProposal ? '承認案の実装完了後に記録されます。' : 'まだ昇格先は設定されていません。'}</p>}
                        </section>

                        <section className="launcher-feedback-detail-section">
                          <h3>根拠となった案件</h3>
                          <ul className="launcher-feedback-projects">
                            {selectedFeedback.projectNames.map((projectName) => (
                              <li key={projectName}><strong>{projectName}</strong></li>
                            ))}
                          </ul>
                          <h4>run ID</h4>
                          <ul className="launcher-feedback-runs">
                            {selectedFeedback.runIds.map((runId) => <li key={runId}><code>{runId}</code></li>)}
                          </ul>
                        </section>

                        <section className="launcher-feedback-detail-section">
                          <h3>証拠</h3>
                          <ul className="launcher-feedback-evidence">
                            {selectedFeedback.evidence.map((path) => <li key={path}><code>{path}</code></li>)}
                          </ul>
                        </section>

                        <div className="launcher-readonly-note">
                          <strong>変更範囲を限定</strong>
                          <p>この棚で書き込むのは昇格案への承認・見送り記録だけです。テンプレート、ルール、Gate、制作stateは自動変更しません。</p>
                        </div>
                      </>
                    ) : (
                      <p className="launcher-selection-empty">左の棚から、詳細を見たい好み・学びを選んでください。</p>
                    )}
                  </aside>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </main>
  )
}
