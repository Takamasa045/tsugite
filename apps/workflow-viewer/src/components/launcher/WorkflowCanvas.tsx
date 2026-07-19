import type { KeyboardEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import './workflow-canvas.css'

export type WorkflowCanvasStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'error'

export interface WorkflowCanvasNode {
  id: string
  label: string
  status: WorkflowCanvasStatus
  action?: string
  description?: string
}

export interface WorkflowCanvasJob {
  id?: string
  action?: string
  status?: WorkflowCanvasStatus
  progress?: number
  message?: string
}

export interface WorkflowCanvasProps {
  nodes: WorkflowCanvasNode[]
  activeAction?: string | null
  activeJob?: WorkflowCanvasJob | null
  onSelect?: (node: WorkflowCanvasNode) => void
  ariaLabel?: string
}

const STATUS_LABELS: Record<WorkflowCanvasStatus, string> = {
  pending: '未着手',
  running: '実行中',
  waiting_approval: '確認待ち',
  completed: '完了',
  error: 'エラー',
}

const STATUS_PRIORITY: WorkflowCanvasStatus[] = [
  'running',
  'waiting_approval',
  'error',
  'pending',
  'completed',
]

function preferredNodeId(nodes: WorkflowCanvasNode[], activeAction?: string | null): string | null {
  if (activeAction) {
    const activeNode = nodes.find((node) => node.id === activeAction || node.action === activeAction)
    if (activeNode) return activeNode.id
  }

  for (const status of STATUS_PRIORITY) {
    const node = nodes.find((candidate) => candidate.status === status)
    if (node) return node.id
  }

  return null
}

function normalizedProgress(progress?: number): number | null {
  if (progress === undefined || !Number.isFinite(progress)) return null
  return Math.min(100, Math.max(0, Math.round(progress)))
}

export function WorkflowCanvas({
  nodes,
  activeAction,
  activeJob,
  onSelect,
  ariaLabel = '制作工程',
}: WorkflowCanvasProps) {
  const preferredId = useMemo(
    () => preferredNodeId(nodes, activeAction),
    [activeAction, nodes],
  )
  const [selectedId, setSelectedId] = useState<string | null>(preferredId)
  const nodeButtons = useRef<Array<HTMLButtonElement | null>>([])
  const nodeIds = nodes.map((node) => node.id).join('\u0000')

  useEffect(() => {
    setSelectedId((current) => {
      if (current && nodes.some((node) => node.id === current)) return current
      return preferredId
    })
  }, [nodeIds, nodes, preferredId])

  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null
  const progress = normalizedProgress(activeJob?.progress)

  const selectNode = (node: WorkflowCanvasNode) => {
    setSelectedId(node.id)
    onSelect?.(node)
  }

  const handleNodeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = Math.min(index + 1, nodes.length - 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = Math.max(index - 1, 0)
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = nodes.length - 1
    }

    if (nextIndex === null || nextIndex === index) return

    event.preventDefault()
    const nextNode = nodes[nextIndex]
    if (!nextNode) return
    selectNode(nextNode)
    nodeButtons.current[nextIndex]?.focus()
  }

  return (
    <section className="workflow-canvas" aria-label={ariaLabel}>
      <header className="workflow-canvas__header">
        <div>
          <p className="workflow-canvas__eyebrow">WORKFLOW MAP</p>
          <h2>制作工程</h2>
        </div>
        {activeJob ? (
          <div className="workflow-canvas__job" data-status={activeJob.status ?? 'pending'}>
            <span>{activeJob.status ? STATUS_LABELS[activeJob.status] : 'ジョブ'}</span>
            <strong>{activeJob.message ?? activeJob.action ?? activeJob.id ?? '処理状況を確認中'}</strong>
            {progress !== null ? (
              <div
                className="workflow-canvas__progress"
                role="progressbar"
                aria-label="ジョブ進捗"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
              >
                <i style={{ width: `${progress}%` }} />
                <small>{progress}%</small>
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      {nodes.length > 0 ? (
        <div className="workflow-canvas__viewport" tabIndex={0} aria-label="制作工程を横にスクロール">
          <ol className="workflow-canvas__track">
            {nodes.map((node, index) => {
              const selected = node.id === selectedNode?.id
              const active = node.id === activeAction || node.action === activeAction

              return (
                <li className="workflow-canvas__step" key={node.id}>
                  <button
                    ref={(element) => { nodeButtons.current[index] = element }}
                    type="button"
                    className="workflow-canvas__node"
                    data-status={node.status}
                    data-active={active || undefined}
                    aria-pressed={selected}
                    aria-label={`${node.label}、${STATUS_LABELS[node.status]}`}
                    onClick={() => selectNode(node)}
                    onKeyDown={(event) => handleNodeKeyDown(event, index)}
                  >
                    <span className="workflow-canvas__node-mark" aria-hidden="true" />
                    <strong>{node.label}</strong>
                    <small>{STATUS_LABELS[node.status]}</small>
                    {node.action ? <code>{node.action}</code> : null}
                  </button>
                  {index < nodes.length - 1 ? (
                    <span
                      className="workflow-canvas__connector"
                      data-completed={node.status === 'completed' || undefined}
                      aria-hidden="true"
                    />
                  ) : null}
                </li>
              )
            })}
          </ol>
        </div>
      ) : (
        <p className="workflow-canvas__empty">表示できる制作工程がありません。</p>
      )}

      {selectedNode ? (
        <aside className="workflow-canvas__detail" aria-live="polite">
          <div>
            <span data-status={selectedNode.status}>{STATUS_LABELS[selectedNode.status]}</span>
            <h3>{selectedNode.label}</h3>
          </div>
          <p>{selectedNode.description ?? 'この工程の詳しい説明はまだありません。'}</p>
          {selectedNode.action ? (
            <dl>
              <dt>操作</dt>
              <dd><code>{selectedNode.action}</code></dd>
            </dl>
          ) : null}
        </aside>
      ) : null}
    </section>
  )
}
