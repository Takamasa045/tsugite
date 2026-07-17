import { ArrowDownToLine, ArrowUpFromLine, ChevronRight, ExternalLink, X } from 'lucide-react'
import type {
  WorkflowData,
  WorkflowDetailItem,
  WorkflowMediaPreview,
  WorkflowNode,
} from '../../types/workflow'
import { ProgressBar } from './ProgressBar'
import { StatusBadge } from './StatusBadge'

interface NodeDetailsProps {
  workflow: WorkflowData
  node: WorkflowNode
  currentNodes: WorkflowNode[]
  onSelectNode: (nodeId: string | null) => void
}

function formatSeconds(value?: number) {
  if (value === undefined) return '—'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function DataList({ details, icon: Icon, label, values }: {
  details?: WorkflowDetailItem[]
  icon: typeof ArrowDownToLine
  label: string
  values: string[]
}) {
  return (
    <div className="node-data-group">
      <h3><Icon aria-hidden="true" size={14} />{label}</h3>
      {details?.length ? (
        <div className="artifact-list">
          {details.map((item) => (
            <article className="artifact-card" key={`${item.label}-${item.reference ?? ''}`}>
              <strong>{item.label}</strong>
              <p>{item.description}</p>
              {item.facts?.length ? (
                <ul>{item.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
              ) : null}
              {item.href ? (
                <a
                  aria-label={`${item.label}のプレビューHTMLを開く`}
                  className="artifact-link"
                  href={item.href}
                  rel="noreferrer"
                  target="_blank"
                >
                  プレビューHTMLを開く
                  <ExternalLink aria-hidden="true" size={14} />
                </a>
              ) : null}
            </article>
          ))}
        </div>
      ) : values.length ? (
        <ul className="token-list">{values.map((value) => <li key={value}>{value}</li>)}</ul>
      ) : <p className="empty-copy">なし</p>}
    </div>
  )
}

function MediaPreview({ preview }: { preview: WorkflowMediaPreview }) {
  return (
    <figure className={`media-card media-${preview.kind}`}>
      {preview.kind === 'video' ? (
        <video aria-label={`${preview.label}を再生`} controls playsInline preload="metadata" src={preview.src} />
      ) : null}
      {preview.kind === 'image' ? (
        <a aria-label={`${preview.label}を大きく見る`} href={preview.src} rel="noreferrer" target="_blank">
          <img alt={preview.label} loading="lazy" src={preview.src} />
        </a>
      ) : null}
      {preview.kind === 'audio' ? (
        <audio aria-label={`${preview.label}を再生`} controls preload="metadata" src={preview.src} />
      ) : null}
      <figcaption>
        <strong>{preview.label}</strong>
        <span>{preview.description}</span>
      </figcaption>
    </figure>
  )
}

function MediaPreviewGallery({ previews }: { previews?: WorkflowMediaPreview[] }) {
  if (!previews?.length) return null
  return (
    <section aria-labelledby="media-preview-title" className="media-preview-section">
      <div className="section-intro">
        <div>
          <span className="eyebrow">成果物プレビュー</span>
          <h3 id="media-preview-title">実際に作ったもの</h3>
        </div>
        <span className="media-count">{previews.length}点</span>
      </div>
      <p className="section-help">画像はクリックで拡大、映像と音声はその場で再生できます。</p>
      <div className="media-preview-grid">
        {previews.map((preview) => <MediaPreview key={preview.id} preview={preview} />)}
      </div>
    </section>
  )
}

function formatDecisionTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date)
}

function ApprovalLedger({ node }: { node: WorkflowNode }) {
  const approval = node.details?.approval
  if (!approval) return null
  const decided = node.status === 'completed' || node.status === 'error' || node.status === 'skipped'
  return (
    <section className="approval-ledger" aria-label="承認判断の詳細">
      <div className="approval-subject">
        <h3>{decided ? '承認した内容' : '承認する内容'}</h3>
        <strong>{approval.subject}</strong>
      </div>
      <div className="approval-checks">
        <h3>{decided ? '確認したポイント' : '承認前に確認するポイント'}</h3>
        <ul>{approval.checkpoints.map((checkpoint) => <li key={checkpoint}>{checkpoint}</li>)}</ul>
      </div>
      <div className="approval-decision" data-status={node.status}>
        <span>{decided ? '判断結果' : '現在の判断'}</span>
        <strong>{approval.decision}</strong>
        {approval.decidedAt ? <time dateTime={approval.decidedAt}>判断日時: {formatDecisionTime(approval.decidedAt)}</time> : null}
      </div>
    </section>
  )
}

const workStateCopy: Record<WorkflowNode['status'], { title: string; note: string }> = {
  pending: { title: '次に行う作業', note: '前の工程が終わると、この作業を始めます。' },
  queued: { title: '開始待ち', note: '実行の順番を待っています。' },
  thinking: { title: '内容を検討中', note: '制作方針と条件を整理しています。' },
  running: { title: 'ただいま作業中', note: 'この工程を進めています。' },
  waiting_approval: { title: 'あなたの確認待ち', note: '内容を確認し、進めてよいか判断してください。' },
  testing: { title: '品質を確認中', note: '作ったものに問題がないか確認しています。' },
  completed: { title: 'この工程は完了', note: '作業結果を次の工程へ渡しました。' },
  error: { title: '確認・修正が必要', note: '問題の内容を確認し、再開できる状態にしてください。' },
  skipped: { title: '今回は実施なし', note: 'この実行では工程を省略しました。' },
}

function explanationLabels(status: WorkflowNode['status']): { activity: string; outcome: string } {
  if (status === 'completed' || status === 'error' || status === 'skipped') {
    return { activity: '行ったこと', outcome: '結果' }
  }
  if (status === 'running' || status === 'thinking') {
    return { activity: '今行っていること', outcome: '現在の状況' }
  }
  if (status === 'waiting_approval' || status === 'testing') {
    return { activity: '今確認していること', outcome: '現在の状況' }
  }
  return { activity: 'これから行うこと', outcome: '現在の状況' }
}

function TechnicalReferences({ details }: { details?: WorkflowDetailItem[] }) {
  const references = details?.filter((item) => item.reference) ?? []
  if (references.length === 0) return null
  return (
    <div className="detail-group reference-group">
      <h3>技術参照</h3>
      <ul>{references.map((item) => (
        <li key={`${item.label}-${item.reference}`}>
          <code>技術参照: {item.reference}</code>
        </li>
      ))}</ul>
    </div>
  )
}

export function NodeDetails({ workflow, node, currentNodes, onSelectNode }: NodeDetailsProps) {
  const dependencies = workflow.edges
    .filter((edge) => edge.source === node.id || edge.target === node.id)
    .map((edge) => {
      const isPrevious = edge.target === node.id
      const relatedId = isPrevious ? edge.source : edge.target
      return { direction: isPrevious ? '前工程' : '次工程', node: currentNodes.find((item) => item.id === relatedId) }
    })
    .filter((item): item is { direction: string; node: WorkflowNode } => Boolean(item.node))
  const errorLogs = node.logs.filter((log) => log.level === 'error')
  const workState = workStateCopy[node.status]
  const sectionLabels = explanationLabels(node.status)
  const technicalReferences = [...(node.details?.inputs ?? []), ...(node.details?.outputs ?? [])]

  return (
    <section aria-labelledby="node-details-title" className="panel-section node-details">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">制作の記録</span>
          <h2 id="node-details-title">{node.name}</h2>
        </div>
        <button aria-label="詳細を閉じる" className="icon-button" onClick={() => onSelectNode(null)} type="button">
          <X aria-hidden="true" size={17} />
        </button>
      </div>

      <div className="node-status-row">
        <StatusBadge status={node.status} />
        <span className="agent-name">担当: {node.agent ?? '自動処理'}</span>
      </div>
      <div aria-live="polite" className="work-state-card" data-status={node.status}>
        <span>{workState.title}</span>
        <strong>{node.details?.outcome ?? node.description ?? '説明は登録されていません。'}</strong>
        <p>{workState.note}</p>
      </div>

      <MediaPreviewGallery previews={node.details?.previews} />
      <ApprovalLedger node={node} />

      {node.details ? (
        <div className="work-explanation" aria-label="工程の説明">
          <div><span>何のための工程？</span><p>{node.details.purpose}</p></div>
          <div><span>{sectionLabels.activity}</span><p>{node.details.activity}</p></div>
          <div className="work-outcome"><span>{sectionLabels.outcome}</span><p>{node.details.outcome}</p></div>
        </div>
      ) : null}
      <ProgressBar label={`${node.name}の進捗`} showValue value={node.progress} />

      {errorLogs.length ? (
        <div className="error-callout" role="alert">
          <strong>問題が見つかりました</strong>
          {errorLogs.map((log) => <p key={`${log.time}-${log.message}`}>{log.message}</p>)}
        </div>
      ) : null}

      <div className={node.details ? 'io-ledger' : 'io-grid'}>
        <DataList details={node.details?.inputs} icon={ArrowDownToLine} label="受け取ったもの" values={node.inputs} />
        <DataList details={node.details?.outputs} icon={ArrowUpFromLine} label="次へ渡したもの" values={node.outputs} />
      </div>

      <details className="technical-details">
        <summary>詳しい情報</summary>
        <div className="technical-details-body">
          <p className="technical-name">内部工程: {node.technicalName ?? node.name} / 種類: {node.type}</p>
          <dl className="metadata-list compact">
            <div><dt>開始</dt><dd>{formatSeconds(node.startedAt)}</dd></div>
            <div><dt>終了</dt><dd>{formatSeconds(node.completedAt)}</dd></div>
          </dl>
          <TechnicalReferences details={technicalReferences} />

          <div className="detail-group">
            <h3>前後の工程</h3>
            {dependencies.length ? (
              <div className="dependency-list">
                {dependencies.map(({ direction, node: dependency }) => (
                  <button
                    aria-label={`${dependency.name}を選択`}
                    key={`${direction}-${dependency.id}`}
                    onClick={() => onSelectNode(dependency.id)}
                    type="button"
                  >
                    <span><small>{direction}</small>{dependency.name}</span>
                    <ChevronRight aria-hidden="true" size={15} />
                  </button>
                ))}
              </div>
            ) : <p className="empty-copy">接続されたノードはありません。</p>}
          </div>

          <div className="detail-group log-group">
            <h3>作業記録 <span>{node.logs.length}</span></h3>
            {node.logs.length ? (
              <ol>
                {node.logs.map((log) => (
                  <li data-level={log.level} key={`${log.time}-${log.message}`}>
                    <time>{formatSeconds(log.time)}</time>
                    <p>{log.message}</p>
                  </li>
                ))}
              </ol>
            ) : <p className="empty-copy">この時点までの作業記録はありません。</p>}
          </div>
        </div>
      </details>
    </section>
  )
}
