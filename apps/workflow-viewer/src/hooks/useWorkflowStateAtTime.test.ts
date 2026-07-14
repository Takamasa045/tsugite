import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { WorkflowData } from '../types/workflow'
import { useWorkflowStateAtTime } from './useWorkflowStateAtTime'

const workflow: WorkflowData = {
  id: 'hook-test',
  name: 'Hook test',
  status: 'running',
  duration: 10,
  nodes: [
    {
      id: 'node',
      name: 'Node',
      type: 'task',
      status: 'pending',
      progress: 0,
      inputs: [],
      outputs: [],
      logs: [],
    },
  ],
  edges: [],
  events: [{ time: 5, nodeId: 'node', status: 'completed', progress: 100 }],
}

describe('useWorkflowStateAtTime', () => {
  it('derives state and supports an unloaded workflow', () => {
    const { result, rerender } = renderHook(
      ({ data, time }: { data: WorkflowData | null; time: number }) =>
        useWorkflowStateAtTime(data, time),
      { initialProps: { data: workflow as WorkflowData | null, time: 5 } },
    )

    expect(result.current?.nodeById.node.status).toBe('completed')
    rerender({ data: null, time: 0 })
    expect(result.current).toBeNull()
  })
})
