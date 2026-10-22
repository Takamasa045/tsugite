import { ChevronDown, TerminalSquare } from 'lucide-react'
import { useState } from 'react'

export function AgentWorkspaceChooser() {
  const [expanded, setExpanded] = useState(false)

  return (
    <section aria-label="AI CLI（必要なときだけ）" className="launcher-agent-workspace">
      <button
        aria-controls="launcher-agent-workspace-content"
        aria-expanded={expanded}
        className="launcher-agent-toggle"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <TerminalSquare aria-hidden="true" size={18} />
        <span>
          <strong>必要なときだけAI CLIを使う</strong>
          <small>外部のCodex / Claudeと、この確認画面を並べて使います</small>
        </span>
        <ChevronDown aria-hidden="true" className={expanded ? 'is-open' : undefined} size={17} />
      </button>
      {expanded && (
        <div className="launcher-agent-workspace-content" id="launcher-agent-workspace-content">
          <p className="launcher-agent-quiet-note"><strong>普段はこの確認画面だけで使えます。</strong> 外部のCodexやClaudeを使う場合も、この画面を並べるだけで十分です。</p>
          <p className="launcher-agent-inline-status">いつものCodexまたはClaudeと、この確認画面を並べて使えます。</p>
        </div>
      )}
    </section>
  )
}
