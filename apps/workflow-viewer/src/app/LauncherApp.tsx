import {
  ArrowRight,
  Clapperboard,
  Clock3,
  FolderOpen,
  LayoutTemplate,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react'
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

type Shelf = 'projects' | 'templates'
type TemplateLoadState = 'idle' | 'loading' | 'ready' | 'error'
type ProjectFilter = 'all' | 'active' | 'waiting' | 'completed' | 'invalid'

const defaultFetcher: typeof fetch = (...args) => window.fetch(...args)
const PROJECT_PAGE_SIZE = 12

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
  if (filter === 'invalid') return !project.valid
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

  const selectShelf = (shelf: Shelf) => {
    setActiveShelf(shelf)
    if (shelf === 'templates' && templateLoadState === 'idle') void loadTemplates()
  }

  const openProject = async (project: LauncherProject) => {
    setSelectedId(project.id)
    setRefreshError(null)
    if (!project.valid || refreshing) return
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
      <header className="launcher-header">
        <div className="launcher-brand">
          <span aria-hidden="true" className="brand-mark">継</span>
          <div>
            <span className="product-name">TSUGITE / 制作の見取図</span>
            <h1>制作の見取図を開く</h1>
          </div>
        </div>
        <p>制作案件の現在地を確認し、作りたい動画に合う型をテンプレート棚から探せます。</p>
      </header>

      <nav aria-label="表示する棚" className="launcher-shelf-tabs" role="tablist">
        <button
          aria-selected={activeShelf === 'projects'}
          onClick={() => selectShelf('projects')}
          role="tab"
          type="button"
        >
          <FolderOpen aria-hidden="true" size={17} />制作案件
        </button>
        <button
          aria-selected={activeShelf === 'templates'}
          onClick={() => selectShelf('templates')}
          role="tab"
          type="button"
        >
          <LayoutTemplate aria-hidden="true" size={17} />テンプレート
        </button>
      </nav>

      <ol aria-label="見取図を開く手順" className="launcher-joinery">
        {activeShelf === 'projects' ? (
          <>
            <li data-active="true"><span>一</span><strong>選ぶ</strong></li>
            <li data-active={selected !== null}><span>二</span><strong>最新にする</strong></li>
            <li data-active="false"><span>三</span><strong>見る</strong></li>
          </>
        ) : (
          <>
            <li data-active="true"><span>一</span><strong>見つける</strong></li>
            <li data-active={selectedTemplate !== null}><span>二</span><strong>比べる</strong></li>
            <li data-active={selectedTemplate?.valid === true}><span>三</span><strong>必要素材を見る</strong></li>
          </>
        )}
      </ol>

      {activeShelf === 'projects' ? (
        <section className="launcher-workbench">
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
                    aria-label={project.valid ? `${project.name}の制作記録を開く` : `${project.name}の設定を確認`}
                    aria-pressed={project.id === selectedId}
                    className="launcher-project-card"
                    data-invalid={!project.valid}
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
                          : project.valid ? statusLabel(project.status) : '設定の確認が必要'}
                      </span>
                    </span>
                    <span className="launcher-project-copy">
                      <span className="launcher-project-name" role="heading" aria-level={3}>{project.name}</span>
                      <small>{project.slug}</small>
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

                {!selected.valid && (
                  <div className="launcher-project-issue" role="status">
                    <strong>この案件はまだ更新できません</strong>
                    <p>{selected.issue ?? '設定ファイルを読み込めませんでした。'}</p>
                    <small>project.yamlと参照ファイルを確認してください。</small>
                  </div>
                )}
                {refreshError && <p className="launcher-refresh-error" role="alert">{refreshError}</p>}

                <div className="launcher-actions">
                  <button
                    className="launcher-primary"
                    disabled={!selected.valid || refreshing}
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
      ) : (
        <section className="launcher-workbench">
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
      )}
    </main>
  )
}
