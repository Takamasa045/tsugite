import {
  ArrowRight,
  BookOpen,
  Clapperboard,
  Clock3,
  FolderOpen,
  LayoutTemplate,
  Moon,
  RefreshCw,
  Search,
  Sparkles,
  Sun,
  Users,
  Workflow,
} from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AgentWorkspaceChooser } from '../components/agent/AgentWorkspaceChooser'

import { CharacterShelf } from '../components/character/CharacterShelf'
import {
  isCharacterListResponse,
  type CharacterLoadState,
  type LauncherCharacter,
} from '../components/character/characterShelfModel'
import { ExpressionShelf } from '../components/expression/ExpressionShelf'
import {
  seedIntentFromTemplate,
  type ExpressionSelection,
  type ExpressionSelectionMode,
  type RecommendationIntentSeed,
} from '../components/expression/expressionLibraryModel'
import { GenerationCanvas } from '../components/generation/GenerationCanvas'
import {
  backendLabelFor,
  isPresentationPresetListResponse,
  mergePresentationPresetOptions,
  PRESENTATION_PRESET_BACKENDS,
  type PresentationPresetListResponse,
  type PresentationPresetLoadState,
  type PresentationPresetOption,
} from '../components/template/presentationPresetModel'
import { TemplateShelf } from '../components/template/TemplateShelf'
import {
  INITIAL_WIZARD_STATE,
  isTemplateListResponse,
  type LauncherTemplate,
  type TemplateLoadState,
  type TemplateWizardState,
} from '../components/template/templateShelfModel'
import { DesktopWorkspaceRecovery } from '../components/workspace/DesktopWorkspaceRecovery'

export type { LauncherTemplate }

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
  gate1ReviewUrl?: string
  gate2ReviewUrl?: string
  thumbnailUrl?: string
  valid: boolean
  refreshable: boolean
  readOnly?: boolean
  issue?: string
}

interface ProjectListResponse {
  ok: true
  projects: LauncherProject[]
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

type Shelf = 'projects' | 'templates' | 'expressions' | 'characters' | 'canvas' | 'feedback'
type LauncherTheme = 'light' | 'dark'
type FeedbackLoadState = 'idle' | 'loading' | 'ready' | 'error'
type PromotionDecisionState = 'idle' | 'saving' | 'error'
type ProjectFilter = 'all' | 'active' | 'waiting' | 'completed' | 'invalid'
type FeedbackFilter = 'all' | FeedbackStage
type FeedbackListMode = 'focus' | 'all'

const defaultFetcher: typeof fetch = (...args) => window.fetch(...args)
const PROJECT_PAGE_SIZE = 12
const FEEDBACK_PAGE_SIZE = 24
const FEEDBACK_FOCUS_SIZE = 8
const FEEDBACK_ACTIVE_RULES_LIMIT = 4
const FEEDBACK_ISSUE_DISPLAY_LIMIT = 5
const FEEDBACK_AUTOMATION_SOURCE_KINDS = [
  'codex_automation',
  'claude_desktop_automation',
  'claude_code_automation',
] as const
type FeedbackAutomationSourceKind = typeof FEEDBACK_AUTOMATION_SOURCE_KINDS[number]

const TRUSTED_PROMOTION_WORKFLOW_ID = 'tsugite-learning-promotion-review'

function isFeedbackAutomationSourceKind(input: unknown): input is FeedbackAutomationSourceKind {
  return typeof input === 'string'
    && FEEDBACK_AUTOMATION_SOURCE_KINDS.includes(input as FeedbackAutomationSourceKind)
}

/** decision とは独立。許可済み Automation かつ専用 workflow のみ信頼する。 */
function isTrustedPromotionSource(preference: FeedbackPreference): boolean {
  const source = preference.promotionProposal?.source
  return isFeedbackAutomationSourceKind(source?.kind)
    && source.workflowId === TRUSTED_PROMOTION_WORKFLOW_ID
}

function isTrustedPendingPromotion(preference: FeedbackPreference): boolean {
  return preference.promotionProposal?.decision === 'pending'
    && isTrustedPromotionSource(preference)
}

function pendingPromotionPreferences(feedback: FeedbackAggregate): FeedbackPreference[] {
  return feedback.preferences.filter(isTrustedPendingPromotion)
}

function isActiveLearningRule(preference: FeedbackPreference): boolean {
  return preference.stage === 'promoted' || preference.stage === 'verified'
}

function focusListPriority(preference: FeedbackPreference): number {
  // 信頼済みpendingだけを最優先。非trusted pendingでfocus 8枠を埋めてはいけない。
  if (isTrustedPendingPromotion(preference)) return 0
  if (preference.stage === 'recurring' && preference.promotionProposal?.decision === 'approved') return 1
  if (preference.stage === 'promoted') return 2
  return 3
}

function focusLearningPreferences(preferences: FeedbackPreference[]): FeedbackPreference[] {
  return [...preferences]
    .sort((left, right) => {
      const priorityDelta = focusListPriority(left) - focusListPriority(right)
      if (priorityDelta !== 0) return priorityDelta
      return right.lastSeenAt.localeCompare(left.lastSeenAt) || left.key.localeCompare(right.key)
    })
    .slice(0, FEEDBACK_FOCUS_SIZE)
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

/** 一覧カード用。untrusted pending は承認待ちと誤認させない。 */
function feedbackCardProposalLabel(preference: FeedbackPreference): string {
  const proposal = preference.promotionProposal
  if (!proposal) return '昇格案の準備待ち'
  if (proposal.decision === 'pending' && !isTrustedPromotionSource(preference)) {
    return '内容確認のみ'
  }
  return FEEDBACK_PROPOSAL_DECISION_LABELS[proposal.decision]
}

const FEEDBACK_STAGES = Object.keys(FEEDBACK_STAGE_LABELS) as FeedbackStage[]
const SHELVES: Shelf[] = ['projects', 'templates', 'expressions', 'characters', 'canvas', 'feedback']
const THEME_STORAGE_KEY = 'tsugite-launcher-theme'

function initialLauncherTheme(): LauncherTheme {
  if (typeof window === 'undefined') return 'dark'
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
  return saved === 'light' || saved === 'dark' ? saved : 'dark'
}

function feedbackNextStageLabel(preference: FeedbackPreference): string {
  if (preference.stage !== 'recurring' || !preference.promotionProposal) {
    return FEEDBACK_NEXT_STAGE_LABELS[preference.stage]
  }
  if (preference.promotionProposal.decision === 'pending') {
    // untrusted pending はランチャーから承認不可。確認のみの文言に揃える。
    if (!isTrustedPromotionSource(preference)) return '内容の確認のみ（承認・見送り不可）'
    return '昇格案を確認し、人が承認または見送り'
  }
  if (preference.promotionProposal.decision === 'approved') return '共有先へ反映し、テストして反映済みへ'
  return '新しい根拠が集まるまで学習中を継続'
}

function feedbackNextAction(preference: FeedbackPreference): string {
  if (preference.stage !== 'recurring' || !preference.promotionProposal) {
    return FEEDBACK_NEXT_ACTIONS[preference.stage]
  }
  if (preference.promotionProposal.decision === 'pending') {
    if (!isTrustedPromotionSource(preference)) {
      return 'この提案はランチャーから承認できません。内容の確認のみ行えます。'
    }
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

function promotionRecencyKey(preference: FeedbackPreference): string {
  return latestPromotionAt(preference) ?? preference.lastSeenAt
}

function compareActiveRulesByRecency(left: FeedbackPreference, right: FeedbackPreference): number {
  const leftKey = promotionRecencyKey(left)
  const rightKey = promotionRecencyKey(right)
  return rightKey.localeCompare(leftKey) || left.key.localeCompare(right.key)
}

function activeLearningRules(preferences: FeedbackPreference[]): FeedbackPreference[] {
  return preferences
    .filter(isActiveLearningRule)
    .sort(compareActiveRulesByRecency)
}

function latestPromotion(preference: FeedbackPreference): FeedbackPromotion | undefined {
  return preference.promotions.reduce<FeedbackPromotion | undefined>((latest, promotion) => {
    if (!latest) return promotion
    if (!promotion.promotedAt) return latest
    if (!latest.promotedAt || promotion.promotedAt > latest.promotedAt) return promotion
    return latest
  }, undefined)
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

/** Match name/slug/runId, including pasted paths like projects/<slug>/dist/<runId>/final.mp4. */
export function projectMatchesQuery(project: LauncherProject, rawQuery: string): boolean {
  const normalized = rawQuery.trim().toLocaleLowerCase('ja')
  if (!normalized) return true
  const fields = [project.name, project.slug, project.runId]
    .map((value) => value.toLocaleLowerCase('ja'))
    .filter(Boolean)
  // Path paste: exact path segments only, so short slugs do not steal longer siblings.
  if (/[/\\]/.test(normalized)) {
    const segments = normalized.split(/[/\\]+/).filter(Boolean)
    return fields.some((field) => segments.includes(field))
  }
  return fields.some((field) => field.includes(normalized))
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
    && (!('gate1ReviewUrl' in input) || input.gate1ReviewUrl === undefined || typeof input.gate1ReviewUrl === 'string')
    && (!('gate2ReviewUrl' in input) || input.gate2ReviewUrl === undefined || typeof input.gate2ReviewUrl === 'string')
    && (!('thumbnailUrl' in input) || input.thumbnailUrl === undefined || typeof input.thumbnailUrl === 'string')
    && 'valid' in input && typeof input.valid === 'boolean'
    && 'refreshable' in input && typeof input.refreshable === 'boolean'
    && (!('readOnly' in input) || typeof input.readOnly === 'boolean')
    && (!('issue' in input) || input.issue === undefined || typeof input.issue === 'string')
}

function isProjectListResponse(input: unknown): input is ProjectListResponse {
  return typeof input === 'object' && input !== null && 'ok' in input && input.ok === true
    && 'projects' in input && Array.isArray(input.projects) && input.projects.every(isLauncherProject)
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
    && 'project' in input && isLauncherProject(input.project)
}

function isRefreshErrorResponse(input: unknown): input is RefreshErrorResponse {
  if (typeof input !== 'object' || input === null || !('ok' in input) || input.ok !== false) return false
  if (!('issue' in input) || typeof input.issue !== 'object' || input.issue === null) return false
  return 'code' in input.issue && typeof input.issue.code === 'string'
    && 'message' in input.issue && typeof input.issue.message === 'string'
}

interface RenameResponse {
  ok: true
  name: string
  project?: LauncherProject
}

interface RenameErrorResponse {
  ok: false
  issue: { code: string; message: string }
}

function isRenameResponse(input: unknown): input is RenameResponse {
  return typeof input === 'object' && input !== null
    && 'ok' in input && input.ok === true
    && 'name' in input && typeof input.name === 'string'
}

function isRenameErrorResponse(input: unknown): input is RenameErrorResponse {
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
  const [theme, setTheme] = useState<LauncherTheme>(initialLauncherTheme)
  const [projects, setProjects] = useState<LauncherProject[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>('all')
  const [visibleProjectCount, setVisibleProjectCount] = useState(PROJECT_PAGE_SIZE)
  const [loading, setLoading] = useState(true)
  const [projectListRefreshing, setProjectListRefreshing] = useState(false)
  const [projectListRefreshError, setProjectListRefreshError] = useState<string | null>(null)
  const [projectListRefreshNotice, setProjectListRefreshNotice] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [templates, setTemplates] = useState<LauncherTemplate[]>([])
  const [templateLoadState, setTemplateLoadState] = useState<TemplateLoadState>('idle')
  /** 棚タブ離脱後もウィザード進行を保持する */
  const [templateWizardState, setTemplateWizardState] = useState<TemplateWizardState>(INITIAL_WIZARD_STATE)
  const [presentationPresets, setPresentationPresets] = useState<PresentationPresetOption[]>([])
  const [presentationPresetLoadState, setPresentationPresetLoadState] = useState<PresentationPresetLoadState>('idle')
  /** 片側 backend だけ失敗したときの非ブロッキング案内（全失敗時は null。loadState=error が担う） */
  const [presentationPresetNotice, setPresentationPresetNotice] = useState<string | null>(null)
  /** 表現棚の選択。テンプレート最終画面へ戻っても保持する */
  const [expressionSelections, setExpressionSelections] = useState<ExpressionSelection[]>([])
  const [expressionSelectionMode, setExpressionSelectionMode] = useState<ExpressionSelectionMode>('unset')
  const [expressionIntentSeed, setExpressionIntentSeed] = useState<RecommendationIntentSeed | null>(null)
  const [expressionReturnShelf, setExpressionReturnShelf] = useState<Shelf | null>(null)
  /** After template↔expression unmount, restore keyboard focus post-commit. */
  const pendingShelfFocusRef = useRef<'expressions-entry' | 'templates-return' | null>(null)
  /**
   * Prefer restoring the pre-unmount expression trigger by stable template id
   * (same accessible name can appear on multiple cards).
   */
  const expressionReturnFocusTemplateIdRef = useRef<string | null>(null)
  const [characters, setCharacters] = useState<LauncherCharacter[]>([])
  const [characterLoadState, setCharacterLoadState] = useState<CharacterLoadState>('idle')
  const [feedback, setFeedback] = useState<FeedbackAggregate | null>(null)
  const [feedbackLoadState, setFeedbackLoadState] = useState<FeedbackLoadState>('idle')
  const [selectedFeedbackKey, setSelectedFeedbackKey] = useState<string | null>(null)
  const [feedbackFilter, setFeedbackFilter] = useState<FeedbackFilter>('all')
  const [feedbackListMode, setFeedbackListMode] = useState<FeedbackListMode>('focus')
  const [visibleFeedbackCount, setVisibleFeedbackCount] = useState(FEEDBACK_PAGE_SIZE)
  const [promotionDecisionState, setPromotionDecisionState] = useState<PromotionDecisionState>('idle')
  const [promotionDecisionError, setPromotionDecisionError] = useState<string | null>(null)
  // decidePromotion の await 後に最新選択/表示modeを読む（stale closure 防止）
  const selectedFeedbackKeyRef = useRef(selectedFeedbackKey)
  const feedbackListModeRef = useRef(feedbackListMode)
  selectedFeedbackKeyRef.current = selectedFeedbackKey
  feedbackListModeRef.current = feedbackListMode
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renameNotice, setRenameNotice] = useState<string | null>(null)

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  const acceptFeedback = useCallback((nextFeedback: FeedbackAggregate) => {
    setFeedback(nextFeedback)
    setSelectedFeedbackKey((current) => {
      if (current && nextFeedback.preferences.some((preference) => preference.key === current)) {
        return current
      }
      return focusLearningPreferences(nextFeedback.preferences)[0]?.key
        ?? nextFeedback.preferences[0]?.key
        ?? null
    })
  }, [])

  const loadProjects = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    if (background) {
      setProjectListRefreshing(true)
      setProjectListRefreshError(null)
      setProjectListRefreshNotice(null)
    } else {
      setLoading(true)
      setLoadError(null)
    }
    try {
      const response = await fetcher('/api/projects', { headers: { accept: 'application/json' } })
      const payload: unknown = await response.json()
      if (!response.ok || !isProjectListResponse(payload)) throw new Error('invalid project list')
      setProjects(payload.projects)
      if (background) {
        setProjectListRefreshNotice(payload.projects.length > 0
          ? `制作案件を再読み込みしました。${payload.projects.length}件見つかりました。`
          : '再読み込みしましたが、このworkspaceには制作案件がありません。projectsフォルダとworkspaceを確認してください。')
      }
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
      setTemplateLoadState('ready')
    } catch {
      setTemplateLoadState('error')
    }
  }, [fetcher])

  const loadPresentationPresets = useCallback(async () => {
    setPresentationPresetLoadState('loading')
    setPresentationPresetNotice(null)
    // backend ごとに独立に扱い、片側失敗で成功分を消さない
    const settled = await Promise.all(
      PRESENTATION_PRESET_BACKENDS.map(async (backend) => {
        try {
          const response = await fetcher(
            `/api/presets?backend=${encodeURIComponent(backend)}`,
            { headers: { accept: 'application/json' } },
          )
          const payload: unknown = await response.json()
          if (!response.ok || !isPresentationPresetListResponse(payload)) {
            return { backend, ok: false as const }
          }
          return { backend, ok: true as const, payload }
        } catch {
          return { backend, ok: false as const }
        }
      }),
    )
    const successes = settled.filter(
      (entry): entry is { backend: typeof entry.backend; ok: true; payload: PresentationPresetListResponse } => (
        entry.ok
      ),
    )
    const failures = settled.filter((entry) => !entry.ok)
    if (successes.length === 0) {
      setPresentationPresets([])
      setPresentationPresetNotice(null)
      setPresentationPresetLoadState('error')
      return
    }
    setPresentationPresets(mergePresentationPresetOptions(successes.map((entry) => entry.payload)))
    setPresentationPresetLoadState('ready')
    if (failures.length > 0) {
      const failedLabels = failures.map((entry) => backendLabelFor(entry.backend)).join('・')
      setPresentationPresetNotice(
        `${failedLabels}の仕上げの動きを読み込めませんでした。表示中の候補だけで選べます。`,
      )
    } else {
      setPresentationPresetNotice(null)
    }
  }, [fetcher])

  const loadCharacters = useCallback(async () => {
    setCharacterLoadState('loading')
    try {
      const response = await fetcher('/api/characters', { headers: { accept: 'application/json' } })
      const payload: unknown = await response.json()
      if (!response.ok || !isCharacterListResponse(payload)) throw new Error('invalid character list')
      setCharacters(payload.characters)
      setCharacterLoadState('ready')
    } catch {
      setCharacterLoadState('error')
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
    document.title = 'Tsugite 制作ランチャー'
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadAttempt, loadProjects])

  useEffect(() => {
    void loadFeedback()
  }, [loadFeedback])

  const filteredProjects = useMemo(() => {
    return projects
      .filter((project) => projectMatchesFilter(project, projectFilter))
      .filter((project) => projectMatchesQuery(project, query))
      .sort(compareProjectsByRecentUpdate)
  }, [projectFilter, projects, query])

  const visibleProjects = filteredProjects.slice(0, visibleProjectCount)
  const remainingProjectCount = Math.max(0, filteredProjects.length - visibleProjects.length)

  useEffect(() => {
    setVisibleProjectCount(PROJECT_PAGE_SIZE)
  }, [projectFilter, query])

  const filteredFeedback = useMemo(() => (
    feedback?.preferences.filter((preference) => feedbackFilter === 'all' || preference.stage === feedbackFilter) ?? []
  ), [feedback, feedbackFilter])
  const feedbackStageCounts = useMemo(() => FEEDBACK_STAGES.reduce<Record<FeedbackStage, number>>((counts, stage) => {
    counts[stage] = feedback?.preferences.filter((preference) => preference.stage === stage).length ?? 0
    return counts
  }, { observed: 0, recurring: 0, promoted: 0, verified: 0 }), [feedback])
  const focusFeedback = useMemo(
    () => (feedback ? focusLearningPreferences(feedback.preferences) : []),
    [feedback],
  )
  const listedFeedback = feedbackListMode === 'focus' ? focusFeedback : filteredFeedback
  const activeRules = useMemo(
    () => (feedback ? activeLearningRules(feedback.preferences) : []),
    [feedback],
  )
  const activeRuleCount = activeRules.length
  const recentActiveRules = useMemo(
    () => activeRules.slice(0, FEEDBACK_ACTIVE_RULES_LIMIT),
    [activeRules],
  )
  const selected = projects.find((project) => project.id === selectedId) ?? null
  useEffect(() => {
    setRenaming(false)
    setRenameDraft('')
    setRenameError(null)
    // 選択切替時は編集中の下書きだけ捨てる。成功メッセージは残して確認できるようにする。
  }, [selectedId])
  // focus外の選択は all へ逃がすまでの1フレームでも詳細が別項目へ落ちないよう、全件から解決する。
  const selectedFeedback = listedFeedback.find((preference) => preference.key === selectedFeedbackKey)
    ?? (
      feedbackListMode === 'focus' && selectedFeedbackKey
        ? feedback?.preferences.find((preference) => preference.key === selectedFeedbackKey)
        : undefined
    )
    ?? listedFeedback[0]
    ?? null
  const visibleFeedback = feedbackListMode === 'focus'
    ? listedFeedback
    : listedFeedback.slice(0, visibleFeedbackCount)
  const remainingFeedbackCount = feedbackListMode === 'focus'
    ? 0
    : Math.max(0, listedFeedback.length - visibleFeedback.length)
  const pendingPromotions = useMemo(() => (
    feedback ? pendingPromotionPreferences(feedback) : []
  ), [feedback])
  const pendingPromotionCount = pendingPromotions.length
  const issueCount = feedback?.issues.length ?? 0

  const projectSummary = useMemo(() => ({
    active: projects.filter((project) => projectMatchesFilter(project, 'active')).length,
    waiting: projects.filter((project) => projectMatchesFilter(project, 'waiting')).length,
    completed: projects.filter((project) => projectMatchesFilter(project, 'completed')).length,
  }), [projects])

  // 選択が一覧に無いときだけ先頭へ寄せる。別 state は触らない（純粋 effect）。
  useEffect(() => {
    setVisibleFeedbackCount(FEEDBACK_PAGE_SIZE)
    setSelectedFeedbackKey((current) => {
      if (current && listedFeedback.some((preference) => preference.key === current)) {
        return current
      }
      return listedFeedback[0]?.key ?? null
    })
  }, [feedback, feedbackFilter, feedbackListMode, listedFeedback])

  const selectShelf = (shelf: Shelf) => {
    // 通常のタブ選択では template return context を破棄する。
    // 維持するのは openExpressionsFromTemplate（「表現を変更」）経由の直後だけ。
    setExpressionReturnShelf(null)
    setActiveShelf(shelf)
    if (shelf === 'templates' && templateLoadState === 'idle') void loadTemplates()
    if (shelf === 'expressions' && presentationPresetLoadState === 'idle') {
      void loadPresentationPresets()
    }
    if (shelf === 'characters' && characterLoadState === 'idle') void loadCharacters()
    if (shelf === 'feedback') {
      setVisibleFeedbackCount(FEEDBACK_PAGE_SIZE)
      setSelectedFeedbackKey((current) => (
        current && listedFeedback.some((preference) => preference.key === current)
          ? current
          : listedFeedback[0]?.key ?? current
      ))
      if (feedbackLoadState === 'idle') void loadFeedback()
    }
  }

  const handleTemplateWizardStateChange = useCallback((next: TemplateWizardState) => {
    setTemplateWizardState(next)
    setExpressionSelections(next.expressionSelections ?? [])
    setExpressionSelectionMode(next.expressionSelectionMode ?? 'unset')
  }, [])

  const handleExpressionSelectionsChange = useCallback((next: {
    selections: ExpressionSelection[]
    mode: ExpressionSelectionMode
  }) => {
    setExpressionSelections(next.selections)
    setExpressionSelectionMode(next.mode)
    setTemplateWizardState((current) => ({
      ...current,
      expressionSelections: next.selections,
      expressionSelectionMode: next.mode,
    }))
  }, [])

  const captureExpressionReturnFocusTarget = () => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) {
      expressionReturnFocusTemplateIdRef.current = null
      return
    }
    const templateId = active.getAttribute('data-template-id')?.trim()
    expressionReturnFocusTemplateIdRef.current = templateId || null
  }

  const openExpressionsFromTemplate = (template: LauncherTemplate) => {
    captureExpressionReturnFocusTarget()
    // Fallback: if focus was not on a marked trigger, still bind to this template id.
    if (!expressionReturnFocusTemplateIdRef.current) {
      expressionReturnFocusTemplateIdRef.current = template.id
    }
    pendingShelfFocusRef.current = 'expressions-entry'
    setExpressionIntentSeed(seedIntentFromTemplate(template))
    setExpressionReturnShelf('templates')
    setActiveShelf('expressions')
    if (presentationPresetLoadState === 'idle') void loadPresentationPresets()
  }

  const returnFromExpressions = () => {
    const target = expressionReturnShelf ?? 'templates'
    pendingShelfFocusRef.current = target === 'templates' ? 'templates-return' : null
    setExpressionReturnShelf(null)
    setActiveShelf(target)
    if (target === 'templates' && templateLoadState === 'idle') void loadTemplates()
  }

  // Focus after tabpanel unmount/remount — only for explicit expression entry/return.
  // useEffect (not layout) so it wins over child mount focus (e.g. TemplateChecklist h2).
  // ArrowLeft/Right/Home/End tab roving stays on handleShelfKeyDown (no extra side effects).
  // Cross-shelf restore uses default focus() so the browser may scroll the target into view
  // (Focus Not Obscured). Do not pass preventScroll here — deep triggers can leave the
  // new heading outside the viewport. Avoid a second scrollIntoView to prevent double scroll.
  useEffect(() => {
    const pending = pendingShelfFocusRef.current
    if (!pending) return
    pendingShelfFocusRef.current = null

    if (pending === 'expressions-entry' && activeShelf === 'expressions') {
      const heading = document.getElementById('launcher-expressions-heading')
      if (heading instanceof HTMLElement) {
        heading.focus()
        return
      }
      document.getElementById('launcher-expressions-tab')?.focus()
      return
    }

    if (pending === 'templates-return' && activeShelf === 'templates') {
      const returnTemplateId = expressionReturnFocusTemplateIdRef.current
      expressionReturnFocusTemplateIdRef.current = null
      if (returnTemplateId) {
        const buttons = Array.from(document.querySelectorAll('button[data-expression-return-trigger]'))
        const match = buttons.find((button) => {
          return button.getAttribute('data-template-id') === returnTemplateId
        })
        if (match instanceof HTMLElement && document.contains(match)) {
          match.focus()
          return
        }
      }
      document.getElementById('launcher-templates-tab')?.focus()
    }
  }, [activeShelf])

  const selectFeedbackPreference = (key: string) => {
    setSelectedFeedbackKey(key)
    // 決定操作の in-flight は選択と分離する。saving 中に idle へ戻すと別項目の承認が再有効になる。
    if (promotionDecisionState === 'saving') return
    setPromotionDecisionState('idle')
    setPromotionDecisionError(null)
  }

  const openFeedbackPreference = (key: string) => {
    const inFocus = focusFeedback.some((item) => item.key === key)
    setFeedbackListMode(inFocus ? 'focus' : 'all')
    setFeedbackFilter('all')
    selectFeedbackPreference(key)
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
    setRenaming(false)
    setRenameDraft('')
    setRenameError(null)
    setRenameNotice(null)
  }

  const beginRename = () => {
    if (!selected || selected.readOnly || renameSaving) return
    setRenaming(true)
    setRenameDraft(selected.name)
    setRenameError(null)
    setRenameNotice(null)
  }

  const cancelRename = () => {
    if (renameSaving) return
    setRenaming(false)
    setRenameDraft('')
    setRenameError(null)
  }

  const saveRename = async () => {
    if (!selected || selected.readOnly || renameSaving) return
    const nextName = renameDraft.trim()
    if (!nextName) {
      setRenameError('案件名を入力してください。')
      return
    }
    if (nextName.length > 120) {
      setRenameError('案件名は120文字以内にしてください。')
      return
    }
    if (nextName === selected.name) {
      setRenaming(false)
      setRenameDraft('')
      setRenameError(null)
      return
    }
    setRenameSaving(true)
    setRenameError(null)
    setRenameNotice(null)
    try {
      const response = await fetcher(`/api/projects/${encodeURIComponent(selected.id)}/rename`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-tsugite-token': token,
        },
        body: JSON.stringify({ name: nextName }),
      })
      const payload: unknown = await response.json()
      if (!response.ok || !isRenameResponse(payload)) {
        const message = isRenameErrorResponse(payload)
          ? payload.issue.message
          : '案件名を変更できませんでした。'
        throw new Error(message)
      }
      if (payload.project && isLauncherProject(payload.project)) {
        setProjects((current) => current.map((project) => (
          project.id === payload.project!.id ? payload.project! : project
        )))
      } else {
        await loadProjects({ background: true })
      }
      setRenaming(false)
      setRenameDraft('')
      setRenameNotice(`案件名を「${payload.name}」に変更しました。`)
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : '案件名を変更できませんでした。')
    } finally {
      setRenameSaving(false)
    }
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
    if (promotionDecisionState === 'saving') return
    // fail-closed: 信頼済み source かつ pending 以外は fetch しない
    if (!selectedFeedback || !isTrustedPendingPromotion(selectedFeedback)) {
      setPromotionDecisionState('error')
      setPromotionDecisionError('この提案はランチャーから承認できません。')
      return
    }
    const proposal = selectedFeedback.promotionProposal
    if (!proposal) {
      setPromotionDecisionState('error')
      setPromotionDecisionError('この提案はランチャーから承認できません。')
      return
    }
    // POST/更新対象は開始時の選択A。応答中にBへ移ってもAのまま。
    const requestKey = selectedFeedback.key
    const requestProjectId = proposal.projectId
    const requestProposalId = proposal.id
    setPromotionDecisionState('saving')
    setPromotionDecisionError(null)
    try {
      const response = await fetcher(`/api/feedback/${encodeURIComponent(requestProjectId)}/promotion-decision`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-tsugite-token': token,
        },
        body: JSON.stringify({ key: requestKey, proposalId: requestProposalId, decision }),
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
      const decidedAt = new Date().toISOString()
      const mergePromotionDecision = (preferences: FeedbackPreference[]) => (
        preferences.map((preference) => (
          preference.key === requestKey && preference.promotionProposal
            ? {
                ...preference,
                promotionProposal: {
                  ...preference.promotionProposal,
                  decision,
                  decidedAt,
                  decidedBy: 'human' as const,
                },
              }
            : preference
        ))
      )
      // 応答対象 key だけを最新 preferences へ functional merge。全件スナップショット置換はしない。
      setFeedback((current) => (
        current ? { ...current, preferences: mergePromotionDecision(current.preferences) } : current
      ))
      // 応答時点で選択がAのまま・modeがfocus・AがnextFocus外のときだけ all へ。
      // B表示中にAの遅延成功で all に切替しない（ref で最新値を参照）。
      if (
        feedbackListModeRef.current === 'focus'
        && selectedFeedbackKeyRef.current === requestKey
        && feedback
      ) {
        const nextFocus = focusLearningPreferences(mergePromotionDecision(feedback.preferences))
        if (!nextFocus.some((preference) => preference.key === requestKey)) {
          setFeedbackListMode('all')
          setFeedbackFilter('all')
        }
      }
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
        <span className="eyebrow">Tsugite 制作の見取図</span>
        <h1>制作作品を開けません</h1>
        <p>{loadError}</p>
        <button className="launcher-primary" onClick={() => setLoadAttempt((value) => value + 1)} type="button">
          <RefreshCw aria-hidden="true" size={17} />
          もう一度読み込む
        </button>
      </main>
    )
  }

  const compactHero = activeShelf !== 'projects'

  return (
    <main className="launcher-shell" data-theme={theme} data-shelf={activeShelf}>
      <section
        aria-label={compactHero ? 'ランチャー' : '制作の見取図'}
        className="launcher-hero"
        data-compact={compactHero || undefined}
      >
        <nav className="launcher-hero-nav">
          <div className="launcher-wordmark">
            <img alt="" aria-hidden="true" className="launcher-favicon-mark" src="./assets/tsugite-favicon.png" />
            <span><strong>TSUGITE</strong><small>制作アーカイブ</small></span>
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
              <FolderOpen aria-hidden="true" size={17} />制作作品
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
              aria-controls="launcher-expressions-panel"
              aria-selected={activeShelf === 'expressions'}
              id="launcher-expressions-tab"
              onClick={() => selectShelf('expressions')}
              onKeyDown={(event) => handleShelfKeyDown(event, 'expressions')}
              role="tab"
              tabIndex={activeShelf === 'expressions' ? 0 : -1}
              type="button"
            >
              <Sparkles aria-hidden="true" size={17} />表現
            </button>
            <button
              aria-controls="launcher-characters-panel"
              aria-selected={activeShelf === 'characters'}
              id="launcher-characters-tab"
              onClick={() => selectShelf('characters')}
              onKeyDown={(event) => handleShelfKeyDown(event, 'characters')}
              role="tab"
              tabIndex={activeShelf === 'characters' ? 0 : -1}
              type="button"
            >
              <Users aria-hidden="true" size={17} />キャラクター
            </button>
            <button
              aria-controls="launcher-canvas-panel"
              aria-selected={activeShelf === 'canvas'}
              id="launcher-canvas-tab"
              onClick={() => selectShelf('canvas')}
              onKeyDown={(event) => handleShelfKeyDown(event, 'canvas')}
              role="tab"
              tabIndex={activeShelf === 'canvas' ? 0 : -1}
              type="button"
            >
              <Workflow aria-hidden="true" size={17} />生成キャンバス
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
            <div aria-label="テーマを選ぶ" className="launcher-theme-switch" role="group">
              <button
                aria-label="ライトモード"
                aria-pressed={theme === 'light'}
                onClick={() => setTheme('light')}
                title="ライトモード"
                type="button"
              >
                <Sun aria-hidden="true" size={16} />
              </button>
              <button
                aria-label="ダークモード"
                aria-pressed={theme === 'dark'}
                onClick={() => setTheme('dark')}
                title="ダークモード"
                type="button"
              >
                <Moon aria-hidden="true" size={16} />
              </button>
            </div>
          </nav>

        {!compactHero && (
          <>
            <div className="launcher-hero-content">
              <div aria-hidden="true" className="launcher-hero-joinery"><span /><i /></div>
              <div className="launcher-hero-copy">
                <span className="eyebrow">映像制作の玄関</span>
                <h1>制作の見取図を開く</h1>
                <p>作品ごとの現在地を見渡し、最新の制作記録へ。作りたい映像に合う型も、同じ棚から探せます。</p>
              </div>
              <aside aria-label="現在の棚" className="launcher-hero-note">
                <small>現在の棚</small>
                <strong>制作作品</strong>
                <span>最近更新した順に並んでいます</span>
              </aside>
            </div>

            <dl aria-label="作品の状況" className="launcher-hero-metrics">
              <div><dt>全作品</dt><dd>{projects.length}</dd></div>
              <div><dt>進行中</dt><dd>{projectSummary.active}</dd></div>
              <div><dt>確認待ち</dt><dd>{projectSummary.waiting}</dd></div>
              <div><dt>完了</dt><dd>{projectSummary.completed}</dd></div>
            </dl>
          </>
        )}

        {compactHero && (
          <div className="launcher-hero-compact-bar" aria-label="現在の棚">
            <div>
              <small>現在の棚</small>
              <strong>{{
                projects: '制作作品',
                templates: 'テンプレート',
                expressions: '表現',
                characters: 'キャラクター',
                canvas: '生成キャンバス',
                feedback: '好み・学び',
              }[activeShelf]}</strong>
            </div>
            <p>{{
              projects: '作品を選び、最新の制作記録を開きます',
              templates: '作りたい動画を選び、制作依頼を確認してコピーします',
              expressions: '動きや仕上げを見比べて、制作依頼に入れる候補を選びます',
              characters: 'キャラを確認し、依頼メモをコピーします',
              canvas: '画像・動画の工程をつないで設計します',
              feedback: '制作から育った知見を確認できます',
            }[activeShelf]}</p>
          </div>
        )}
      </section>

      {/* テンプレート棚・表現棚は専用UIに一本化（ここでの3段階は出さない） */}
      {activeShelf !== 'templates' && activeShelf !== 'expressions' && (
      <ol aria-label="見取図を開く手順" className="launcher-joinery">
        {activeShelf === 'projects' ? (
          <>
            <li data-active="true"><span>一</span><strong>選ぶ</strong></li>
            <li data-active={selected !== null}><span>二</span><strong>最新にする</strong></li>
            <li data-active="false"><span>三</span><strong>見る</strong></li>
          </>
        ) : activeShelf === 'characters' ? (
          <>
            <li data-active="true"><span>一</span><strong>選ぶ</strong></li>
            <li data-active={characterLoadState === 'ready'}><span>二</span><strong>元を確認</strong></li>
            <li data-active="false"><span>三</span><strong>依頼する</strong></li>
          </>
        ) : activeShelf === 'canvas' ? (
          <>
            <li data-active="true"><span>一</span><strong>置く</strong></li>
            <li data-active="true"><span>二</span><strong>つなぐ</strong></li>
            <li data-active="false"><span>三</span><strong>生成する</strong></li>
          </>
        ) : (
          <>
            <li data-active="true"><span>一</span><strong>観測する</strong></li>
            <li data-active={feedbackLoadState === 'ready'}><span>二</span><strong>育てる</strong></li>
            <li data-active={selectedFeedback?.stage === 'verified'}><span>三</span><strong>確かめる</strong></li>
          </>
        )}
      </ol>
      )}

      {activeShelf === 'projects' ? (
        <>
          <section aria-labelledby="launcher-projects-tab" className="launcher-workbench" id="launcher-projects-panel" role="tabpanel">
          <section aria-busy={projectListRefreshing} aria-labelledby="project-list-title" className="launcher-projects">
            <div className="launcher-section-heading">
              <div>
                <span className="eyebrow">制作棚</span>
                <h2 id="project-list-title">作品を選ぶ</h2>
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
            {projectListRefreshNotice && (
              <p className="launcher-project-list-refresh-notice" role="status">{projectListRefreshNotice}</p>
            )}

            {projects.length > 0 && (
              <div className="launcher-project-tools">
                <label className="launcher-search">
                  <Search aria-hidden="true" size={17} />
                  <span className="sr-only">制作案件を検索</span>
                  <input
                    aria-label="制作案件を検索"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="名前・run ID・パスで絞り込む"
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
                <DesktopWorkspaceRecovery />
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
                        ? `${project.name}の制作工程を最新にして開く`
                        : project.hasViewer && project.viewerUrl
                          ? `${project.name}の前回の制作工程を開く`
                          : `${project.name}の制作工程はまだ開けません`}
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
                          制作工程を開く
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
                        <small className="launcher-project-id">作品ID: {project.slug}</small>
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
                          {project.readOnly && <small>別worktree（閲覧のみ）</small>}
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
                {renaming ? (
                  <form
                    className="launcher-rename-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void saveRename()
                    }}
                  >
                    <label className="launcher-rename-label" htmlFor="launcher-project-rename-input">
                      案件名
                    </label>
                    <input
                      autoFocus
                      className="launcher-rename-input"
                      disabled={renameSaving}
                      id="launcher-project-rename-input"
                      maxLength={120}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelRename()
                        }
                      }}
                      placeholder="例: 北アルプス シネマ20秒"
                      type="text"
                      value={renameDraft}
                    />
                    <div className="launcher-rename-actions">
                      <button className="launcher-primary" disabled={renameSaving || !renameDraft.trim()} type="submit">
                        {renameSaving ? '保存しています…' : '名前を保存'}
                      </button>
                      <button className="launcher-secondary" disabled={renameSaving} onClick={cancelRename} type="button">
                        やめる
                      </button>
                    </div>
                    <small className="launcher-rename-hint">slug・フォルダ名は変わりません。表示名だけを書き換えます。</small>
                  </form>
                ) : (
                  <div className="launcher-selection-title-row">
                    <h2>{selected.name}</h2>
                    {!selected.readOnly && (
                      <button
                        className="launcher-rename-start"
                        disabled={refreshing || projectListRefreshing || renameSaving}
                        onClick={beginRename}
                        type="button"
                      >
                        名前を変更
                      </button>
                    )}
                  </div>
                )}
                <dl className="launcher-project-meta">
                  <div><dt>現在の状況</dt><dd>{selected.valid ? statusLabel(selected.status) : '設定の確認が必要'}</dd></div>
                  <div><dt>制作記録</dt><dd>{selected.runId}</dd></div>
                  <div><dt>最終更新</dt><dd><Clock3 aria-hidden="true" size={15} />{formatUpdatedAt(selected.updatedAt)}</dd></div>
                  {selected.readOnly && <div><dt>操作範囲</dt><dd>別worktree（閲覧のみ）</dd></div>}
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
                      ? 'project.yamlと参照ファイルを確認してください。name（案件名）が無い場合は「名前を変更」で付けられます。'
                      : selected.refreshable
                        ? 'Viewer表示だけを安全に更新します。制作実行前にバックエンド能力を確認してください。'
                        : '前回の表示がある場合は、更新せずに開けます。'}</small>
                  </div>
                )}
                {renameError && <p className="launcher-refresh-error" role="alert">{renameError}</p>}
                {renameNotice && <p className="launcher-refresh-notice" role="status">{renameNotice}</p>}
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
                  {(selected.gate1ReviewUrl || selected.gate2ReviewUrl) && (
                    <div aria-label="Gate確認（閲覧専用）" className="launcher-gate-review-actions" role="group">
                      <span className="launcher-gate-review-label">Gate確認（閲覧専用）</span>
                      {selected.gate1ReviewUrl && (
                        <button
                          className="launcher-secondary"
                          disabled={refreshing || projectListRefreshing}
                          onClick={() => navigate(selected.gate1ReviewUrl!)}
                          type="button"
                        >
                          Gate 1 確認画面を開く
                          <ArrowRight aria-hidden="true" size={16} />
                        </button>
                      )}
                      {selected.gate2ReviewUrl && (
                        <button
                          className="launcher-secondary"
                          disabled={refreshing || projectListRefreshing}
                          onClick={() => navigate(selected.gate2ReviewUrl!)}
                          type="button"
                        >
                          Gate 2 素材確認を開く
                          <ArrowRight aria-hidden="true" size={16} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p className="launcher-selection-empty">左の制作棚から、確認したい案件を選んでください。</p>
            )}
          </aside>
          </section>
        </>
      ) : activeShelf === 'templates' ? (
        <TemplateShelf
          initialState={{
            ...templateWizardState,
            expressionSelections,
            expressionSelectionMode,
          }}
          loadState={templateLoadState}
          onOpenExpressions={openExpressionsFromTemplate}
          onRetry={() => void loadTemplates()}
          onStateChange={handleTemplateWizardStateChange}
          templates={templates}
        />
      ) : activeShelf === 'expressions' ? (
        <ExpressionShelf
          fetcher={fetcher}
          intentSeed={expressionIntentSeed}
          onClearIntentSeed={() => setExpressionIntentSeed(null)}
          onReturnToTemplate={expressionReturnShelf === 'templates' ? returnFromExpressions : undefined}
          onSelectionsChange={handleExpressionSelectionsChange}
          presentationPresetLoadState={presentationPresetLoadState}
          presentationPresetNotice={presentationPresetNotice}
          presentationPresets={presentationPresets}
          onRetryPresentationPresets={() => void loadPresentationPresets()}
          returnLabel="テンプレートへ戻る"
          selectionMode={expressionSelectionMode}
          selections={expressionSelections}
          token={token}
        />
      ) : activeShelf === 'characters' ? (
        <CharacterShelf
          characters={characters}
          fetcher={fetcher}
          loadState={characterLoadState}
          onRetry={() => void loadCharacters()}
          projects={projects}
          token={token}
        />
      ) : activeShelf === 'canvas' ? (
        <GenerationCanvas
          fetcher={fetcher}
          onProjectSelect={setSelectedId}
          projects={projects}
          selectedProjectId={selectedId}
        />
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
                  <p>今確認すること、制作に使っているルール、最近の反映を先に把握できます。</p>
                </div>
                <span className="launcher-count">
                  全{feedback.preferences.length}件 / 表示{visibleFeedback.length}件
                </span>
              </header>

              <section aria-labelledby="launcher-feedback-summary-heading" className="launcher-feedback-summary">
                <header>
                  <div>
                    <span className="launcher-feedback-summary-kicker">3秒で把握</span>
                    <h3 id="launcher-feedback-summary-heading">いまの学び</h3>
                  </div>
                  <p>確認が必要な件数と、制作に使っているルールを先に示します。</p>
                </header>
                <div aria-label="いまの学びの要点" className="launcher-feedback-summary-metrics" role="group">
                  <button
                    aria-label={`確認を決める ${pendingPromotionCount}件`}
                    className="launcher-feedback-summary-metric"
                    data-emphasis={pendingPromotionCount > 0 ? 'attention' : 'calm'}
                    disabled={pendingPromotionCount === 0}
                    onClick={() => {
                      setFeedbackListMode('focus')
                      setFeedbackFilter('all')
                      if (pendingPromotions[0]) selectFeedbackPreference(pendingPromotions[0].key)
                    }}
                    type="button"
                  >
                    <span>確認を決める</span>
                    <strong>{pendingPromotionCount}件</strong>
                  </button>
                  <button
                    aria-label={`読み取りを確認 ${issueCount}件`}
                    className="launcher-feedback-summary-metric"
                    data-emphasis={issueCount > 0 ? 'attention' : 'calm'}
                    disabled={issueCount === 0}
                    onClick={() => {
                      document.getElementById('launcher-feedback-issues')?.focus()
                    }}
                    type="button"
                  >
                    <span>読み取りを確認</span>
                    <strong>{issueCount}件</strong>
                  </button>
                  <button
                    aria-label={`制作に使っているルール ${activeRuleCount}件`}
                    className="launcher-feedback-summary-metric"
                    data-emphasis="calm"
                    disabled={activeRuleCount === 0}
                    onClick={() => {
                      document.getElementById('launcher-feedback-active-rules')?.focus()
                    }}
                    type="button"
                  >
                    <span>制作に使っているルール</span>
                    <strong>{activeRuleCount}件</strong>
                  </button>
                </div>
                {recentActiveRules.length > 0 && (
                  <section
                    aria-labelledby="launcher-feedback-active-rules-heading"
                    className="launcher-feedback-active-rules"
                    id="launcher-feedback-active-rules"
                    tabIndex={-1}
                  >
                    <header>
                      <h4 id="launcher-feedback-active-rules-heading">最近反映したルール</h4>
                      <p>制作に使っているルールを、最近反映した順に最大{FEEDBACK_ACTIVE_RULES_LIMIT}件示します。</p>
                    </header>
                    <ul>
                      {recentActiveRules.map((preference) => {
                        const promotion = latestPromotion(preference)
                        const promotedAt = latestPromotionAt(preference)
                        return (
                          <li key={preference.key}>
                            <button
                              aria-label={`使用中ルール「${preference.summary}」の詳細を見る`}
                              onClick={() => openFeedbackPreference(preference.key)}
                              type="button"
                            >
                              <strong>{preference.summary}</strong>
                              <span className="launcher-feedback-active-rule-meta">
                                <b data-stage={preference.stage}>
                                  {preference.stage === 'verified' ? '効果確認済み' : '反映済み'}
                                </b>
                                <code>{promotion?.target ?? '反映先未設定'}</code>
                                <time dateTime={promotedAt ?? preference.lastSeenAt}>
                                  {formatUpdatedAt(promotedAt ?? preference.lastSeenAt)}
                                </time>
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                )}
              </section>

              <details
                className="launcher-feedback-setup"
                key={feedback.preferences.length === 0 ? 'setup-empty' : 'setup-ready'}
                {...(feedback.preferences.length === 0 ? { open: true } : {})}
              >
                <summary>自動整理の設定方法</summary>
                <div className="launcher-feedback-setup-body">
                  <ol>
                    <li>
                      <b>1</b>
                      <p>Codexでは「Automationを新規作成」を選び、このTsugiteリポジトリを作業フォルダに設定します。</p>
                    </li>
                    <li>
                      <b>2</b>
                      <p>CodexのAutomationへ、またはClaude Codeの会話で次のように頼みます。</p>
                      <code>Tsugiteのローカル「好み・学び」昇格候補だけをレビューし、人間の承認待ちを準備して</code>
                    </li>
                    <li>
                      <b>3</b>
                      <p>Claude Codeでは <code>/tsugite-learning-review</code> でも実行できます。候補が出たら、この棚で根拠を確認して承認または見送ります。</p>
                    </li>
                  </ol>
                  <p className="launcher-feedback-setup-note">
                    <strong>常設する自動化はCodexかClaudeのどちらか1つだけにします。</strong>
                    {' '}
                    登録用の完全な指示と安全条件は
                    {' '}
                    <code>docs/automations/learning-promotion-review.md</code>
                    {' '}
                    を使ってください。
                  </p>
                </div>
              </details>

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
                          onClick={() => openFeedbackPreference(preference.key)}
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

              <p aria-label="学びの段階" className="launcher-feedback-lifecycle-line">
                記録 → 学習中 → 反映済み → 効果確認済み
              </p>
              <details className="launcher-feedback-lifecycle-details">
                <summary>学びが制作ルールになるまで</summary>
                <div className="launcher-feedback-lifecycle-body">
                  <ol>
                    {FEEDBACK_STAGES.map((stage) => (
                      <li data-stage={stage} key={stage}>
                        <strong>{FEEDBACK_STAGE_LABELS[stage]}</strong>
                        <b>{FEEDBACK_APPLICATION_LABELS[stage]}</b>
                        <p>{FEEDBACK_STAGE_DESCRIPTIONS[stage]}</p>
                      </li>
                    ))}
                  </ol>
                  <p className="launcher-feedback-guide-note">
                    <strong>承認は状態ではありません。</strong>
                    {' '}
                    承認は反映前の確認記録です。制作ルールへの反映と効果確認は別の段階です。
                  </p>
                </div>
              </details>

              {feedback.issues.length > 0 && (
                <section
                  aria-label="読み取り警告"
                  className="launcher-feedback-issues"
                  id="launcher-feedback-issues"
                  role="status"
                  tabIndex={-1}
                >
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

              {feedback.preferences.length > 0 && (
                <div
                  aria-label="履歴の表示切替"
                  className="launcher-feedback-list-mode"
                  role="group"
                >
                  <button
                    aria-pressed={feedbackListMode === 'focus'}
                    onClick={() => {
                      // 明示的な focus 切替は先頭へ。focus 外選択のまま切ると effect が all へ戻す不具合になる。
                      // promotionDecisionState のリセットは selectFeedbackPreference に委譲し、
                      // saving 中に idle へ戻して別項目の承認が再有効になるのを防ぐ。
                      setFeedbackListMode('focus')
                      if (focusFeedback[0]) {
                        selectFeedbackPreference(focusFeedback[0].key)
                        return
                      }
                      setSelectedFeedbackKey(null)
                      if (promotionDecisionState === 'saving') return
                      setPromotionDecisionState('idle')
                      setPromotionDecisionError(null)
                    }}
                    type="button"
                  >
                    いま見る
                    <b>{Math.min(focusFeedback.length, FEEDBACK_FOCUS_SIZE)}件</b>
                  </button>
                  <button
                    aria-label={`すべての記録 ${feedback.preferences.length}件`}
                    aria-pressed={feedbackListMode === 'all'}
                    onClick={() => setFeedbackListMode('all')}
                    type="button"
                  >
                    すべての記録
                    <b>{feedback.preferences.length}件</b>
                  </button>
                </div>
              )}

              {feedbackListMode === 'all' && feedback.preferences.length > 0 && (
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
              )}

              {feedback.preferences.length === 0 ? (
                <div className="launcher-empty launcher-feedback-state">
                  <BookOpen aria-hidden="true" size={24} />
                  <strong>まだ整理された好み・学びはありません。</strong>
                  <p><code>pipeline feedback</code>で記録した<code>feedback.jsonl</code>が蓄積すると、ここに表示されます。</p>
                </div>
              ) : listedFeedback.length === 0 ? (
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
                      const representativePromotion = latestPromotion(preference) ?? preference.promotions[0]
                      const remainingPromotionCount = Math.max(0, preference.promotions.length - 1)
                      return (
                        <button
                          aria-label={`${preference.summary}の詳細を見る`}
                          aria-pressed={preference.key === selectedFeedbackKey}
                          className="launcher-feedback-card"
                          data-stage={preference.stage}
                          key={preference.key}
                          onClick={() => selectFeedbackPreference(preference.key)}
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
                              {feedbackCardProposalLabel(preference)}
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

                        {selectedFeedback.promotionProposal && selectedFeedback.stage === 'recurring' && isTrustedPromotionSource(selectedFeedback) && (
                          <section aria-label="この学びの確認ガイド" className="launcher-feedback-detail-section launcher-feedback-review-guide">
                            <h3>この学びで確認すること</h3>
                            <ol>
                              <li>
                                <strong>何を確認するか</strong>
                                <span>{selectedFeedback.summary}</span>
                              </li>
                              <li>
                                <strong>どこを確認するか</strong>
                                <span>{selectedFeedback.promotionProposal.projectName}の根拠と、下の証拠・run IDを照らし合わせます。</span>
                              </li>
                              <li>
                                <strong>どう確認するか</strong>
                                <span>{selectedFeedback.promotionProposal.verification}</span>
                              </li>
                              <li>
                                <strong>何を決めるか</strong>
                                <span>反映内容「{selectedFeedback.promotionProposal.changeSummary}」が妥当なら承認し、違和感や根拠不足があれば今回は見送ります。</span>
                              </li>
                            </ol>
                          </section>
                        )}

                        {selectedFeedback.promotionProposal && selectedFeedback.stage === 'recurring' && isTrustedPromotionSource(selectedFeedback) && (
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

                        {selectedFeedback.promotionProposal && selectedFeedback.stage === 'recurring' && !isTrustedPromotionSource(selectedFeedback) && (
                          <section className="launcher-feedback-detail-section launcher-feedback-untrusted-proposal" aria-live="polite">
                            <p>この提案はランチャーから承認できません。内容の確認のみ行えます。</p>
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
      <div hidden={activeShelf !== 'projects'}>
        <AgentWorkspaceChooser />
      </div>
    </main>
  )
}
