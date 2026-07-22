import { FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'

import type {
  DesktopWorkspaceInfo,
  DesktopWorkspaceSelectionResult,
} from './workspace-bridge'

function isWorkspaceInfo(input: unknown): input is DesktopWorkspaceInfo {
  return typeof input === 'object' && input !== null
    && 'label' in input && typeof input.label === 'string' && input.label.length > 0
}

function isWorkspaceSelectionResult(input: unknown): input is DesktopWorkspaceSelectionResult {
  return typeof input === 'object' && input !== null
    && 'status' in input
    && ['busy', 'canceled', 'unchanged', 'restarting'].includes(String(input.status))
    && 'workspace' in input && isWorkspaceInfo(input.workspace)
}

export function DesktopWorkspaceRecovery() {
  const bridge = window.tsugiteDesktop?.workspace
  const [workspace, setWorkspace] = useState<DesktopWorkspaceInfo | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!bridge) return
    let active = true
    void bridge.current().then((result: unknown) => {
      if (!active || !isWorkspaceInfo(result)) return
      setWorkspace(result)
    }).catch(() => {
      if (active) setError('現在のworkspaceを確認できません。Desktopを起動し直してください。')
    })
    return () => { active = false }
  }, [bridge])

  if (!bridge) return null

  const selectWorkspace = async () => {
    if (selecting || restarting) return
    setSelecting(true)
    setNotice(null)
    setError(null)
    let restartPending = false
    try {
      const result: unknown = await bridge.select()
      if (!isWorkspaceSelectionResult(result)) throw new Error('invalid workspace selection result')
      setWorkspace(result.workspace)
      if (result.status === 'busy') {
        setError('実行中の処理があります。AI CLIや制作処理を停止してから選び直してください。')
      } else if (result.status === 'canceled') {
        setNotice('workspaceの変更をキャンセルしました。')
      } else if (result.status === 'unchanged') {
        setNotice('現在と同じworkspaceが選ばれています。')
      } else {
        restartPending = true
        setRestarting(true)
        setNotice('workspaceを切り替えるためDesktopを再起動します…')
      }
    } catch {
      setError('workspaceを切り替えられませんでした。別の専用フォルダを選んで、もう一度お試しください。')
    } finally {
      if (!restartPending) setSelecting(false)
    }
  }

  return (
    <section aria-label="Desktop workspaceの復旧" className="launcher-workspace-recovery">
      <p>{workspace ? `現在のworkspace：${workspace.label}` : '現在のworkspaceを確認しています…'}</p>
      <button
        aria-busy={selecting || restarting}
        className="launcher-secondary"
        disabled={selecting || restarting}
        onClick={() => void selectWorkspace()}
        type="button"
      >
        <FolderOpen aria-hidden="true" size={16} />
        {restarting ? 'Desktopを再起動しています…' : selecting ? '選択画面を開いています…' : 'workspaceを選び直す'}
      </button>
      {notice && <p className="launcher-workspace-recovery-status" role="status">{notice}</p>}
      {error && <p className="launcher-workspace-recovery-error" role="alert">{error}</p>}
    </section>
  )
}
