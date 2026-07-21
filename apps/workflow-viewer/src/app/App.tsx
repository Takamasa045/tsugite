import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'

import { AppHeader } from '../components/layout/AppHeader'
import { SidePanel } from '../components/layout/SidePanel'
import { TimelinePanel } from '../components/layout/TimelinePanel'
import { workflowSamples } from '../data'
import { useTimelinePlayback } from '../hooks/useTimelinePlayback'
import { useWorkflowStateAtTime } from '../hooks/useWorkflowStateAtTime'
import { calculateNodePositions } from '../lib/layout-engine'
import { validateWorkflowData } from '../lib/workflow-validator'
import { getFocusCopy, getFocusNode } from '../lib/workflow-presentation'
import { useWorkflowStore, type PlaybackSpeed } from '../store/workflow-store'
import type { FocusRequest } from '../components/scene/CameraController'

const WorkflowScene = lazy(() =>
  import('../components/scene').then((module) => ({ default: module.WorkflowScene })),
)

export interface ViewerSample {
  id: string
  label: string
  data: unknown
  initialTime?: number
}

export interface AppProps {
  samples?: ViewerSample[]
  launcherHref?: string
  initialNodeId?: string
}

function currentLauncherHref(): string | undefined {
  if (!/^\/viewer\/[^/]+\/?$/.test(window.location.pathname)) return undefined

  const launcherHints = new URLSearchParams(window.location.search).getAll('launcher')
  if (launcherHints.length !== 1) return undefined

  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(launcherHints[0])
  if (!match || match[0] !== launcherHints[0]) return undefined

  const port = Number(match[1])
  return port <= 65_535 ? `http://127.0.0.1:${port}/` : undefined
}

export function nodeIdFromSearch(search: string): string | undefined {
  const nodeHints = new URLSearchParams(search).getAll('node')
  if (nodeHints.length !== 1 || nodeHints[0].length === 0) return undefined
  return nodeHints[0]
}

function currentNodeId(): string | undefined {
  return nodeIdFromSearch(window.location.search)
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
  )
}

export function App({
  samples = workflowSamples,
  launcherHref = currentLauncherHref(),
  initialNodeId = currentNodeId(),
}: AppProps) {
  const [activeSampleId, setActiveSampleId] = useState(samples[0]?.id ?? '')
  const [resetSignal, setResetSignal] = useState(0)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const focusNonce = useRef(0)
  const workflow = useWorkflowStore((state) => state.workflow)
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId)
  const currentTime = useWorkflowStore((state) => state.currentTime)
  const isPlaying = useWorkflowStore((state) => state.isPlaying)
  const playbackSpeed = useWorkflowStore((state) => state.playbackSpeed)
  const activeSample = samples.find((sample) => sample.id === activeSampleId) ?? samples[0]
  const validation = useMemo(
    () => validateWorkflowData(activeSample?.data),
    [activeSample],
  )

  useTimelinePlayback()

  const resetView = () => {
    useWorkflowStore.getState().selectNode(null)
    setFocusRequest(null)
    setResetSignal((signal) => signal + 1)
  }

  useEffect(() => {
    if (validation.success) {
      const store = useWorkflowStore.getState()
      store.setWorkflow(validation.data)
      setFocusRequest(null)
      if (activeSample?.initialTime !== undefined) {
        store.setCurrentTime(activeSample.initialTime)
      }

      if (initialNodeId && validation.data.nodes.some((node) => node.id === initialNodeId)) {
        store.selectNode(initialNodeId)
        focusNonce.current += 1
        setFocusRequest({ nodeId: initialNodeId, nonce: focusNonce.current })
      }
    } else {
      useWorkflowStore.getState().clearWorkflow()
    }
  }, [activeSample?.initialTime, initialNodeId, validation])

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      const state = useWorkflowStore.getState()

      if (event.code === 'Space') {
        event.preventDefault()
        if (!state.isPlaying && state.currentTime >= state.duration) state.setCurrentTime(0)
        state.togglePlaying()
      } else if (event.key === 'Escape') {
        state.selectNode(null)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        state.setCurrentTime(state.currentTime - 5)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        state.setCurrentTime(state.currentTime + 5)
      } else if (event.key.toLowerCase() === 'r') {
        resetView()
      }
    }

    window.addEventListener('keydown', handleKeyboard)
    return () => window.removeEventListener('keydown', handleKeyboard)
  }, [])

  const derivedState = useWorkflowStateAtTime(workflow, currentTime)
  const layout = useMemo(
    () => (workflow ? calculateNodePositions(workflow) : null),
    [workflow],
  )

  if (!validation.success) {
    return (
      <main className="load-error" role="alert">
        <span className="eyebrow">WORKFLOW VALIDATION</span>
        <h1>ワークフローを読み込めません</h1>
        <p>JSONの内容を修正してから、もう一度読み込んでください。</p>
        <ul>
          {validation.errors.map((error, index) => (
            <li key={`${error.code}-${error.path ?? 'root'}-${index}`}>
              <code>{error.path ?? '$'}</code> — {error.message}
            </li>
          ))}
        </ul>
      </main>
    )
  }

  if (!workflow || !derivedState || !layout) {
    return <main className="loading-state" aria-live="polite">制作管制卓を起動しています…</main>
  }

  const selectNode = (nodeId: string | null) => {
    useWorkflowStore.getState().selectNode(nodeId)
    if (!nodeId) return
    focusNonce.current += 1
    setFocusRequest({ nodeId, nonce: focusNonce.current })
  }
  const focusNode = getFocusNode(derivedState.nodes)
  const focusCopy = getFocusCopy(focusNode)
  const focusIndex = focusNode
    ? derivedState.nodes.findIndex((node) => node.id === focusNode.id) + 1
    : 0
  const focusProgress = derivedState.nodes.length > 0
    ? (focusIndex / derivedState.nodes.length) * 100
    : 0
  const handlePlaying = (playing: boolean) => {
    const state = useWorkflowStore.getState()
    if (playing && state.currentTime >= state.duration) state.setCurrentTime(0)
    state.setPlaying(playing)
  }

  return (
    <main className="app-shell">
      <AppHeader
        activeSampleId={activeSample?.id ?? ''}
        currentNodes={derivedState.nodes}
        launcherHref={launcherHref}
        onResetView={resetView}
        onSampleChange={setActiveSampleId}
        samples={samples.map(({ id, label }) => ({ id, label }))}
        workflow={workflow}
      />

      <section className="scene-viewport" aria-label="木組みの3D制作工程">
        <Suspense fallback={<div className="scene-loading">3D空間を構築しています…</div>}>
          <WorkflowScene
            currentTime={currentTime}
            focusRequest={focusRequest}
            focusNodeId={focusNode?.id}
            nodesAtTime={derivedState.nodes}
            onSelect={selectNode}
            positions={layout.positions}
            resetSignal={resetSignal}
            selectedNodeId={selectedNodeId}
            workflow={workflow}
          />
        </Suspense>
        <section aria-label="制作の現在地" className="scene-focus-card">
          <div className="scene-focus-heading">
            <span className="scene-focus-kicker">制作の現在地</span>
            <span className="scene-focus-index">工程 {focusIndex} / {derivedState.nodes.length}</span>
          </div>
          <span aria-hidden="true" className="scene-focus-progress">
            <i style={{ width: `${focusProgress}%` }} />
          </span>
          <h2 id="scene-focus-title">{focusCopy.label}</h2>
          <strong>{focusNode?.name ?? '工程なし'}</strong>
          <p>{focusCopy.note}</p>
          <small>工程を選択してズーム · ホイールでカーソル位置へ寄る</small>
        </section>
        {layout.warnings.length > 0 && (
          <p className="scene-warning" role="status">{layout.warnings.join(' · ')}</p>
        )}
      </section>

      <SidePanel
        currentNodes={derivedState.nodes}
        onSelectNode={selectNode}
        selectedNodeId={selectedNodeId}
        workflow={workflow}
      />

      <TimelinePanel
        currentTime={currentTime}
        currentNodes={derivedState.nodes}
        isPlaying={isPlaying}
        onReset={useWorkflowStore.getState().resetPlayback}
        onSeek={useWorkflowStore.getState().setCurrentTime}
        onSpeedChange={(speed) =>
          useWorkflowStore.getState().setPlaybackSpeed(speed as PlaybackSpeed)
        }
        onSelectNode={selectNode}
        onTogglePlaying={handlePlaying}
        playbackSpeed={playbackSpeed}
        selectedNodeId={selectedNodeId}
        workflow={workflow}
      />
    </main>
  )
}
