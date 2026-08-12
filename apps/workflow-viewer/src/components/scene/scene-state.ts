export const SCENE_REASON_CODES = [
  'viewer.scene.webgl_unavailable',
  'viewer.scene.initialization_failed',
  'viewer.scene.context_lost',
  'viewer.scene.first_frame_timeout',
  'viewer.scene.runtime_error',
  'viewer.scene.task_tree_empty',
] as const

export type SceneReasonCode = (typeof SCENE_REASON_CODES)[number]

export type ScenePresentationStateV1 =
  | { status: 'initializing' }
  | { status: 'ready'; renderer: 'webgl'; first_frame_at: string }
  | {
      status: 'degraded'
      renderer: 'dom-tree'
      reason_code: SceneReasonCode
      retryable: boolean
    }

export const SCENE_REASON_LABELS: Record<SceneReasonCode, string> = {
  'viewer.scene.webgl_unavailable': 'この環境ではWebGLを利用できません。',
  'viewer.scene.initialization_failed': '3D空間の初期化に失敗しました。',
  'viewer.scene.context_lost': '3D表示の接続が失われました。',
  'viewer.scene.first_frame_timeout': '3D表示の初回描画を確認できませんでした。',
  'viewer.scene.runtime_error': '3D表示中に問題が発生しました。',
  'viewer.scene.task_tree_empty':
    'TaskTree 成果物が無く、表示できる工程ノードがありません。',
}

export type SceneFailurePhase = 'initializing' | 'ready'

/** Development-only browser injection modes used by the PO-0A fixture. */
export type SceneTestInjection = 'initialization-throw' | 'first-frame-timeout'

export function reasonForSceneError(phase: SceneFailurePhase): SceneReasonCode {
  return phase === 'ready'
    ? 'viewer.scene.runtime_error'
    : 'viewer.scene.initialization_failed'
}

export function isSceneReasonCode(value: unknown): value is SceneReasonCode {
  return typeof value === 'string' && (SCENE_REASON_CODES as readonly string[]).includes(value)
}

/**
 * Ignore stale webglcontextlost from disposed canvases (StrictMode remount,
 * retry, or R3F teardown). Only the active connected canvas may degrade UI.
 */
export function shouldSurfaceContextLost(input: {
  canvasConnected: boolean
  eventGeneration: number
  activeGeneration: number
  phase: SceneFailurePhase | 'degraded'
}): boolean {
  if (!input.canvasConnected) return false
  if (input.eventGeneration !== input.activeGeneration) return false
  if (input.phase === 'degraded') return false
  return true
}

/** Probe-only WebGL contexts must not retain GPU slots. */
export function releaseWebglContext(gl: { getExtension: (name: string) => unknown } | null | undefined): void {
  if (!gl) return
  const extension = gl.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null
  extension?.loseContext?.()
}
