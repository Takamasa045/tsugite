import { describe, expect, it } from 'vitest'

import { validateWorkflowData } from '../lib/workflow-parser'
import { workflowSamples } from './index'

describe('workflow samples', () => {
  it('provides three valid, substantial and distinct workflows', () => {
    expect(workflowSamples).toHaveLength(3)
    expect(new Set(workflowSamples.map((sample) => sample.id)).size).toBe(3)

    for (const sample of workflowSamples) {
      expect(sample.label.length).toBeGreaterThan(0)
      expect(sample.data.nodes.length).toBeGreaterThanOrEqual(7)
      expect(sample.data.nodes.length).toBeLessThanOrEqual(12)
      expect(validateWorkflowData(sample.data).success).toBe(true)
    }
  })

  it('includes an error and recovery scenario', () => {
    const errorSample = workflowSamples.find((sample) => sample.id === 'error-recovery')

    expect(errorSample?.data.events.some((event) => event.status === 'error')).toBe(true)
    expect(errorSample?.data.events.some((event) => event.status === 'waiting_approval')).toBe(true)
    expect(errorSample?.data.events.at(-1)?.status).toBe('completed')
  })
})
