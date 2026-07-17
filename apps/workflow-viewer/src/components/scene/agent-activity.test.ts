import { describe, expect, it } from 'vitest'

import type { WorkflowNode, WorkflowStatus } from '../../types/workflow'
import {
  getAgentActivity,
  getAgentWorkerDepartureProgress,
  getAgentWorkerLabel,
  shouldShowAgentWorker,
} from './agent-activity'

const statuses: WorkflowStatus[] = [
  'pending',
  'queued',
  'thinking',
  'running',
  'waiting_approval',
  'testing',
  'completed',
  'error',
  'skipped',
]

describe('getAgentActivity', () => {
  it('すべての状態に木偶職人の所作を割り当てる', () => {
    for (const status of statuses) {
      const activity = getAgentActivity(status)
      expect(activity.mode).toBeTruthy()
      expect(activity.intensity).toBeGreaterThanOrEqual(0)
    }
  })

  it('作業・検査・確認待ちを異なる道具と所作で表す', () => {
    expect(getAgentActivity('running')).toMatchObject({
      animated: true,
      mode: 'craft',
      tool: 'chisel',
    })
    expect(getAgentActivity('testing')).toMatchObject({
      animated: true,
      mode: 'inspect',
      scan: true,
      tool: 'lantern',
    })
    expect(getAgentActivity('waiting_approval')).toMatchObject({
      mode: 'signal',
      tool: 'lantern',
    })
  })

  it('完了後は静かな点検所作にし、軽減モーションでは静止する', () => {
    expect(getAgentActivity('completed')).toMatchObject({
      animated: true,
      mode: 'inspect',
      scan: false,
    })
    expect(getAgentActivity('completed').intensity).toBeLessThan(0.25)
    expect(getAgentActivity('running', true)).toMatchObject({
      animated: false,
      intensity: 0,
      mode: 'craft',
    })
  })
})

function node(
  status: WorkflowStatus,
  overrides: Partial<Pick<WorkflowNode, 'agent' | 'type'>> = {},
): Pick<WorkflowNode, 'agent' | 'status' | 'type'> {
  return { status, type: 'task', ...overrides }
}

describe('shouldShowAgentWorker', () => {
  it.each<WorkflowStatus>([
    'queued',
    'thinking',
    'running',
    'waiting_approval',
    'testing',
    'error',
  ])('%sの工程には種類や担当者名に関係なく職人を表示する', (status) => {
    expect(shouldShowAgentWorker(node(status))).toBe(true)
  })

  it('担当者情報があっても、未着手・完了・スキップ工程では職人を表示しない', () => {
    expect(shouldShowAgentWorker(node('pending'))).toBe(false)
    expect(shouldShowAgentWorker(node('pending', { agent: 'planner-agent' }))).toBe(false)
    expect(shouldShowAgentWorker(node('completed', { type: 'agent' }))).toBe(false)
    expect(shouldShowAgentWorker(node('skipped'))).toBe(false)
  })
})

describe('getAgentWorkerLabel', () => {
  it('作業状態を非エンジニアにも分かる行動の言葉へ変換する', () => {
    expect(getAgentWorkerLabel('thinking')).toBe('職人が考えをまとめています')
    expect(getAgentWorkerLabel('running')).toBe('職人が手を動かしています')
    expect(getAgentWorkerLabel('waiting_approval')).toBe('職人があなたの確認を待っています')
    expect(getAgentWorkerLabel('testing')).toBe('職人が仕上がりを点検しています')
    expect(getAgentWorkerLabel('error')).toBe('職人が直し方を探しています')
  })

  it('職人がいない状態では説明を返さない', () => {
    expect(getAgentWorkerLabel('pending')).toBeNull()
    expect(getAgentWorkerLabel('completed')).toBeNull()
    expect(getAgentWorkerLabel('skipped')).toBeNull()
  })
})

describe('getAgentWorkerDepartureProgress', () => {
  it('完了後1.5秒だけ、一礼から退場までの進み具合を返す', () => {
    const completedNode = { status: 'completed' as const, completedAt: 18 }
    expect(getAgentWorkerDepartureProgress(completedNode, 18)).toBe(0)
    expect(getAgentWorkerDepartureProgress(completedNode, 18.75)).toBeCloseTo(0.5)
    expect(getAgentWorkerDepartureProgress(completedNode, 19.49)).toBeGreaterThan(0.99)
    expect(getAgentWorkerDepartureProgress(completedNode, 19.5)).toBeNull()
  })

  it('開始時に完了している工程や、作業中の工程には退場演出を出さない', () => {
    expect(getAgentWorkerDepartureProgress({ status: 'completed', completedAt: 0 }, 0)).toBeNull()
    expect(getAgentWorkerDepartureProgress({ status: 'running', completedAt: 18 }, 18)).toBeNull()
    expect(getAgentWorkerDepartureProgress({ status: 'completed' }, 18)).toBeNull()
  })
})
