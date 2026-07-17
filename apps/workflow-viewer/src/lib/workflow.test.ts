import { describe, expect, it } from 'vitest'

import type { WorkflowData } from '../types/workflow'
import { calculateNodePositions } from './layout-engine'
import { getStatusConfig, STATUS_CONFIG } from './status-config'
import { calculateWorkflowProgress, deriveWorkflowStateAtTime } from './timeline'
import { parseWorkflowJson, validateWorkflowData } from './workflow-parser'

const validWorkflow: WorkflowData = {
  id: 'test-workflow',
  name: 'Test workflow',
  status: 'running',
  duration: 30,
  nodes: [
    {
      id: 'plan',
      name: 'Plan',
      type: 'task',
      status: 'pending',
      progress: 0,
      position: { layer: 0, order: 0 },
      inputs: [],
      outputs: ['plan.json'],
      logs: [],
    },
    {
      id: 'build',
      name: 'Build',
      type: 'agent',
      status: 'pending',
      progress: 0,
      position: { layer: 1, order: 0 },
      inputs: ['plan.json'],
      outputs: ['app'],
      logs: [],
    },
  ],
  edges: [{ id: 'plan-build', source: 'plan', target: 'build' }],
  events: [
    { time: 0, nodeId: 'plan', status: 'running', progress: 0 },
    { time: 10, nodeId: 'plan', status: 'completed', progress: 100 },
    { time: 11, nodeId: 'build', status: 'running', progress: 20 },
    { time: 20, nodeId: 'build', status: 'running', progress: 75 },
    { time: 30, nodeId: 'build', status: 'completed', progress: 100 },
  ],
}

describe('workflow parser and validator', () => {
  it('parses a valid JSON workflow', () => {
    const result = parseWorkflowJson(JSON.stringify(validWorkflow))

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.id).toBe('test-workflow')
  })

  it('returns a readable syntax error for malformed JSON', () => {
    const result = parseWorkflowJson('{"id":')

    expect(result.success).toBe(false)
    if (!result.success) expect(result.errors[0]?.code).toBe('invalid_json')
  })

  it.each([
    ['missing required fields', {}, 'required'],
    [
      'duplicate node ids',
      { ...validWorkflow, nodes: [...validWorkflow.nodes, validWorkflow.nodes[0]] },
      'duplicate_node_id',
    ],
    [
      'missing edge targets',
      { ...validWorkflow, edges: [{ id: 'bad', source: 'plan', target: 'missing' }] },
      'unknown_edge_node',
    ],
    [
      'invalid statuses',
      { ...validWorkflow, status: 'finished' },
      'invalid_status',
    ],
    [
      'negative event times',
      { ...validWorkflow, events: [{ time: -1, nodeId: 'plan', status: 'running' }] },
      'negative_time',
    ],
    [
      'events beyond duration',
      { ...validWorkflow, events: [{ time: 31, nodeId: 'plan', status: 'running' }] },
      'time_exceeds_duration',
    ],
    [
      'events for missing nodes',
      { ...validWorkflow, events: [{ time: 1, nodeId: 'missing', status: 'running' }] },
      'unknown_event_node',
    ],
  ])('rejects %s', (_label, input, expectedCode) => {
    const result = validateWorkflowData(input)

    expect(result.success).toBe(false)
    if (!result.success) expect(result.errors.map((error) => error.code)).toContain(expectedCode)
  })

  it('reports cycles as a non-fatal warning', () => {
    const result = validateWorkflowData({
      ...validWorkflow,
      edges: [
        { id: 'a', source: 'plan', target: 'build' },
        { id: 'b', source: 'build', target: 'plan' },
      ],
    })

    expect(result.success).toBe(true)
    if (result.success) expect(result.warnings?.[0]?.code).toBe('cycle_detected')
  })

  it('accepts human-readable node details and rejects malformed detail records', () => {
    const withDetails = {
      ...validWorkflow,
      nodes: [{
        ...validWorkflow.nodes[0],
        details: {
          purpose: '制作条件を確定するためです。',
          activity: '依頼内容と制作設計を照合しました。',
          outcome: '必要な条件が揃っていることを確認しました。',
          inputs: [{ label: '制作依頼', description: '作りたい内容をまとめた依頼です。', reference: 'request.md', href: './review/index.html' }],
          outputs: [{ label: '検証結果', description: '制作を開始できるという確認結果です。', facts: ['エラー: 0件'] }],
          previews: [{
            id: 'final-video',
            role: 'final',
            kind: 'video',
            label: '完成動画',
            description: '確認済みの完成版です。',
            src: './previews/final-video.mp4',
          }],
          approval: {
            subject: '制作を開始すること',
            checkpoints: ['目的と尺が合っていること'],
            decision: '承認済みです。',
            decidedAt: '2026-07-13T09:00:00.000Z',
          },
        },
      }, validWorkflow.nodes[1]],
    }

    expect(validateWorkflowData(withDetails).success).toBe(true)
    const unsafeHref = validateWorkflowData({
      ...withDetails,
      nodes: [{
        ...withDetails.nodes[0],
        details: {
          ...withDetails.nodes[0].details,
          inputs: [{ label: '外部ページ', description: '許可しないリンクです。', href: 'https://example.com/review.html' }],
        },
      }, withDetails.nodes[1]],
    })
    expect(unsafeHref.success).toBe(false)
    if (!unsafeHref.success) expect(unsafeHref.errors.map((error) => error.path)).toContain('nodes[0].details.inputs[0].href')
    const malformed = validateWorkflowData({
      ...withDetails,
      nodes: [{ ...withDetails.nodes[0], details: { purpose: '', inputs: 'request.md' } }, withDetails.nodes[1]],
    })
    expect(malformed.success).toBe(false)
    if (!malformed.success) expect(malformed.errors.map((error) => error.code)).toContain('invalid_details')
  })

  it('rejects malformed media previews and technical labels', () => {
    const malformed = validateWorkflowData({
      ...validWorkflow,
      nodes: [{
        ...validWorkflow.nodes[0],
        technicalName: '',
        details: {
          purpose: '目的', activity: '作業', outcome: '結果', inputs: [], outputs: [],
          previews: [{ id: 'bad', role: 'unknown', kind: 'document', label: '', description: '', src: '../secret' }],
        },
      }, validWorkflow.nodes[1]],
    })

    expect(malformed.success).toBe(false)
    if (!malformed.success) {
      expect(malformed.errors.map((error) => error.path)).toEqual(expect.arrayContaining([
        'nodes[0].technicalName',
        'nodes[0].details.previews[0].role',
        'nodes[0].details.previews[0].kind',
        'nodes[0].details.previews[0].src',
      ]))
    }
  })

  it('collects malformed nested fields instead of throwing', () => {
    expect(validateWorkflowData(null).success).toBe(false)
    const malformed = validateWorkflowData({
      ...validWorkflow,
      duration: -1,
      nodes: [
        null,
        {
          ...validWorkflow.nodes[0],
          type: 'unknown',
          progress: 101,
          inputs: [42],
          outputs: 'output',
          logs: [null, { time: 'soon', level: 'debug', message: '' }],
          startedAt: -1,
          completedAt: 'later',
          position: { layer: -1, order: 0.5 },
        },
      ],
      edges: [null, { id: 'same', source: 'plan', target: 'plan' }, { id: 'same', source: 'plan', target: 'plan' }],
      events: [null, { time: 'now', nodeId: 'plan', status: 'unknown', progress: 101 }],
    })

    expect(malformed.success).toBe(false)
    if (!malformed.success) {
      const codes = malformed.errors.map((error) => error.code)
      expect(codes).toEqual(
        expect.arrayContaining([
          'invalid_duration',
          'invalid_node',
          'invalid_node_type',
          'invalid_log_level',
          'invalid_edge',
          'invalid_event',
        ]),
      )
    }
  })
})

describe('status presentation config', () => {
  it('defines a non-color cue for every status', () => {
    expect(Object.keys(STATUS_CONFIG)).toHaveLength(9)
    for (const config of Object.values(STATUS_CONFIG)) {
      expect(config.label).not.toBe('')
      expect(config.symbol).not.toBe('')
    }
    expect(getStatusConfig('error')).toMatchObject({ label: '要確認', symbol: '⚠' })
  })
})

describe('timeline state derivation', () => {
  it('replays sorted events up to the requested time', () => {
    const state = deriveWorkflowStateAtTime(
      { ...validWorkflow, events: [...validWorkflow.events].reverse() },
      20,
    )

    expect(state.nodeById.plan).toMatchObject({ status: 'completed', progress: 100 })
    expect(state.nodeById.build).toMatchObject({ status: 'running', progress: 75 })
    expect(state.progress).toBe(87.5)
  })

  it('can rewind without retaining state from a later seek', () => {
    const later = deriveWorkflowStateAtTime(validWorkflow, 30)
    const earlier = deriveWorkflowStateAtTime(validWorkflow, 5)

    expect(later.nodeById.build.status).toBe('completed')
    expect(earlier.nodeById.plan.status).toBe('running')
    expect(earlier.nodeById.build.status).toBe('pending')
    expect(validWorkflow.nodes[0]?.status).toBe('pending')
  })

  it('shows only work records that exist at the selected time', () => {
    const workflowWithLogs: WorkflowData = {
      ...validWorkflow,
      nodes: validWorkflow.nodes.map((node) => node.id === 'build'
        ? {
            ...node,
            logs: [
              { time: 12, level: 'info' as const, message: '着手' },
              { time: 25, level: 'success' as const, message: '完了確認' },
            ],
          }
        : node),
    }

    expect(deriveWorkflowStateAtTime(workflowWithLogs, 20).nodeById.build.logs).toEqual([
      { time: 12, level: 'info', message: '着手' },
    ])
    expect(deriveWorkflowStateAtTime(workflowWithLogs, 30).nodeById.build.logs).toHaveLength(2)
  })

  it('巻き戻した時点では未来の結果や承認判断を表示しない', () => {
    const workflowWithDetails: WorkflowData = {
      ...validWorkflow,
      nodes: validWorkflow.nodes.map((node) => node.id === 'build' ? {
        ...node,
        details: {
          purpose: '完成品を作るためです。',
          activity: '素材を組み立てます。',
          outcome: '完成品を納品可能と判断しました。',
          inputs: [],
          outputs: [{ label: '完成品', description: '承認済みです。', facts: ['最終承認済み'] }],
          approval: {
            subject: '完成品を採用すること',
            checkpoints: ['品質に問題がないこと'],
            decision: '最終承認済みです。',
            decidedAt: '2026-07-13T09:00:00.000Z',
          },
        },
      } : node),
    }

    const beforeWork = deriveWorkflowStateAtTime(workflowWithDetails, 5).nodeById.build.details
    const afterWork = deriveWorkflowStateAtTime(workflowWithDetails, 30).nodeById.build.details
    expect(beforeWork?.outcome).toBe('まだ着手していません。前工程の完了後にこの作業を始めます。')
    expect(beforeWork?.approval).toMatchObject({ decision: 'まだ判断は行われていません。前工程の完了後に内容を確認してください。' })
    expect(beforeWork?.approval).not.toHaveProperty('decidedAt')
    expect(beforeWork?.outputs[0]?.facts).toEqual(['まだ判断は行われていません。前工程の完了後に内容を確認してください。'])
    expect(afterWork?.outcome).toBe('完成品を納品可能と判断しました。')
    expect(afterWork?.approval?.decision).toBe('最終承認済みです。')
  })

  it('clamps time and progress to valid ranges', () => {
    const state = deriveWorkflowStateAtTime(
      {
        ...validWorkflow,
        events: [{ time: 0, nodeId: 'plan', status: 'running', progress: 180 }],
      },
      -10,
    )

    expect(state.currentTime).toBe(0)
    expect(state.nodeById.plan.progress).toBe(100)
  })

  it('calculates the arithmetic mean and handles empty input', () => {
    expect(calculateWorkflowProgress(validWorkflow.nodes)).toBe(0)
    expect(calculateWorkflowProgress([])).toBe(0)
    expect(
      calculateWorkflowProgress([
        { ...validWorkflow.nodes[0], progress: -5 },
        { ...validWorkflow.nodes[1], progress: 250 },
      ]),
    ).toBe(50)
  })
})

describe('workflow layout', () => {
  it('uses explicit layer/order and centers parallel nodes on z', () => {
    const result = calculateNodePositions({
      ...validWorkflow,
      nodes: [
        validWorkflow.nodes[0],
        { ...validWorkflow.nodes[1], position: { layer: 1, order: 0 } },
        { ...validWorkflow.nodes[1], id: 'test', position: { layer: 1, order: 1 } },
      ],
    })

    expect(result.positions.plan).toMatchObject({ x: 0, y: 0, z: 0, layer: 0, order: 0 })
    expect(result.positions.build.z).toBe(-1.5)
    expect(result.positions.test.z).toBe(1.5)
  })

  it('derives DAG layers when positions are absent', () => {
    const workflow = {
      ...validWorkflow,
      nodes: validWorkflow.nodes.map(({ position: _position, ...node }) => node),
    }
    const result = calculateNodePositions(workflow)

    expect(result.positions.plan.layer).toBe(0)
    expect(result.positions.build.layer).toBe(1)
    expect(result.warnings).toEqual([])
  })

  it('returns positions and a warning even when the graph has a cycle', () => {
    const workflow = {
      ...validWorkflow,
      nodes: validWorkflow.nodes.map(({ position: _position, ...node }) => node),
      edges: [
        { id: 'a', source: 'plan', target: 'build' },
        { id: 'b', source: 'build', target: 'plan' },
      ],
    }
    const result = calculateNodePositions(workflow)

    expect(Object.keys(result.positions)).toHaveLength(2)
    expect(result.warnings[0]).toContain('cycle')
  })

  it('lays out the MVP target of 30 nodes without missing coordinates', () => {
    const nodes = Array.from({ length: 30 }, (_, index) => ({
      ...validWorkflow.nodes[index % validWorkflow.nodes.length],
      id: `node-${index}`,
      name: `Node ${index}`,
      position: undefined,
    }))
    const workflow: WorkflowData = {
      ...validWorkflow,
      nodes,
      edges: nodes.slice(1).map((node, index) => ({
        id: `edge-${index}`,
        source: nodes[index].id,
        target: node.id,
      })),
      events: [],
    }

    const validation = validateWorkflowData(workflow)
    const result = calculateNodePositions(workflow)

    expect(validation.success).toBe(true)
    expect(Object.keys(result.positions)).toHaveLength(30)
    expect(result.positions['node-29'].layer).toBe(29)
  })
})
