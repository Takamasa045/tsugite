import { describe, expect, it } from 'vitest'

import { workflowSamples } from '../data'
import { validateWorkflowData } from './workflow-validator'
import { resolveViewerSamples } from './embedded-workflow'

const embeddedWorkflow = {
  id: 'tsugite-run-001',
  name: 'Tsugite Run 001',
  status: 'running',
  duration: 30,
  nodes: [],
  edges: [],
  events: [],
}

describe('resolveViewerSamples', () => {
  it('埋め込みJSONを単一のViewerサンプルへ変換する', () => {
    const samples = resolveViewerSamples(JSON.stringify(embeddedWorkflow), workflowSamples)

    expect(samples).toEqual([
      {
        id: 'tsugite-embedded-workflow',
        label: 'Tsugite Run 001',
        data: embeddedWorkflow,
        initialTime: 30,
      },
    ])
  })

  it('scriptが存在しない場合だけ既存サンプルへフォールバックする', () => {
    expect(resolveViewerSamples(null, workflowSamples)).toBe(workflowSamples)
  })

  it.each([
    ['壊れたJSON', '{"id":'],
    ['空script', '   \n  '],
  ])('%sはフォールバックせず検証エラーになる入力を返す', (_label, text) => {
    const samples = resolveViewerSamples(text, workflowSamples)

    expect(samples).toHaveLength(1)
    expect(samples).not.toBe(workflowSamples)
    expect(validateWorkflowData(samples[0]?.data).success).toBe(false)
  })

  it('workflow.nameが文字列でなければ既定ラベルを使う', () => {
    const samples = resolveViewerSamples(JSON.stringify({ ...embeddedWorkflow, name: 42 }), workflowSamples)

    expect(samples[0]?.label).toBe('Tsugite workflow')
  })
})
