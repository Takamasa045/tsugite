import { lazy, Suspense, useEffect, useMemo, useState } from 'react'

import { AppHeader } from '../components/layout/AppHeader'
import { SidePanel } from '../components/layout/SidePanel'
import { TimelinePanel } from '../components/layout/TimelinePanel'
import { workflowSamples } from '../data'
import { useTimelinePlayback } from '../hooks/useTimelinePlayback'
import { useWorkflowStateAtTime } from '../hooks/useWorkflowStateAtTime'
import { calculateNodePositions } from '../lib/layout-engine'
import { validateWorkflowData } from '../lib/workflow-validator'
import { useWorkflowStore, type PlaybackSpeed } from '../store/workflow-store'

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
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
  )
}

export function App({ samples = workflowSamples }: AppProps) {
  const [activeSampleId, setActiveSampleId] = useState(samples[0]?.id ?? '')
  const [resetSignal, setResetSignal] = useState(0)
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

  useEffect(() => {
    if (validation.success) {
      const store = useWorkflowStore.getState()
      store.setWorkflow(validation.data)
      if (activeSample?.initialTime !== undefined) {
        store.setCurrentTime(activeSample.initialTime)
      }
    } else {
      useWorkflowStore.getState().clearWorkflow()
    }
  }, [activeSample?.initialTime, validation])

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
        setResetSignal((signal) => signal + 1)
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

  const selectNode = useWorkflowStore.getState().selectNode
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
        onResetView={() => setResetSignal((signal) => signal + 1)}
        onSampleChange={setActiveSampleId}
        samples={samples.map(({ id, label }) => ({ id, label }))}
        workflow={workflow}
      />

      <section className="scene-viewport" aria-label="3Dビューポート">
        <Suspense fallback={<div className="scene-loading">3D空間を構築しています…</div>}>
          <WorkflowScene
            nodesAtTime={derivedState.nodes}
            onSelect={selectNode}
            positions={layout.positions}
            resetSignal={resetSignal}
            selectedNodeId={selectedNodeId}
            workflow={workflow}
          />
        </Suspense>
        <div className="scene-readout" aria-hidden="true">
          <span>木組み工程図</span>
          <strong>{derivedState.nodes.length} 工程 / {workflow.edges.length} 接続</strong>
        </div>
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
