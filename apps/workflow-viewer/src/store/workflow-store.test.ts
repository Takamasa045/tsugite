import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import type { WorkflowData } from '../types/workflow'
import { useWorkflowStore } from './workflow-store'

const workflow: WorkflowData = {
  id: 'store-test',
  name: 'Store test',
  status: 'running',
  duration: 60,
  nodes: [],
  edges: [],
  events: [],
}

describe('workflow store', () => {
  beforeEach(() => useWorkflowStore.getState().clearWorkflow())

  it('loads a workflow and resets viewer state', () => {
    useWorkflowStore.getState().setCurrentTime(10)
    useWorkflowStore.getState().selectNode('old')
    useWorkflowStore.getState().setPlaying(true)
    useWorkflowStore.getState().setWorkflow(workflow)

    expect(useWorkflowStore.getState()).toMatchObject({
      workflow,
      duration: 60,
      currentTime: 0,
      selectedNodeId: null,
      isPlaying: false,
    })
  })

  it('clamps current time and exposes playback controls', () => {
    useWorkflowStore.getState().setWorkflow(workflow)
    useWorkflowStore.getState().setCurrentTime(90)
    useWorkflowStore.getState().setPlaybackSpeed(4)
    useWorkflowStore.getState().togglePlaying()

    expect(useWorkflowStore.getState()).toMatchObject({
      currentTime: 60,
      playbackSpeed: 4,
      isPlaying: true,
    })

    useWorkflowStore.getState().resetPlayback()
    expect(useWorkflowStore.getState()).toMatchObject({ currentTime: 0, isPlaying: false })
  })

  it('ignores unsupported playback speeds', () => {
    useWorkflowStore.getState().setPlaybackSpeed(3 as never)
    expect(useWorkflowStore.getState().playbackSpeed).toBe(1)
  })

  it('works as a bound React hook with default and custom selectors', () => {
    const allState = renderHook(() => useWorkflowStore())
    const selectedTime = renderHook(() => useWorkflowStore((state) => state.currentTime))

    act(() => useWorkflowStore.getState().setWorkflow(workflow))
    act(() => useWorkflowStore.getState().setCurrentTime(12))

    expect(allState.result.current.workflow?.id).toBe('store-test')
    expect(selectedTime.result.current).toBe(12)
  })
})
