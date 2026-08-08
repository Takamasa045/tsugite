/**
 * M4 — real integration: NodeDetails receives details.personConsistency and
 * renders PersonConsistencyPanel (heading / alert / contact sheet) on the real path.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowData, WorkflowNode } from '../../types/workflow'
import { NodeDetails } from './NodeDetails'

afterEach(cleanup)

const baseWorkflow: WorkflowData = {
  id: 'wf-person-qa',
  name: 'Person QA workflow',
  status: 'waiting_approval',
  duration: 10,
  nodes: [],
  edges: [],
  events: [],
}

function gateNode(
  personConsistency: WorkflowNode['details'] extends infer D
    ? D extends { personConsistency?: infer P }
      ? P
      : never
    : never,
): WorkflowNode {
  return {
    id: 'gate-2',
    name: 'Gate 2 承認',
    type: 'approval',
    status: 'waiting_approval',
    progress: 50,
    inputs: ['manifest'],
    outputs: ['gate2'],
    logs: [],
    details: {
      purpose: '生成品質を確認する',
      activity: '人物一貫性を含む証跡を確認',
      outcome: '承認待ち',
      inputs: [],
      outputs: [],
      personConsistency,
    },
  }
}

const validEvidence = {
  stage: 'gate_2',
  status: 'review',
  status_label: '要レビュー（人が判断）',
  basis_summary: 'reference',
  subjects: [
    {
      subject_id: 'hero',
      basis: 'reference',
      evaluable_coverage: 0.8,
      traits: [{ trait: 'identity', status: 'stable', level: 'required' }],
      ambiguity_codes: [],
      observation_count: 2,
      face_evaluable_count: 2,
    },
  ],
  ambiguities: [],
  contact_sheet_href: 'qa/person-consistency/gate2/contact-sheet.webp',
  contact_sheet_alt: '人物一貫性コンタクトシート: 対象 hero',
  report_href: 'qa/person-consistency/gate2/report.json',
  evidence_integrity: 'valid' as const,
  evidence_integrity_label: '証跡ハッシュ検証: 有効',
  analyzer: {
    status: 'ok' as const,
    label: '解析器: 実行済み',
    needs_human_review: false,
  },
  frame_details: [
    {
      timestamp_ms: 0,
      shot_id: 'shot_1',
      visibility: 'visible',
      face_evaluable: true,
      reason: 'ok',
    },
  ],
}

describe('NodeDetails personConsistency integration', () => {
  it('renders panel heading and lazy contact sheet via details.personConsistency', () => {
    const node = gateNode(validEvidence)
    render(
      <NodeDetails
        workflow={baseWorkflow}
        node={node}
        currentNodes={[node]}
        onSelectNode={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('heading', { name: '人物一貫性 QA 証跡' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/判定: 要レビュー/)).toBeInTheDocument()
    const img = screen.getByRole('img', { name: /人物一貫性コンタクトシート/ })
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(screen.getByRole('heading', { name: 'コンタクトシート' })).toBeInTheDocument()
  })

  it('shows alert and hides media when integrity is tampered', () => {
    const node = gateNode({
      ...validEvidence,
      evidence_integrity: 'tampered',
      evidence_integrity_label: '証跡ハッシュ検証: 改ざん検出（自動合格にしない）',
    })
    render(
      <NodeDetails
        workflow={baseWorkflow}
        node={node}
        currentNodes={[node]}
        onSelectNode={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('heading', { name: '人物一貫性 QA 証跡' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/改ざん|無効/)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /人物一貫性コンタクトシート/ }),
    ).not.toBeInTheDocument()
  })

  it('does not mount the panel when personConsistency is absent', () => {
    const node: WorkflowNode = {
      id: 'gate-2',
      name: 'Gate 2 承認',
      type: 'approval',
      status: 'waiting_approval',
      progress: 50,
      inputs: [],
      outputs: [],
      logs: [],
      details: {
        purpose: '確認',
        activity: '確認中',
        outcome: '待ち',
        inputs: [],
        outputs: [],
      },
    }
    render(
      <NodeDetails
        workflow={baseWorkflow}
        node={node}
        currentNodes={[node]}
        onSelectNode={vi.fn()}
      />,
    )
    expect(
      screen.queryByRole('heading', { name: '人物一貫性 QA 証跡' }),
    ).not.toBeInTheDocument()
  })
})
