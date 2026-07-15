import { ArrowRight, Clock3, FolderOpen, RefreshCw, Search } from 'lucide-react'
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
  valid: boolean
  issue?: string
}

interface ProjectListResponse {
  ok: true
  projects: LauncherProject[]
}

interface RefreshResponse {
  ok: true
  viewerUrl: string
  project: LauncherProject
}

interface LauncherAppProps {
  fetcher?: typeof fetch
  navigate?: (url: string) => void
  token?: string
}

const defaultFetcher: typeof fetch = (...args) => window.fetch(...args)

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

function isProjectListResponse(input: unknown): input is ProjectListResponse {
  return typeof input === 'object' && input !== null && 'ok' in input && input.ok === true
    && 'projects' in input && Array.isArray(input.projects)
}

function isRefreshResponse(input: unknown): input is RefreshResponse {
  return typeof input === 'object' && input !== null && 'ok' in input && input.ok === true
    && 'viewerUrl' in input && typeof input.viewerUrl === 'string'
}

export function LauncherApp({
  fetcher = defaultFetcher,
  navigate = (url) => window.location.assign(url),
  token = launcherToken(),
}: LauncherAppProps) {
  const [projects, setProjects] = useState<LauncherProject[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)

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

  useEffect(() => {
    void loadProjects()
  }, [loadAttempt, loadProjects])

  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ja')
    if (!normalized) return projects
    return projects.filter((project) =>
      [project.name, project.slug, project.runId]
        .some((value) => value.toLocaleLowerCase('ja').includes(normalized)),
    )
  }, [projects, query])
  const selected = projects.find((project) => project.id === selectedId) ?? null

  const refreshSelected = async () => {
    if (!selected || !selected.valid || refreshing) return
    setRefreshing(true)
    setRefreshError(null)
    try {
      const response = await fetcher(`/api/projects/${encodeURIComponent(selected.id)}/refresh`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-tsugite-token': token,
        },
        body: '{}',
      })
      const payload: unknown = await response.json()
      if (!response.ok || !isRefreshResponse(payload)) throw new Error('refresh failed')
      navigate(payload.viewerUrl)
    } catch {
      setRefreshError('最新の制作記録を開けませんでした。設定と成果物を確認して、もう一度お試しください。')
    } finally {
      setRefreshing(false)
    }
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
        <p>制作案件を選び、いまの記録をブラウザで確認します。</p>
      </header>

      <ol aria-label="見取図を開く手順" className="launcher-joinery">
        <li data-active="true"><span>一</span><strong>選ぶ</strong></li>
        <li data-active={selected !== null}><span>二</span><strong>最新にする</strong></li>
        <li data-active="false"><span>三</span><strong>見る</strong></li>
      </ol>

      <section className="launcher-workbench">
        <section aria-labelledby="project-list-title" className="launcher-projects">
          <div className="launcher-section-heading">
            <div>
              <span className="eyebrow">制作棚</span>
              <h2 id="project-list-title">制作案件を選ぶ</h2>
            </div>
            <span className="launcher-count">全{projects.length}件 / 表示{filteredProjects.length}件</span>
          </div>

          {projects.length > 0 && (
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
              {filteredProjects.map((project) => (
                <button
                  aria-label={`${project.name}を選ぶ`}
                  aria-pressed={project.id === selectedId}
                  className="launcher-project-card"
                  data-invalid={!project.valid}
                  key={project.id}
                  onClick={() => {
                    setSelectedId(project.id)
                    setRefreshError(null)
                  }}
                  type="button"
                >
                  <span aria-hidden="true" className="launcher-project-notch" />
                  <span className="launcher-project-copy">
                    <span className="launcher-project-status">{project.valid ? statusLabel(project.status) : '設定の確認が必要'}</span>
                    <span className="launcher-project-name" role="heading" aria-level={3}>{project.name}</span>
                    <small>{project.slug}</small>
                  </span>
                  <ArrowRight aria-hidden="true" size={17} />
                </button>
              ))}
            </div>
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
    </main>
  )
}
