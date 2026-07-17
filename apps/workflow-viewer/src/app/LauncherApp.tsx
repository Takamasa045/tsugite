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
import { useCallback, useEffect, useMemo, useState } from 'react'

export interface LauncherProject {
  id: string
  name: string
  slug: string
  runId: string
  status: string
  updatedAt?: string
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
type ProjectFilter = 'all' | 'active' | 'waiting' | 'completed' | 'invalid'

const defaultFetcher: typeof fetch = (...args) => window.fetch(...args)
const PROJECT_PAGE_SIZE = 12
const FEEDBACK_PAGE_SIZE = 24
const FEEDBACK_ISSUE_DISPLAY_LIMIT = 5

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

const FEEDBACK_STAGE_LABELS: Record<FeedbackStage, string> = {
  observed: '観測中',
  recurring: '学習中',
  promoted: '反映済み',
  verified: '適用確認済み',
}

const FEEDBACK_STAGE_MARKS: Record<FeedbackStage, string> = {
  observed: '壱',
  recurring: '弐',
  promoted: '参',
  verified: '肆',
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

const FEEDBACK_STAGES = Object.keys(FEEDBACK_STAGE_LABELS) as FeedbackStage[]
const SHELVES: Shelf[] = ['projects', 'templates', 'feedback']

function launcherToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="tsugite-launcher-token"]')?.content ?? ''
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? '状況を確認中'
}

function formatUpdatedAt(value?: string): string {
  if (!value) return '更新記録なし'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '更新記録なし'
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function projectMatchesFilter(project: LauncherProject, filter: ProjectFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'invalid') return !project.valid || !project.refreshable
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

function isProjectListResponse(input: unknown): input is ProjectListResponse {
  return typeof input === 'object' && input !== null && 'ok' in input && input.ok === true
    && 'projects' in input && Array.isArray(input.projects)
}

function isTemplateListResponse(input: unknown): input is TemplateListResponse {
  return typeof input === 'object' && input !== null && 'ok' in input && input.ok === true
    && 'templates' in input && Array.isArray(input.templates)
}

function isFeedbackPromotion(input: unknown): input is FeedbackPromotion {
  return typeof input === 'object' && input !== null
    && 'projectId' in input && typeof input.projectId === 'string'
    && 'projectName' in input && typeof input.projectName === 'string'
    && 'kind' in input && typeof input.kind === 'string' && input.kind in FEEDBACK_PROMOTION_LABELS
    && 'target' in input && typeof input.target === 'string'
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
  const [visibleFeedbackCount, setVisibleFeedbackCount] = useState(FEEDBACK_PAGE_SIZE)

  const loadProjects = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const response = await fetcher('/api/projects', { headers: { accept: 'application/json' } })
      const payload: unknown = await response.json()
      if (!response.ok || !isProjectListResponse(payload)) throw new Error('invalid project list')
      setProjects(payload.projects)
      setSelectedId((current) => {
        if (current && payload.projects.some((project) => project.id === current)) return current
        return payload.projects.find((project) => project.valid)?.id ?? payload.projects[0]?.id ?? null
      })
    } catch {
      setLoadError('制作案件を読み込めませんでした。ランチャーを起動し直すか、もう一度読み込んでください。')
    } finally {
      setLoading(false)
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
      setFeedback(payload.feedback)
      setSelectedFeedbackKey((current) => (
        current && payload.feedback.preferences
          .slice(0, FEEDBACK_PAGE_SIZE)
          .some((preference) => preference.key === current)
          ? current
          : payload.feedback.preferences[0]?.key ?? null
      ))
      setFeedbackLoadState('ready')
    } catch {
      setFeedbackLoadState('error')
    }
  }, [fetcher])

  useEffect(() => {
    void loadProjects()
  }, [loadAttempt, loadProjects])

  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ja')
    return projects
      .filter((project) => projectMatchesFilter(project, projectFilter))
      .filter((project) => !normalized || [project.name, project.slug, project.runId]
        .some((value) => value.toLocaleLowerCase('ja').includes(normalized)))
      .sort((left, right) => (
        projectUpdatedAtMs(right) - projectUpdatedAtMs(left)
        || left.name.localeCompare(right.name, 'ja')
      ))
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

  const selected = projects.find((project) => project.id === selectedId) ?? null
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null
  const selectedFeedback = feedback?.preferences.find((preference) => preference.key === selectedFeedbackKey) ?? null
  const visibleFeedback = feedback?.preferences.slice(0, visibleFeedbackCount) ?? []
  const remainingFeedbackCount = Math.max(0, (feedback?.preferences.length ?? 0) - visibleFeedback.length)
  const projectSummary = useMemo(() => ({
    active: projects.filter((project) => projectMatchesFilter(project, 'active')).length,
    waiting: projects.filter((project) => projectMatchesFilter(project, 'waiting')).length,
    completed: projects.filter((project) => projectMatchesFilter(project, 'completed')).length,
  }), [projects])

  const selectShelf = (shelf: Shelf) => {
    setActiveShelf(shelf)
    if (shelf === 'templates' && templateLoadState === 'idle') void loadTemplates()
    if (shelf === 'feedback') {
      setVisibleFeedbackCount(FEEDBACK_PAGE_SIZE)
      setSelectedFeedbackKey((current) => (
        current && feedback?.preferences.slice(0, FEEDBACK_PAGE_SIZE).some((preference) => preference.key === current)
          ? current
          : feedback?.preferences[0]?.key ?? current
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
    if (!project.valid || !project.refreshable || refreshing) return
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
            <span aria-hidden="true" className="launcher-joinery-mark"><i /><i /></span>
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
              aria-controls="launcher-feedback-panel"
              aria-selected={activeShelf === 'feedback'}
              id="launcher-feedback-tab"
              onClick={() => selectShelf('feedback')}
              onKeyDown={(event) => handleShelfKeyDown(event, 'feedback')}
              role="tab"
              tabIndex={activeShelf === 'feedback' ? 0 : -1}
              type="button"
            >
              <BookOpen aria-hidden="true" size={17} />好み・学び
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
          <section aria-labelledby="project-list-title" className="launcher-projects">
            <div className="launcher-section-heading">
              <div>
                <span className="eyebrow">制作棚</span>
                <h2 id="project-list-title">制作案件を選ぶ</h2>
              </div>
              <span className="launcher-count">全{projects.length}件 / 表示{visibleProjects.length}件</span>
            </div>

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
                  <button
                    aria-busy={openingProjectId === project.id}
                    aria-describedby={!project.valid || !project.refreshable ? `launcher-project-issue-${project.id}` : undefined}
                    aria-label={!project.valid
                      ? `${project.name}の設定を確認`
                      : project.refreshable
                        ? `${project.name}の制作記録を開く`
                        : `${project.name}の更新できない理由を確認`}
                    aria-pressed={project.id === selectedId}
                    className="launcher-project-card"
                    data-invalid={!project.valid}
                    data-unrefreshable={project.valid && !project.refreshable}
                    disabled={refreshing}
                    key={project.id}
                    onClick={() => void openProject(project)}
                    type="button"
                  >
                    <span aria-hidden="true" className="launcher-project-notch" />
                    <span className="launcher-project-thumbnail">
                      {project.thumbnailUrl ? (
                        <img alt="" loading="lazy" src={project.thumbnailUrl} />
                      ) : (
                        <span className="launcher-project-thumbnail-empty">
                          <Clapperboard aria-hidden="true" size={24} />
                          <small>制作記録</small>
                        </span>
                      )}
                      <span className="launcher-project-status">
                        {openingProjectId === project.id
                          ? '開いています…'
                          : !project.valid
                            ? '設定の確認が必要'
                            : project.refreshable
                              ? statusLabel(project.status)
                              : '最新状態に更新できません'}
                      </span>
                    </span>
                    <span className="launcher-project-copy">
                      <span className="launcher-project-name" role="heading" aria-level={3}>{project.name}</span>
                      <small>{project.slug}</small>
                      {(!project.valid || !project.refreshable) && (
                        <span className="launcher-project-card-issue" id={`launcher-project-issue-${project.id}`}>
                          {project.issue ?? (project.valid
                            ? '現在のバックエンドでは更新できません。'
                            : '設定ファイルを読み込めませんでした。')}
                        </span>
                      )}
                      <span className="launcher-project-card-footer">
                        <small>{formatUpdatedAt(project.updatedAt)}</small>
                        <ArrowRight aria-hidden="true" size={17} />
                      </span>
                    </span>
                  </button>
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

          <aside aria-label="選択した制作案件" className="launcher-selection">
            <span className="eyebrow">選択中の木札</span>
            {selected ? (
              <>
                <h2>{selected.name}</h2>
                <dl className="launcher-project-meta">
                  <div><dt>現在の状況</dt><dd>{selected.valid ? statusLabel(selected.status) : '設定の確認が必要'}</dd></div>
                  <div><dt>制作記録</dt><dd>{selected.runId}</dd></div>
                  <div><dt>最終更新</dt><dd><Clock3 aria-hidden="true" size={15} />{formatUpdatedAt(selected.updatedAt)}</dd></div>
                </dl>

                {(!selected.valid || !selected.refreshable) && (
                  <div className="launcher-project-issue" role="status">
                    <strong>{selected.valid ? '最新状態に更新できません' : 'この案件はまだ更新できません'}</strong>
                    <p>{selected.issue ?? (selected.valid
                      ? '現在のバックエンドではこの案件を更新できません。'
                      : '設定ファイルを読み込めませんでした。')}</p>
                    <small>{selected.valid
                      ? '前回の表示がある場合は、更新せずに開けます。'
                      : 'project.yamlと参照ファイルを確認してください。'}</small>
                  </div>
                )}
                {refreshError && <p className="launcher-refresh-error" role="alert">{refreshError}</p>}

                <div className="launcher-actions">
                  <button
                    className="launcher-primary"
                    disabled={!selected.valid || !selected.refreshable || refreshing}
                    onClick={() => void refreshSelected()}
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" className={refreshing ? 'is-spinning' : undefined} size={17} />
                    {refreshing ? '制作の記録を更新しています…' : '最新状態に更新して開く'}
                  </button>
                  {selected.hasViewer && selected.viewerUrl && (
                    <button className="launcher-secondary" disabled={refreshing} onClick={() => navigate(selected.viewerUrl!)} type="button">
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
                    {filteredTemplates.map((template) => (
                      <button
                        aria-label={`${template.name}を選ぶ`}
                        aria-pressed={template.id === selectedTemplateId}
                        className="launcher-template-card"
                        data-category={template.valid ? template.category : '要確認'}
                        data-invalid={!template.valid}
                        data-status={template.status}
                        key={template.id}
                        onClick={() => setSelectedTemplateId(template.id)}
                        type="button"
                      >
                        <span className="launcher-template-card-topline">
                          <span>{template.valid ? TEMPLATE_STATUS_LABELS[template.status] : '設定を確認'}</span>
                          <small>{template.valid ? template.duration : template.id}</small>
                        </span>
                        <span className="launcher-template-card-name" role="heading" aria-level={3}>{template.name}</span>
                        <span className="launcher-template-card-summary">
                          {template.valid ? template.summary : template.issue?.message ?? 'メタデータを読み込めませんでした。'}
                        </span>
                        {template.valid && (
                          <span className="launcher-template-card-tags">
                            <b>{template.category}</b>
                            {template.tags.slice(0, 2).map((tag) => <i key={tag}>{tag}</i>)}
                          </span>
                        )}
                      </button>
                    ))}
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
                    <h2>{selectedTemplate.name}</h2>
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
                  <section className="launcher-template-requirements">
                    <h3>用意するもの</h3>
                    <ul>
                      {selectedTemplate.requiredInputs.map((input) => <li key={input}>{input}</li>)}
                    </ul>
                  </section>
                  <section className="launcher-template-requirements">
                    <h3>音声</h3>
                    <p>{selectedTemplate.audio}</p>
                  </section>
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
                  <h2>好み・学びの育ち方</h2>
                  <p>案件で見つかった傾向が、繰り返し確かめられ、型やルールに育つまでを示します。</p>
                </div>
                <span className="launcher-count">
                  全{feedback.preferences.length}件 / 表示{visibleFeedback.length}件
                </span>
              </header>

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
                          onClick={() => setSelectedFeedbackKey(preference.key)}
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
                            {remainingPromotionCount > 0 && <span>ほか{remainingPromotionCount}件</span>}
                          </span>
                          <span className="launcher-feedback-card-verification">
                            {preference.stage === 'verified' ? '◆ 適用確認済み' : '◇ 適用未確認'}
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
                          <div><dt>適用確認</dt><dd>{selectedFeedback.stage === 'verified' ? '適用確認済み' : '未確認'}</dd></div>
                          <div><dt>最終観測</dt><dd>{formatUpdatedAt(selectedFeedback.lastSeenAt)}</dd></div>
                        </dl>

                        <section className="launcher-feedback-detail-section">
                          <h3>昇格先</h3>
                          {selectedFeedback.promotions.length > 0 ? (
                            <ul className="launcher-feedback-promotions">
                              {selectedFeedback.promotions.map((promotion, index) => (
                                <li key={`${promotion.projectId}-${promotion.kind}-${promotion.target}-${index}`}>
                                  <span>{FEEDBACK_PROMOTION_LABELS[promotion.kind] ?? '反映先'} / {promotion.projectName}</span>
                                  <code>{promotion.target}</code>
                                </li>
                              ))}
                            </ul>
                          ) : <p>まだ昇格先は設定されていません。</p>}
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
                          <strong>閲覧専用</strong>
                          <p>この棚から昇格や設定変更は行いません。根拠と適用確認の状態を確かめる場所です。</p>
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
