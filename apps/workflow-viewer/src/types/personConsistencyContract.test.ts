/**
 * L5 — package-boundary type contract for person-consistency panel payload.
 * Viewer owns WorkflowPersonConsistencyEvidence as the single local source of truth;
 * PersonConsistencyPanelProps is an alias (no duplicate shape).
 */
import { describe, expect, it, expectTypeOf } from 'vitest'
import type { PersonConsistencyPanelProps } from '../components/qa/PersonConsistencyPanel'
import type { WorkflowPersonConsistencyEvidence } from './workflow'

describe('person consistency type contract', () => {
  it('keeps panel props identical to workflow personConsistency evidence', () => {
    expectTypeOf<PersonConsistencyPanelProps>().toEqualTypeOf<WorkflowPersonConsistencyEvidence>()
    expectTypeOf<WorkflowPersonConsistencyEvidence>().toHaveProperty('evidence_integrity')
    expectTypeOf<WorkflowPersonConsistencyEvidence>().toHaveProperty('subjects')
    expectTypeOf<WorkflowPersonConsistencyEvidence>().toHaveProperty('contact_sheet_alt')
    // Runtime smoke so the file is not type-only empty under vitest
    const sample: WorkflowPersonConsistencyEvidence = {
      stage: 'gate_2',
      status: 'ok',
      status_label: 'OK',
      basis_summary: 'reference',
      subjects: [],
      ambiguities: [],
      contact_sheet_alt: 'alt',
      evidence_integrity: 'valid',
    }
    expect(sample.evidence_integrity).toBe('valid')
  })
})
