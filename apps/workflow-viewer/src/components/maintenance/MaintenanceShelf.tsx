import { MediaFinalizePanel } from './MediaFinalizePanel'
import { WorktreeCleanupPanel } from './WorktreeCleanupPanel'
import type { FinalizeProjectOption } from './maintenanceModel'

export type MaintenanceShelfProps = {
  token: string
  projects: readonly FinalizeProjectOption[]
  fetcher?: typeof fetch
}

/**
 * 「安全な整理」棚。
 * Git worktree 整理と完成案件 media finalize を別パネル・別承認に分離する。
 */
export function MaintenanceShelf({
  token,
  projects,
  fetcher = fetch,
}: MaintenanceShelfProps) {
  return (
    <section
      aria-labelledby="launcher-maintenance-heading"
      className="maintenance-shelf"
      id="launcher-maintenance-panel"
      role="tabpanel"
    >
      <header className="maintenance-shelf__header">
        <h2 id="launcher-maintenance-heading">安全な整理</h2>
        <p>
          作業場所の削除と完成作品のメディア整理は別操作です。
          どちらも Preview → Review → 明示 Apply のあと、再確認して記録します。一括削除はありません。
        </p>
      </header>

      <div className="maintenance-shelf__grid">
        <WorktreeCleanupPanel fetcher={fetcher} token={token} />
        <MediaFinalizePanel fetcher={fetcher} projects={projects} token={token} />
      </div>
    </section>
  )
}
