import { describe, expect, it } from 'vitest'

import type { WorkflowNode } from '../types/workflow'
import { getFocusCopy, getFocusNode } from './workflow-presentation'

function node(id: string, status: WorkflowNode['status']): WorkflowNode {
  return { id, name: id, type: 'task', status, progress: 0, inputs: [], outputs: [], logs: [] }
}

describe('workflow presentation', () => {
  it('問題、承認待ち、作業中の順で現在地を優先する', () => {
    expect(getFocusNode([node('待機', 'pending'), node('作業中', 'running'), node('問題', 'error')])?.name).toBe('問題')
    expect(getFocusNode([node('待機', 'pending'), node('承認', 'waiting_approval'), node('作業中', 'running')])?.name).toBe('承認')
    expect(getFocusNode([node('待機', 'pending'), node('作業中', 'thinking')])?.name).toBe('作業中')
  })

  it('進行状況を人向けの案内文へ変換する', () => {
    expect(getFocusCopy(node('書き出し', 'error')).summary).toBe('いま確認が必要な工程：書き出し')
    expect(getFocusCopy(node('素材確認', 'waiting_approval')).summary).toBe('承認を待っている工程：素材確認')
    expect(getFocusCopy(node('編集', 'testing')).summary).toBe('いま進めている工程：編集')
    expect(getFocusCopy(node('公開', 'queued')).summary).toBe('次に始まる工程：公開')
    expect(getFocusCopy(node('完了', 'completed')).summary).toBe('最後に完了した工程：完了')
    expect(getFocusCopy()).toEqual(expect.objectContaining({ label: '工程はまだありません' }))
  })

  it('完了だけの場合は最後の完了工程を表示する', () => {
    expect(getFocusNode([node('工程1', 'completed'), node('工程2', 'completed')])?.name).toBe('工程2')
    expect(getFocusNode([])).toBeUndefined()
  })
})
