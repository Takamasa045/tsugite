import { Pause, Play, RotateCcw } from 'lucide-react'
import { getStatusConfig } from '../../lib/status-config'
import type { WorkflowData, WorkflowNode } from '../../types/workflow'

interface TimelinePanelProps {
  workflow: WorkflowData
  currentNodes: WorkflowNode[]
  selectedNodeId: string | null
  currentTime: number
  isPlaying: boolean
  playbackSpeed: number
  onSelectNode: (nodeId: string) => void
  onTogglePlaying: (playing: boolean) => void
  onReset: () => void
  onSeek: (time: number) => void
  onSpeedChange: (speed: number) => void
}

function formatTime(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function TimelinePanel({
  workflow,
  currentNodes,
  selectedNodeId,
  currentTime,
  isPlaying,
  playbackSpeed,
  onSelectNode,
  onTogglePlaying,
  onReset,
  onSeek,
  onSpeedChange,
}: TimelinePanelProps) {
  const duration = Math.max(0, workflow.duration)

  return (
    <section aria-label="タイムライン操作" className="timeline-panel">
      <div className="stage-beam">
        <div className="stage-beam-heading">
          <div>
            <span className="eyebrow">制作の流れ · WORKFLOW</span>
            <strong>見たい工程を選んでください</strong>
          </div>
          <p>選ぶと、右側に作ったものと確認内容が表示されます。</p>
        </div>
        <ol aria-label="工程一覧" className="stage-list">
          {currentNodes.map((node, index) => {
            const status = getStatusConfig(node.status)
            const selected = node.id === selectedNodeId
            return (
              <li key={node.id}>
                <button
                  aria-label={`${node.name}の工程詳細を表示`}
                  aria-pressed={selected}
                  className="stage-joint"
                  data-selected={selected ? 'true' : 'false'}
                  data-status={node.status}
                  onClick={() => onSelectNode(node.id)}
                  type="button"
                >
                  <span className="stage-number">工程 {String(index + 1).padStart(2, '0')}</span>
                  <strong>{node.name}</strong>
                  <span className="stage-status"><i aria-hidden="true">{status.symbol}</i>{status.label}</span>
                </button>
              </li>
            )
          })}
        </ol>
      </div>

      <div className="transport-controls">
        <button aria-label="先頭に戻る" className="icon-button" onClick={onReset} type="button">
          <RotateCcw aria-hidden="true" size={17} />
        </button>
        <button
          aria-label={isPlaying ? '一時停止' : '再生'}
          className="play-button"
          onClick={() => onTogglePlaying(!isPlaying)}
          type="button"
        >
          {isPlaying ? <Pause aria-hidden="true" size={17} /> : <Play aria-hidden="true" size={17} fill="currentColor" />}
        </button>
      </div>

      <div className="timeline-main">
        <div className="timeline-meta">
          <span className="eyebrow">記録時刻 · PLAYBACK</span>
          <output aria-live="off">{formatTime(currentTime)} / {formatTime(duration)}</output>
        </div>
        <div className="timeline-rail">
          <div aria-hidden="true" className="event-markers">
            {workflow.events.map((event, index) => (
              <span
                data-testid="event-marker"
                key={`${event.nodeId}-${event.time}-${index}`}
                style={{ left: `${duration > 0 ? (event.time / duration) * 100 : 0}%` }}
                title={`${formatTime(event.time)} · ${event.nodeId} · ${event.status}`}
              />
            ))}
          </div>
          <input
            aria-label="タイムライン"
            max={duration}
            min={0}
            onChange={(event) => onSeek(Number(event.target.value))}
            step={1}
            type="range"
            value={Math.min(duration, Math.max(0, currentTime))}
          />
        </div>
      </div>

      <label className="speed-control">
        <span>再生速度</span>
        <select value={playbackSpeed} onChange={(event) => onSpeedChange(Number(event.target.value))}>
          {[0.5, 1, 2, 4].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
        </select>
      </label>
    </section>
  )
}
