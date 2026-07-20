import {
  AlertTriangle,
  FileText,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Minus,
  MousePointer2,
  Music2,
  Plus,
  RotateCcw,
  Sparkles,
  Workflow,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'

type GenerationNodeKind = 'text' | 'image' | 'video' | 'audio' | 'timeline'

export interface GenerationCanvasProject {
  id: string
  name: string
  slug: string
  runId: string
  status: string
  valid: boolean
  refreshable: boolean
}

interface CanvasGenerationRequest {
  id: string
  prompt: string
  model?: string
  operation?: string
  outputKind?: 'video' | 'image' | 'audio'
  duration?: number
  aspect?: string
  inputMode: 'text-to-video' | 'image-to-video'
  hasFirstFrame: boolean
  referenceImageCount: number
}

interface CanvasAudioTrack {
  id: string
  kind: 'music' | 'sound-effect'
  prompt: string
  start: number
  end?: number
}

interface CanvasConnection {
  id: string
  displayName: string
  transport: string
  authKind: string
  capabilities: string[]
  automatedCapabilities: string[]
  routeNote?: string
  modelPolicy?: 'catalog' | 'runtime'
  setupStatus?: 'ready' | 'needs-verification' | 'needs-setup' | 'not-integrated'
  executionMode?: 'pipeline-adapter' | 'agent-handoff'
}

interface CanvasData {
  project: GenerationCanvasProject
  generation: {
    connection?: string
    adapter?: string
    requests: CanvasGenerationRequest[]
  }
  audio?: {
    connection?: string
    adapter?: string
    tracks: CanvasAudioTrack[]
  }
  connections?: CanvasConnection[]
  issues: Array<{ code: string; message: string; path?: string }>
}

interface GenerationNode {
  id: string
  title: string
  kind: GenerationNodeKind
  status: string
  description: string
  x: number
  y: number
  width: number
  height: number
  meta?: string
}

interface GenerationEdge {
  from: string
  to: string
}

interface CanvasGraph {
  nodes: GenerationNode[]
  edges: GenerationEdge[]
}

interface GenerationCanvasProps {
  projects: GenerationCanvasProject[]
  selectedProjectId: string | null
  fetcher?: typeof fetch
  onProjectSelect?: (projectId: string) => void
}

const INITIAL_ZOOM = 0.62
const MIN_ZOOM = 0.42
const MAX_ZOOM = 1.24
const defaultFetcher: typeof fetch = (...args) => window.fetch(...args)

function launcherToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="tsugite-launcher-token"]')?.content ?? ''
}

const KIND_LABELS: Record<GenerationNodeKind, string> = {
  text: 'プロンプト',
  image: '参照画像',
  video: '動画生成',
  audio: '音声生成',
  timeline: 'タイムライン',
}

const KIND_ICONS = {
  text: FileText,
  image: ImageIcon,
  video: Film,
  audio: Music2,
  timeline: Workflow,
}

const STATUS_LABELS: Record<string, string> = {
  planned: '準備中',
  pending: '準備中',
  running: '生成中',
  rendering: '書き出し中',
  awaiting_gate_1: 'Gate 1 確認待ち',
  awaiting_gate_2: 'Gate 2 確認待ち',
  awaiting_gate_3: 'Gate 3 確認待ち',
  completed: '完了',
  error: '要確認',
  aborted: '中止',
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

function edgePath(from: GenerationNode, to: GenerationNode): string {
  const startX = from.x + from.width
  const startY = from.y + from.height / 2
  const endX = to.x
  const endY = to.y + to.height / 2
  const curve = Math.max(80, (endX - startX) * 0.48)
  return `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))))
}

function isCanvasDataResponse(input: unknown): input is { ok: true; canvas: CanvasData } {
  if (typeof input !== 'object' || input === null || !('ok' in input) || input.ok !== true) return false
  if (!('canvas' in input) || typeof input.canvas !== 'object' || input.canvas === null) return false
  return 'project' in input.canvas
    && 'generation' in input.canvas
    && typeof input.canvas.generation === 'object'
    && input.canvas.generation !== null
    && 'requests' in input.canvas.generation
    && Array.isArray(input.canvas.generation.requests)
}

function createGraph(canvas: CanvasData): CanvasGraph {
  const nodes: GenerationNode[] = []
  const edges: GenerationEdge[] = []
  const videoIds: string[] = []

  canvas.generation.requests.forEach((request, index) => {
    const y = 80 + index * 230
    const promptId = `prompt:${request.id}`
    const imageId = `image:${request.id}`
    nodes.push({
      id: promptId,
      title: `${request.id} の指示`,
      kind: 'text',
      status: 'project.yaml',
      description: request.prompt,
      x: 60,
      y,
      width: 250,
      height: 152,
      meta: request.model,
    })
    if (request.inputMode === 'image-to-video') {
      nodes.push({
        id: imageId,
        title: `${request.id} の基準画像`,
        kind: 'image',
        status: request.hasFirstFrame ? '先頭フレーム' : `参照 ${request.referenceImageCount}枚`,
        description: '案件内で指定された参照画像です。ローカルパスはキャンバスへ公開しません。',
        x: 390,
        y: y + 4,
        width: 230,
        height: 146,
      })
      edges.push({ from: promptId, to: imageId }, { from: imageId, to: request.id })
    } else {
      edges.push({ from: promptId, to: request.id })
    }
    const outputKind = request.outputKind ?? 'video'
    nodes.push({
      id: request.id,
      title: request.id,
      kind: outputKind,
      status: [request.operation, request.duration ? `${request.duration}秒` : undefined, request.aspect].filter(Boolean).join(' · '),
      description: request.prompt,
      x: 700,
      y: y - 16,
      width: 246,
      height: 184,
      meta: request.model,
    })
    videoIds.push(request.id)
  })

  const audioIds: string[] = []
  canvas.audio?.tracks.forEach((track, index) => {
    const id = `audio:${track.id}`
    nodes.push({
      id,
      title: track.id,
      kind: 'audio',
      status: track.kind === 'music' ? '音楽' : '効果音',
      description: track.prompt,
      x: 700,
      y: 80 + (canvas.generation.requests.length + index) * 190,
      width: 246,
      height: 142,
      meta: `${track.start}秒から`,
    })
    audioIds.push(id)
  })

  if (videoIds.length + audioIds.length > 0) {
    const timelineId = 'timeline:project'
    nodes.push({
      id: timelineId,
      title: '案件タイムライン',
      kind: 'timeline',
      status: canvas.project.runId,
      description: '生成した動画と音声を、この案件の編集・QA工程へ引き渡します。',
      x: 1050,
      y: Math.max(180, (videoIds.length + audioIds.length) * 92),
      width: 310,
      height: 160,
    })
    for (const id of [...videoIds, ...audioIds]) edges.push({ from: id, to: timelineId })
  }

  return { nodes, edges }
}

function layoutStorageKey(project: GenerationCanvasProject): string {
  return `tsugite-generation-canvas:${project.slug}:${project.runId}`
}

function loadLayout(project: GenerationCanvasProject): Record<string, { x: number; y: number }> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(layoutStorageKey(project)) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, position]) => (
      typeof position === 'object' && position !== null
      && 'x' in position && Number.isFinite(position.x)
      && 'y' in position && Number.isFinite(position.y)
    ))) as Record<string, { x: number; y: number }>
  } catch {
    return {}
  }
}

function applyLayout(nodes: GenerationNode[], project: GenerationCanvasProject): GenerationNode[] {
  const layout = loadLayout(project)
  return nodes.map((node) => layout[node.id] ? { ...node, ...layout[node.id] } : node)
}

function capabilityFamilies(capabilities: string[]): string[] {
  const families = new Set(capabilities.map((capability) => capability.split('.')[0]))
  return ['image', 'video', 'audio']
    .filter((family) => families.has(family))
    .map((family) => ({ image: '画像', video: '動画', audio: '音声' })[family]!)
}

export function GenerationCanvas({
  projects,
  selectedProjectId,
  fetcher = defaultFetcher,
  onProjectSelect,
}: GenerationCanvasProps) {
  const fallbackProjectId = selectedProjectId && projects.some((project) => project.id === selectedProjectId)
    ? selectedProjectId
    : projects[0]?.id ?? ''
  const [projectId, setProjectId] = useState(fallbackProjectId)
  const [canvas, setCanvas] = useState<CanvasData | null>(null)
  const [nodes, setNodes] = useState<GenerationNode[]>([])
  const [edges, setEdges] = useState<GenerationEdge[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [comparisonConnectionId, setComparisonConnectionId] = useState('')
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [actionState, setActionState] = useState<'idle' | 'saving' | 'generating' | 'success' | 'error'>('idle')
  const [actionMessage, setActionMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [zoom, setZoom] = useState(INITIAL_ZOOM)
  const [offset, setOffset] = useState({ x: 24, y: 30 })
  const nodesRef = useRef(nodes)
  const panDrag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null)
  const nodeDrag = useRef<{ pointerId: number; id: string; x: number; y: number; originX: number; originY: number } | null>(null)

  useEffect(() => {
    if (selectedProjectId && projects.some((project) => project.id === selectedProjectId)) {
      setProjectId(selectedProjectId)
    }
  }, [projects, selectedProjectId])

  useEffect(() => {
    if (!projectId) {
      setCanvas(null)
      setNodes([])
      setEdges([])
      setLoadState('ready')
      return
    }
    let active = true
    setLoadState('loading')
    void fetcher(`/api/projects/${encodeURIComponent(projectId)}/generation-canvas`, {
      headers: { accept: 'application/json' },
    }).then(async (response) => {
      const payload: unknown = await response.json()
      if (!response.ok || !isCanvasDataResponse(payload)) throw new Error('invalid canvas response')
      if (!active) return
      const graph = createGraph(payload.canvas)
      const positionedNodes = applyLayout(graph.nodes, payload.canvas.project)
      nodesRef.current = positionedNodes
      setCanvas(payload.canvas)
      setComparisonConnectionId(payload.canvas.generation.connection ?? payload.canvas.connections?.[0]?.id ?? '')
      setNodes(positionedNodes)
      setEdges(graph.edges)
      setSelectedId(payload.canvas.generation.requests[0]?.id ?? positionedNodes[0]?.id ?? '')
      setLoadState('ready')
    }).catch(() => {
      if (active) setLoadState('error')
    })
    return () => { active = false }
  }, [fetcher, projectId, reloadKey])

  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const selected = nodesById.get(selectedId) ?? nodes[0]
  const connectionCount = selected
    ? edges.filter((edge) => edge.from === selected.id || edge.to === selected.id).length
    : 0
  const activeConnectionId = selected?.kind === 'audio'
    ? canvas?.audio?.connection
    : canvas?.generation.connection ?? canvas?.audio?.connection
  const activeConnection = canvas?.connections?.find((connection) => connection.id === activeConnectionId)
  const comparisonConnection = canvas?.connections?.find((connection) => connection.id === comparisonConnectionId)

  const persistLayout = useCallback((nextNodes: GenerationNode[]) => {
    if (!canvas) return
    const layout = Object.fromEntries(nextNodes.map((node) => [node.id, { x: node.x, y: node.y }]))
    window.localStorage.setItem(layoutStorageKey(canvas.project), JSON.stringify(layout))
  }, [canvas])

  const resetView = () => {
    setZoom(INITIAL_ZOOM)
    setOffset({ x: 24, y: 30 })
  }

  const resetNodeLayout = () => {
    if (!canvas) return
    window.localStorage.removeItem(layoutStorageKey(canvas.project))
    const graph = createGraph(canvas)
    nodesRef.current = graph.nodes
    setNodes(graph.nodes)
    setEdges(graph.edges)
  }

  const handleViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId)
    panDrag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: offset.x,
      originY: offset.y,
    }
  }

  const handleViewportPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panDrag.current || panDrag.current.pointerId !== event.pointerId) return
    setOffset({
      x: panDrag.current.originX + event.clientX - panDrag.current.x,
      y: panDrag.current.originY + event.clientY - panDrag.current.y,
    })
  }

  const stopViewportDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panDrag.current?.pointerId === event.pointerId) panDrag.current = null
  }

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, node: GenerationNode) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setSelectedId(node.id)
    nodeDrag.current = {
      pointerId: event.pointerId,
      id: node.id,
      x: event.clientX,
      y: event.clientY,
      originX: node.x,
      originY: node.y,
    }
  }

  const handleNodePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const dragging = nodeDrag.current
    if (!dragging || dragging.pointerId !== event.pointerId) return
    const nextNodes = nodesRef.current.map((node) => node.id === dragging.id
      ? {
          ...node,
          x: Math.round(dragging.originX + (event.clientX - dragging.x) / zoom),
          y: Math.round(dragging.originY + (event.clientY - dragging.y) / zoom),
        }
      : node)
    nodesRef.current = nextNodes
    setNodes(nextNodes)
  }

  const stopNodeDragging = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (nodeDrag.current?.pointerId !== event.pointerId) return
    nodeDrag.current = null
    persistLayout(nodesRef.current)
  }

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    setZoom((current) => clampZoom(current + (event.deltaY < 0 ? 0.08 : -0.08)))
  }

  const chooseProject = (nextProjectId: string) => {
    setProjectId(nextProjectId)
    onProjectSelect?.(nextProjectId)
  }

  const selectGenerationConnection = async () => {
    if (!canvas || !comparisonConnection || comparisonConnection.id === canvas.generation.connection) return
    setActionState('saving')
    setActionMessage('')
    try {
      const response = await fetcher(`/api/projects/${encodeURIComponent(canvas.project.id)}/generation-connection`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-tsugite-token': launcherToken(),
        },
        body: JSON.stringify({ connection: comparisonConnection.id }),
      })
      const payload = await response.json() as { ok?: boolean; issue?: { message?: string } }
      if (!response.ok || payload.ok !== true) throw new Error(payload.issue?.message ?? '接続を変更できませんでした')
      setActionState('success')
      setActionMessage(`${comparisonConnection.displayName}を案件へ設定しました。Gate 1 reviewを更新してください。`)
      setReloadKey((current) => current + 1)
    } catch (error) {
      setActionState('error')
      setActionMessage(error instanceof Error ? error.message : '接続を変更できませんでした')
    }
  }

  const generateProject = async () => {
    if (!canvas || !activeConnection) return
    if (!window.confirm(`${activeConnection.displayName}で外部生成を開始します。契約クレジットが消費されます。続行しますか？`)) return
    setActionState('generating')
    setActionMessage('生成を開始しました。完了までこの画面を開いたままお待ちください。')
    try {
      const response = await fetcher(`/api/projects/${encodeURIComponent(canvas.project.id)}/generate`, {
        method: 'POST',
        headers: { accept: 'application/json', 'x-tsugite-token': launcherToken() },
      })
      const payload = await response.json() as { ok?: boolean; issue?: { message?: string } }
      if (!response.ok || payload.ok !== true) throw new Error(payload.issue?.message ?? '生成を完了できませんでした')
      setActionState('success')
      setActionMessage('生成物を案件へ取り込み、Gate 2確認待ちへ進みました。')
      setReloadKey((current) => current + 1)
    } catch (error) {
      setActionState('error')
      setActionMessage(error instanceof Error ? error.message : '生成を完了できませんでした')
    }
  }

  return (
    <section
      aria-label="画像・動画の生成キャンバス"
      className="generation-canvas-shell"
      id="launcher-canvas-panel"
      role="tabpanel"
      aria-labelledby="launcher-canvas-tab"
    >
      <header className="generation-canvas-header">
        <div>
          <span className="eyebrow">GENERATION CANVAS / 生成の作業台</span>
          <h2>プロンプトから完成動画までをつなぐ</h2>
          <p>選択した案件の project.yaml を正本として、画像・動画・音声の工程を表示します。</p>
        </div>
        <label className="generation-canvas-project-picker">
          <span>制作案件</span>
          <select
            aria-label="キャンバスの制作案件"
            disabled={projects.length === 0}
            onChange={(event) => chooseProject(event.target.value)}
            value={projectId}
          >
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.runId}</option>)}
          </select>
          <small>ノード配置は案件別に、この端末へ保存</small>
        </label>
      </header>

      <div className="generation-canvas-workbench">
        <div className="generation-canvas-main">
          <div aria-label="キャンバス操作" className="generation-canvas-toolbar">
            <button aria-label="縮小" onClick={() => setZoom((current) => clampZoom(current - 0.1))} type="button"><Minus aria-hidden="true" size={16} /></button>
            <output aria-label="キャンバス倍率" role="status">{Math.round(zoom * 100)}%</output>
            <button aria-label="拡大" onClick={() => setZoom((current) => clampZoom(current + 0.1))} type="button"><Plus aria-hidden="true" size={16} /></button>
            <span className="generation-canvas-toolbar-divider" />
            <button aria-label="表示をリセット" onClick={resetView} type="button"><RotateCcw aria-hidden="true" size={15} />表示</button>
            <button onClick={resetNodeLayout} type="button"><Workflow aria-hidden="true" size={15} />配置初期化</button>
          </div>

          <div
            aria-label="キャンバス作業領域"
            className="generation-canvas-viewport"
            onPointerCancel={stopViewportDragging}
            onPointerDown={handleViewportPointerDown}
            onPointerMove={handleViewportPointerMove}
            onPointerUp={stopViewportDragging}
            onWheel={handleWheel}
          >
            {loadState === 'loading' && <div className="generation-canvas-state"><LoaderCircle aria-hidden="true" className="is-spinning" /><strong>案件の生成工程を読み込み中…</strong></div>}
            {loadState === 'error' && <div className="generation-canvas-state is-error" role="alert"><AlertTriangle aria-hidden="true" /><strong>生成工程を読み込めませんでした</strong></div>}
            {loadState === 'ready' && nodes.length === 0 && <div className="generation-canvas-state"><Workflow aria-hidden="true" /><strong>この案件には生成要求がありません</strong><span>project.yaml に生成要求を追加すると、ここへ工程が現れます。</span></div>}
            <div className="generation-canvas-stage" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}>
              <svg aria-hidden="true" className="generation-canvas-edges" height="1200" viewBox="0 0 1660 1200" width="1660">
                {edges.map((edge) => {
                  const from = nodesById.get(edge.from)
                  const to = nodesById.get(edge.to)
                  if (!from || !to) return null
                  const active = edge.from === selected?.id || edge.to === selected?.id
                  return <path className={active ? 'is-active' : undefined} d={edgePath(from, to)} key={`${edge.from}-${edge.to}`} />
                })}
              </svg>

              {nodes.map((node, index) => {
                const Icon = KIND_ICONS[node.kind]
                return (
                  <button
                    aria-label={node.title}
                    aria-pressed={node.id === selected?.id}
                    className="generation-node"
                    data-kind={node.kind}
                    key={node.id}
                    onClick={() => setSelectedId(node.id)}
                    onPointerCancel={stopNodeDragging}
                    onPointerDown={(event) => handleNodePointerDown(event, node)}
                    onPointerMove={handleNodePointerMove}
                    onPointerUp={stopNodeDragging}
                    style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}
                    type="button"
                  >
                    <span className="generation-node-heading"><span><Icon aria-hidden="true" size={15} />{KIND_LABELS[node.kind]} {index + 1}</span><i aria-hidden="true" /></span>
                    {node.kind === 'video' && <span aria-hidden="true" className="generation-node-media" data-visual="arrival"><i /></span>}
                    {node.kind === 'image' && <span aria-hidden="true" className="generation-node-media" data-visual="workshop-dusk"><i /></span>}
                    {(node.kind === 'text' || node.kind === 'audio') && <span className="generation-node-prompt">{node.description}</span>}
                    {node.kind === 'timeline' && <span aria-hidden="true" className="generation-node-timeline"><i /><i /><i /><i /><i /><i /></span>}
                    <span className="generation-node-footer"><strong>{node.title}</strong><small>{node.status}</small></span>
                    <span aria-hidden="true" className="generation-node-port is-input" />
                    <span aria-hidden="true" className="generation-node-port is-output" />
                  </button>
                )
              })}
            </div>
            <span className="generation-canvas-pan-hint"><MousePointer2 aria-hidden="true" size={14} />ノードをドラッグして配置・余白をドラッグして移動</span>
          </div>
        </div>

        <aside aria-label="選択した生成工程" className="generation-canvas-inspector">
          <span className="eyebrow">PROJECT CONNECTION / 案件と接続</span>
          {canvas && (
            <div className="generation-canvas-project-status">
              <strong>{canvas.project.name}</strong>
              <span>{statusLabel(canvas.project.status)}</span>
            </div>
          )}
          {activeConnection ? (
            <div className="generation-canvas-capabilities">
              <strong>{activeConnection.displayName}</strong>
              <span>{activeConnection.authKind === 'subscription' ? 'サブスク接続' : activeConnection.authKind} · {activeConnection.transport.toUpperCase()}</span>
              <dl>
                <div><dt>サービス対応</dt><dd>{capabilityFamilies(activeConnection.capabilities).join('・')}</dd></div>
                <div><dt>Tsugite自動化済み</dt><dd>{capabilityFamilies(activeConnection.automatedCapabilities).join('・') || '未接続'}</dd></div>
              </dl>
            </div>
          ) : (
            <div className="generation-canvas-connection-note"><Workflow aria-hidden="true" size={17} /><span><strong>生成サービスが未選択です</strong>project.yaml に connection を指定すると、この案件との接続状態を表示します。</span></div>
          )}

          {(canvas?.connections?.length ?? 0) > 0 && (
            <div className="generation-canvas-route-guide">
              <label>
                <span>生成に使う接続を選択</span>
                <select
                  aria-label="生成に使う接続を選択"
                  onChange={(event) => setComparisonConnectionId(event.target.value)}
                  value={comparisonConnectionId}
                >
                  {canvas!.connections!.map((connection) => (
                    <option key={connection.id} value={connection.id}>{connection.displayName} · {connection.transport.toUpperCase()}</option>
                  ))}
                </select>
              </label>
              {comparisonConnection && (
                <div>
                  <strong>{comparisonConnection.displayName}</strong>
                  <p>{comparisonConnection.routeNote}</p>
                  <small>{comparisonConnection.modelPolicy === 'runtime'
                    ? `モデル一覧は${comparisonConnection.transport.toUpperCase()}から取得`
                    : '登録済みモデルを使用'}</small>
                  <small>状態: {comparisonConnection.setupStatus ?? '確認待ち'} · {comparisonConnection.executionMode === 'pipeline-adapter' ? 'Tsugiteから実行可能' : 'agent handoff'}</small>
                  <code>project.yaml の connection は {comparisonConnection.id}</code>
                  <button
                    className="generation-canvas-select-connection"
                    disabled={
                      comparisonConnection.id === canvas!.generation.connection
                      || actionState === 'saving'
                      || !['planned', 'dry_run', 'awaiting_gate_1'].includes(canvas!.project.status)
                    }
                    onClick={() => void selectGenerationConnection()}
                    type="button"
                  >
                    {comparisonConnection.id === canvas!.generation.connection ? 'この案件で選択中' : 'この接続を案件に設定'}
                  </button>
                </div>
              )}
            </div>
          )}

          {selected ? (
            <>
              <span className="eyebrow">SELECTED NODE / 選択中</span>
              <div className="generation-canvas-inspector-heading">
                {(() => { const Icon = KIND_ICONS[selected.kind]; return <Icon aria-hidden="true" size={19} /> })()}
                <div><h3>{selected.title}</h3><span>{KIND_LABELS[selected.kind]} · {selected.status}</span></div>
              </div>
              <p>{selected.description}</p>
              <dl>
                <div><dt>工程の種類</dt><dd>{KIND_LABELS[selected.kind]}</dd></div>
                <div><dt>接続線</dt><dd>{connectionCount}本</dd></div>
                <div><dt>モデル</dt><dd>{selected.meta ?? '案件設定に従う'}</dd></div>
              </dl>
            </>
          ) : <p className="generation-canvas-inspector-empty">表示する生成工程を選んでください。</p>}
          {canvas?.issues[0] && <div className="generation-canvas-issue"><AlertTriangle aria-hidden="true" size={16} /><span><strong>案件設定を確認</strong>{canvas.issues[0].message}</span></div>}
          {actionMessage && <p aria-live="polite" className={`generation-canvas-action-message is-${actionState}`}>{actionMessage}</p>}
          <button
            className="generation-canvas-generate"
            disabled={
              canvas?.project.status !== 'running'
              || activeConnection?.executionMode !== 'pipeline-adapter'
              || activeConnection?.setupStatus === 'needs-setup'
              || actionState === 'generating'
            }
            onClick={() => void generateProject()}
            type="button"
          ><Sparkles aria-hidden="true" size={16} />{actionState === 'generating' ? '生成中…' : 'Gate 1承認済みの設定で生成'}</button>
        </aside>
      </div>
    </section>
  )
}
