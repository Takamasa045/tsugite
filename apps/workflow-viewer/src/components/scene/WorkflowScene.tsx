import { Canvas, useFrame } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { WorkflowData, WorkflowNode } from '../../types/workflow'
import { CameraController } from './CameraController'
import type { FocusRequest } from './CameraController'
import { SceneEnvironment } from './SceneEnvironment'
import { WorkflowEdge3D } from './WorkflowEdge3D'
import { WorkflowNode3D } from './WorkflowNode3D'
import { SceneErrorBoundary } from './SceneErrorBoundary'
import { WorkflowFallback } from './WorkflowFallback'
import type { NodePositions } from './scene-utils'
import {
  createPresentationPositions,
  getPosition,
  getSceneBounds,
  getSceneFitDistance,
} from './scene-utils'
import {
  reasonForSceneError,
  type SceneFailurePhase,
  type ScenePresentationStateV1,
  type SceneTestInjection,
} from './scene-state'

type ScenePhase = SceneFailurePhase | 'degraded'

export interface WorkflowSceneProps {
  currentTime: number
  focusRequest?: FocusRequest | null
  focusNodeId?: string
  nodesAtTime?: readonly WorkflowNode[]
  onSelect: (nodeId: string | null) => void
  positions: NodePositions
  resetSignal?: unknown
  selectedNodeId: string | null
  workflow: WorkflowData
}

function useReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updatePreference = () => setReducedMotion(query.matches)
    updatePreference()
    query.addEventListener('change', updatePreference)
    return () => query.removeEventListener('change', updatePreference)
  }, [])

  return reducedMotion
}

interface SceneContentProps extends WorkflowSceneProps {
  onFirstFrame: () => void
  reducedMotion: boolean
  testInjection?: SceneTestInjection
}

function SceneFailureInjection({ mode }: { mode?: SceneTestInjection }) {
  if (mode === 'initialization-throw') {
    throw new Error('scene initialization failure')
  }
  return null
}

function FirstFrameSignal({ onFirstFrame, testInjection }: Pick<SceneContentProps, 'onFirstFrame' | 'testInjection'>) {
  // The signal is emitted from the render loop, after Canvas has accepted the scene.
  // The browser contract uses this marker instead of treating a mounted Canvas as visible.
  useFrame(() => {
    if (testInjection !== 'first-frame-timeout') onFirstFrame()
  })
  return null
}

function SceneContent({
  currentTime,
  focusRequest,
  focusNodeId,
  nodesAtTime,
  onSelect,
  onFirstFrame,
  positions,
  reducedMotion,
  resetSignal,
  selectedNodeId,
  workflow,
  testInjection,
}: SceneContentProps) {
  const visibleNodes = nodesAtTime ?? workflow.nodes
  const nodeById = useMemo(
    () => new Map(visibleNodes.map((node) => [node.id, node])),
    [visibleNodes],
  )
  const floorY = useMemo(() => {
    const values = visibleNodes
      .map((node) => getPosition(positions, node.id)?.[1])
      .filter((value): value is number => value !== undefined)
    return (values.length > 0 ? Math.min(...values) : 0) - 1.35
  }, [positions, visibleNodes])
  const sceneBounds = useMemo(() => getSceneBounds(positions), [positions])

  return (
    <>
      <SceneFailureInjection mode={testInjection} />
      <FirstFrameSignal onFirstFrame={onFirstFrame} testInjection={testInjection} />
      <SceneEnvironment
        center={sceneBounds.center}
        floorY={floorY}
        onBackgroundClick={() => onSelect(null)}
        radius={sceneBounds.radius}
        reducedMotion={reducedMotion}
      />
      <group>
        {workflow.edges.map((edge) => {
          const sourceNode = nodeById.get(edge.source)
          const targetNode = nodeById.get(edge.target)
          const source = getPosition(positions, edge.source)
          const target = getPosition(positions, edge.target)
          if (!sourceNode || !targetNode || !source || !target) return null

          return (
            <WorkflowEdge3D
              key={edge.id}
              reducedMotion={reducedMotion}
              source={source}
              sourceStatus={sourceNode.status}
              target={target}
              targetStatus={targetNode.status}
            />
          )
        })}
      </group>
      <group>
        {visibleNodes.map((node, index) => {
          const position = getPosition(positions, node.id)
          if (!position) return null
          return (
            <WorkflowNode3D
              currentTime={currentTime}
              featured={node.id === focusNodeId}
              focusMode={selectedNodeId !== null}
              labelRaised={index % 2 === 1}
              key={node.id}
              node={node}
              onSelect={onSelect}
              position={position}
              reducedMotion={reducedMotion}
              selected={node.id === selectedNodeId}
            />
          )
        })}
      </group>
      <CameraController
        focusRequest={focusRequest ?? null}
        positions={positions}
        resetSignal={resetSignal}
        sceneKey={workflow.id}
      />
    </>
  )
}

export function WorkflowScene(props: WorkflowSceneProps) {
  const reducedMotion = useReducedMotion()
  const [retryNonce, setRetryNonce] = useState(0)
  const [watchdogEnabled, setWatchdogEnabled] = useState(false)
  const [sceneState, setSceneState] = useState<ScenePresentationStateV1>({ status: 'initializing' })
  const phaseRef = useRef<ScenePhase>('initializing')
  const contextCleanupRef = useRef<(() => void) | null>(null)
  const presentationPositions = useMemo(
    () => createPresentationPositions(props.positions),
    [props.positions],
  )
  const bounds = useMemo(
    () => getSceneBounds(presentationPositions),
    [presentationPositions],
  )
  const initialDistance = getSceneFitDistance(presentationPositions, 1.25, 42)
  const cameraPosition: [number, number, number] = [
    bounds.center[0] + initialDistance * 0.11,
    bounds.center[1] + initialDistance * 0.3,
    bounds.center[2] + initialDistance * 0.95,
  ]

  const testInjection = readSceneTestInjection()
  const retry = useCallback(() => {
    phaseRef.current = 'initializing'
    setWatchdogEnabled(false)
    setSceneState({ status: 'initializing' })
    setRetryNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    contextCleanupRef.current?.()
    contextCleanupRef.current = null
    phaseRef.current = 'initializing'
    setWatchdogEnabled(false)
    // 0-node degraded Mission Tree must never render a blank WebGL center.
    if (props.workflow.nodes.length === 0) {
      phaseRef.current = 'degraded'
      setSceneState({
        status: 'degraded',
        renderer: 'dom-tree',
        reason_code: 'viewer.scene.task_tree_empty',
        retryable: true,
      })
    } else if (!isWebglAvailable()) {
      phaseRef.current = 'degraded'
      setSceneState({
        status: 'degraded',
        renderer: 'dom-tree',
        reason_code: 'viewer.scene.webgl_unavailable',
        retryable: true,
      })
    } else if (!cancelled) {
      setSceneState({ status: 'initializing' })
      setWatchdogEnabled(true)
    }
    return () => {
      cancelled = true
      contextCleanupRef.current?.()
      contextCleanupRef.current = null
    }
  }, [props.workflow.nodes.length, retryNonce])

  useEffect(() => {
    if (!watchdogEnabled || sceneState.status !== 'initializing') return
    let remaining = 1800
    let startedAt = 0
    let timer: number | undefined
    const schedule = () => {
      if (document.visibilityState === 'hidden') return
      startedAt = Date.now()
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'hidden') return
        phaseRef.current = 'degraded'
        setWatchdogEnabled(false)
        setSceneState({
          status: 'degraded',
          renderer: 'dom-tree',
          reason_code: 'viewer.scene.first_frame_timeout',
          retryable: true,
        })
      }, Math.max(1, remaining))
    }
    const pause = () => {
      if (timer === undefined) return
      window.clearTimeout(timer)
      timer = undefined
      remaining = Math.max(1, remaining - (Date.now() - startedAt))
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') pause()
      else schedule()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    schedule()
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [sceneState.status, watchdogEnabled])

  const onFirstFrame = useCallback(() => {
    // A render-loop tick may race the React commit that unmounts a failed Canvas.
    // Never let that stale tick turn a degraded surface back into ready.
    if (phaseRef.current !== 'initializing') return
    phaseRef.current = 'ready'
    setWatchdogEnabled(false)
    setSceneState({
      status: 'ready',
      renderer: 'webgl',
      first_frame_at: new Date().toISOString(),
    })
  }, [])

  const onSceneError = useCallback(() => {
    const failurePhase: SceneFailurePhase = phaseRef.current === 'ready' ? 'ready' : 'initializing'
    phaseRef.current = 'degraded'
    setWatchdogEnabled(false)
    setSceneState({
      status: 'degraded',
      renderer: 'dom-tree',
      reason_code: reasonForSceneError(failurePhase),
      retryable: true,
    })
  }, [])

  const onCanvasCreated = useCallback((canvas: HTMLCanvasElement) => {
    contextCleanupRef.current?.()
    const onContextLost = (event: Event) => {
      event.preventDefault()
      phaseRef.current = 'degraded'
      setWatchdogEnabled(false)
      setSceneState({
        status: 'degraded',
        renderer: 'dom-tree',
        reason_code: 'viewer.scene.context_lost',
        retryable: true,
      })
    }
    canvas.addEventListener('webglcontextlost', onContextLost)
    contextCleanupRef.current = () => canvas.removeEventListener('webglcontextlost', onContextLost)
    setWatchdogEnabled(true)
  }, [])

  const renderFallback = sceneState.status === 'degraded' ? (
    <WorkflowFallback
      nodesAtTime={props.nodesAtTime}
      onRetry={retry}
      onSelect={props.onSelect}
      positions={presentationPositions}
      reducedMotion={reducedMotion}
      selectedNodeId={props.selectedNodeId}
      state={sceneState}
      workflow={props.workflow}
    />
  ) : null
  const showCanvas = sceneState.status === 'ready'
    || (sceneState.status === 'initializing' && watchdogEnabled)

  return (
    <div
      aria-label={`${props.workflow.name}の制作工程。ノードは${props.workflow.nodes.length}件です。`}
      data-first-frame={sceneState.status === 'ready' ? 'true' : 'false'}
      data-renderer={sceneState.status === 'ready' ? 'webgl' : sceneState.status === 'degraded' ? 'dom-tree' : 'initializing'}
      data-scene-status={sceneState.status}
      data-scene-surface="true"
      role="group"
      style={{ height: '100%', minHeight: 320, position: 'relative', width: '100%' }}
    >
      {renderFallback}
      {sceneState.status === 'initializing' ? (
        <div aria-live="polite" className="scene-loading" data-scene-loading="true">
          3D空間を構築しています…
        </div>
      ) : null}
      {showCanvas ? (
        <SceneErrorBoundary
          fallback={renderFallback ?? <div className="scene-loading">3D表示を準備しています…</div>}
          onError={onSceneError}
          resetKey={retryNonce}
        >
          <Canvas
            camera={{ far: 140, fov: 42, near: 0.1, position: cameraPosition }}
            dpr={[1, 1.75]}
            gl={{ antialias: true, powerPreference: 'high-performance' }}
            key={retryNonce}
            onCreated={({ gl }) => onCanvasCreated(gl.domElement)}
            onPointerMissed={() => props.onSelect(null)}
            shadows="percentage"
          >
            <SceneContent
              {...props}
              onFirstFrame={onFirstFrame}
              positions={presentationPositions}
              reducedMotion={reducedMotion}
              testInjection={testInjection}
            />
          </Canvas>
        </SceneErrorBoundary>
      ) : null}
    </div>
  )
}

function readSceneTestInjection(): SceneTestInjection | undefined {
  const isDev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ?? false
  if (!isDev) return undefined
  const candidate = (globalThis as { __TSUGITE_SCENE_TEST__?: unknown }).__TSUGITE_SCENE_TEST__
  return candidate === 'initialization-throw' || candidate === 'first-frame-timeout'
    ? candidate
    : undefined
}

export function isWebglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(
      canvas.getContext('webgl2')
      ?? canvas.getContext('webgl')
      ?? canvas.getContext('experimental-webgl'),
    )
  } catch {
    return false
  }
}
