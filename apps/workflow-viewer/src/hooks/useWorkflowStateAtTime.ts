import { useMemo } from 'react'

import { deriveWorkflowStateAtTime } from '../lib/timeline'
import type { DerivedWorkflowState, WorkflowData } from '../types/workflow'

export function useWorkflowStateAtTime(
  workflow: WorkflowData | null,
  currentTime: number,
): DerivedWorkflowState | null {
  return useMemo(
    () => (workflow ? deriveWorkflowStateAtTime(workflow, currentTime) : null),
    [workflow, currentTime],
  )
}
