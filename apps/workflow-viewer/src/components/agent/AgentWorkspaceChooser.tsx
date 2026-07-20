import { FitAddon } from '@xterm/addon-fit'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import xtermModuleUrl from '@xterm/xterm/lib/xterm.mjs?url'
import { Bot, ChevronDown, Play, Square, TerminalSquare } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentHost, AgentHostList, AgentHostId, TsugiteDesktopAgentsBridge } from './agent-bridge'

type AgentLoadState = 'browser' | 'loading' | 'ready' | 'error'
type AgentSessionState = 'idle' | 'starting' | 'running' | 'stopping' | 'exited' | 'error'

const INITIAL_COLS = 96
const INITIAL_ROWS = 28

function hostStatus(host: AgentHost): string {
  return host.detail || (host.installed ? '導入済み' : 'CLIが見つかりません')
}

function loadXterm(): Promise<typeof import('@xterm/xterm')> {
  if (import.meta.env.MODE === 'test') return import('@xterm/xterm')
  return import(/* @vite-ignore */ xtermModuleUrl)
}

interface EmbeddedAgentTerminalProps {
  bridge: TsugiteDesktopAgentsBridge
  host: AgentHost
  onBusyChange: (busy: boolean) => void
  workspaceLabel: string
}

function EmbeddedAgentTerminal({ bridge, host, onBusyChange, workspaceLabel }: EmbeddedAgentTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XtermTerminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const mountedRef = useRef(true)
  const sessionIdRef = useRef<string | null>(null)
  const removeBridgeListenersRef = useRef<(() => void) | null>(null)
  const [sessionState, setSessionState] = useState<AgentSessionState>('idle')
  const [message, setMessage] = useState('開始すると、このフォルダでAIとの対話が始まります。')
  const [terminalReady, setTerminalReady] = useState(false)

  useEffect(() => {
    onBusyChange(['starting', 'running', 'stopping'].includes(sessionState))
  }, [onBusyChange, sessionState])

  useEffect(() => () => onBusyChange(false), [onBusyChange])

  const removeBridgeListeners = useCallback(() => {
    removeBridgeListenersRef.current?.()
    removeBridgeListenersRef.current = null
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    mountedRef.current = true
    let cancelled = false
    let terminal: XtermTerminal | null = null
    let fitAddon: FitAddon | null = null
    let inputSubscription: { dispose(): void } | null = null
    let observer: ResizeObserver | null = null

    void loadXterm().then(({ Terminal }) => {
      if (cancelled) return
      const reduceMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      terminal = new Terminal({
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        convertEol: true,
        cursorBlink: !reduceMotion,
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.35,
        screenReaderMode: true,
        scrollback: 5_000,
        theme: {
          background: '#111310',
          foreground: '#f4eddf',
          cursor: '#c8a878',
          selectionBackground: '#5e4a2f',
        },
      })
      fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.open(container)
      terminalRef.current = terminal
      fitAddonRef.current = fitAddon
      inputSubscription = terminal.onData((data) => {
        const sessionId = sessionIdRef.current
        if (sessionId) {
          void Promise.resolve(bridge.write({ sessionId, data })).catch(() => {
            if (mountedRef.current) setMessage('入力をAIへ送れませんでした。接続を確認して、もう一度入力してください。')
          })
        }
      })
      const fit = () => {
        fitAddon?.fit()
        const sessionId = sessionIdRef.current
        if (sessionId && terminal) {
          void Promise.resolve(bridge.resize({ sessionId, cols: terminal.cols, rows: terminal.rows })).catch(() => undefined)
        }
      }
      observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
      observer?.observe(container)
      setTerminalReady(true)
    }).catch(() => {
      if (!cancelled) {
        setSessionState('error')
        setMessage('内蔵ターミナルを準備できませんでした。Desktopを起動し直してください。')
      }
    })

    return () => {
      cancelled = true
      mountedRef.current = false
      observer?.disconnect()
      inputSubscription?.dispose()
      removeBridgeListeners()
      const sessionId = sessionIdRef.current
      sessionIdRef.current = null
      if (sessionId) void Promise.resolve(bridge.stop({ sessionId })).catch(() => undefined)
      fitAddon?.dispose()
      terminal?.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [bridge, removeBridgeListeners])

  useEffect(() => {
    if (!sessionIdRef.current) return
    setMessage(`${host.label}を切り替えるには、いったん停止してください。`)
  }, [host.id, host.label])

  const start = async () => {
    if (sessionIdRef.current || sessionState === 'starting' || !host.installed || !terminalReady) return
    onBusyChange(true)
    setSessionState('starting')
    setMessage(`${host.label}を開始しています…`)
    let startedSessionId: string | null = null
    const pendingData = new Map<string, string[]>()
    const pendingExits = new Map<string, number>()
    const handleExit = (sessionId: string, exitCode: number) => {
      if (sessionId !== sessionIdRef.current) {
        pendingExits.set(sessionId, exitCode)
        return
      }
      sessionIdRef.current = null
      removeBridgeListeners()
      if (!mountedRef.current) return
      onBusyChange(false)
      setSessionState('exited')
      setMessage(`${host.label}は終了しました（終了コード ${exitCode}）。もう一度開始できます。`)
    }
    const removeData = bridge.onData((event) => {
      if (event.sessionId === sessionIdRef.current) {
        terminalRef.current?.write(event.data)
        return
      }
      const buffered = pendingData.get(event.sessionId) ?? []
      if (buffered.join('').length < 64 * 1024) buffered.push(event.data)
      pendingData.set(event.sessionId, buffered)
    })
    const removeExit = bridge.onExit((event) => handleExit(event.sessionId, event.exitCode))
    removeBridgeListenersRef.current = () => {
      removeData()
      removeExit()
    }
    try {
      fitAddonRef.current?.fit()
      const terminal = terminalRef.current
      const cols = terminal?.cols ?? INITIAL_COLS
      const rows = terminal?.rows ?? INITIAL_ROWS
      const result = await bridge.start({ hostId: host.id, cols, rows })
      startedSessionId = result.sessionId
      if (!mountedRef.current) {
        removeBridgeListeners()
        void Promise.resolve(bridge.stop({ sessionId: result.sessionId })).catch(() => undefined)
        return
      }
      sessionIdRef.current = result.sessionId
      for (const data of pendingData.get(result.sessionId) ?? []) terminalRef.current?.write(data)
      const earlyExitCode = pendingExits.get(result.sessionId)
      if (earlyExitCode !== undefined) {
        handleExit(result.sessionId, earlyExitCode)
        return
      }
      setSessionState('running')
      setMessage(`${host.label}と作業中`)
      terminalRef.current?.focus()
    } catch {
      if (startedSessionId && sessionIdRef.current === startedSessionId) {
        void Promise.resolve(bridge.stop({ sessionId: startedSessionId })).catch(() => undefined)
      }
      sessionIdRef.current = null
      removeBridgeListeners()
      if (mountedRef.current) {
        onBusyChange(false)
        setSessionState('error')
        setMessage(`${host.label}を開始できませんでした。導入状況を確認して、もう一度お試しください。`)
      }
    }
  }

  const stop = async () => {
    const sessionId = sessionIdRef.current
    if (!sessionId || sessionState === 'stopping') return
    setSessionState('stopping')
    setMessage(`${host.label}を停止しています…`)
    try {
      await bridge.stop({ sessionId })
      sessionIdRef.current = null
      removeBridgeListeners()
      onBusyChange(false)
      setSessionState('idle')
      setMessage(`${host.label}を停止しました。必要なら、もう一度開始できます。`)
    } catch {
      if (sessionIdRef.current === sessionId) {
        setSessionState('running')
        setMessage(`${host.label}を停止できませんでした。もう一度停止してください。`)
      } else {
        onBusyChange(false)
        setSessionState('exited')
        setMessage(`${host.label}は終了しました。もう一度開始できます。`)
      }
    }
  }

  const isRunning = ['running', 'stopping'].includes(sessionState)

  return (
    <div className="launcher-agent-terminal">
      <div className="launcher-agent-terminal-bar">
        <div>
          <span aria-hidden="true" className="launcher-agent-terminal-lamps"><i /><i /><i /></span>
          <strong>{host.label}</strong>
          <small>作業フォルダ：{workspaceLabel}</small>
        </div>
        {isRunning ? (
          <button disabled={sessionState === 'stopping'} onClick={() => void stop()} type="button">
            <Square aria-hidden="true" size={14} />
            {sessionState === 'stopping' ? '停止中…' : `${host.label}を停止`}
          </button>
        ) : (
          <button disabled={sessionState === 'starting' || !host.installed || !terminalReady} onClick={() => void start()} type="button">
            <Play aria-hidden="true" size={14} />
            {!terminalReady ? '端末準備中…' : sessionState === 'starting' ? '開始中…' : `${host.label}を開始`}
          </button>
        )}
      </div>
      <div
        aria-label={`${host.label}の端末`}
        className="launcher-agent-terminal-screen"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.currentTarget === event.target) terminalRef.current?.focus()
        }}
        ref={containerRef}
        role="region"
        tabIndex={0}
      />
      <p aria-live="polite" className="launcher-agent-terminal-status" data-state={sessionState}>{message}</p>
    </div>
  )
}

export function AgentWorkspaceChooser() {
  const bridge = window.tsugiteDesktop?.agents
  const [loadState, setLoadState] = useState<AgentLoadState>(bridge ? 'loading' : 'browser')
  const [hostList, setHostList] = useState<AgentHostList | null>(null)
  const [selectedHostId, setSelectedHostId] = useState<AgentHostId | null>(null)
  const [terminalBusy, setTerminalBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!bridge) return
    let active = true
    void bridge.list().then((result) => {
      if (!active) return
      setHostList(result)
      setSelectedHostId(result.hosts.find((host) => host.installed)?.id ?? result.hosts[0]?.id ?? null)
      setLoadState('ready')
    }).catch(() => {
      if (active) setLoadState('error')
    })
    return () => { active = false }
  }, [bridge])

  const selectedHost = useMemo(() => (
    hostList?.hosts.find((host) => host.id === selectedHostId)
      ?? hostList?.hosts.find((host) => host.installed)
      ?? null
  ), [hostList, selectedHostId])
  const embeddedAvailable = Boolean(bridge && hostList?.hosts.some((host) => host.installed))

  return (
    <section aria-label="AI CLI（必要なときだけ）" className="launcher-agent-workspace">
      <button
        aria-controls="launcher-agent-workspace-content"
        aria-expanded={expanded}
        className="launcher-agent-toggle"
        disabled={terminalBusy}
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <TerminalSquare aria-hidden="true" size={18} />
        <span>
          <strong>{terminalBusy ? 'AI CLIで作業中' : '必要なときだけAI CLIを使う'}</strong>
          <small>Codex / Claudeをこのアプリ内で開く補助機能です</small>
        </span>
        <ChevronDown aria-hidden="true" className={expanded ? 'is-open' : undefined} size={17} />
      </button>

      {expanded && (
        <div className="launcher-agent-workspace-content" id="launcher-agent-workspace-content">
          <p className="launcher-agent-quiet-note"><strong>普段はこの確認画面だけで使えます。</strong> 外部のCodexやClaudeを使う場合も、この画面を並べるだけで十分です。</p>
          {loadState === 'loading' && <p className="launcher-agent-inline-status">AI CLIの利用状況を確認しています…</p>}
          {loadState === 'error' && <p className="launcher-agent-inline-status" role="alert">AI CLIの利用状況を確認できません。Desktopを起動し直してください。</p>}
          {loadState === 'browser' && <p className="launcher-agent-inline-status">ブラウザでは内蔵ターミナルを利用できません。いつものCodexまたはClaudeと、この確認画面を並べて使えます。</p>}
          {loadState === 'ready' && !embeddedAvailable && <p className="launcher-agent-inline-status">利用できるAI CLIが見つかりません。必要な場合だけ導入してください。</p>}

          {bridge && loadState === 'ready' && hostList && (
        <section aria-label="内蔵AIターミナル" className="launcher-agent-console">
          <div className="launcher-agent-console-heading">
            <div>
              <Bot aria-hidden="true" size={19} />
              <span><strong>使うAIを選ぶ</strong><small>作業中は切り替えず、停止してから選び直します。</small></span>
            </div>
            <span>作業フォルダ：{hostList.workspaceLabel}</span>
          </div>
          <fieldset className="launcher-agent-hosts">
            <legend className="sr-only">内蔵ターミナルで使うAI</legend>
            {hostList.hosts.map((host) => (
              <label key={host.id}>
                <input
                  checked={host.id === selectedHost?.id}
                  disabled={terminalBusy || !host.installed}
                  name="launcher-agent-host"
                  onChange={() => setSelectedHostId(host.id)}
                  type="radio"
                  value={host.id}
                />
                <span><strong>{host.label}</strong><small>{hostStatus(host)}</small></span>
              </label>
            ))}
          </fieldset>
          <p className="launcher-agent-capability-note">ここではCLIの導入だけを確認します。ログインや契約状態は、開始後の案内で確認してください。</p>
          {selectedHost?.installed ? (
            <EmbeddedAgentTerminal
              bridge={bridge}
              host={selectedHost}
              key={selectedHost.id}
              onBusyChange={setTerminalBusy}
              workspaceLabel={hostList.workspaceLabel}
            />
          ) : (
            <p className="launcher-agent-no-host">内蔵ターミナルを使うには、Codex CLIまたはClaude Codeを導入してください。</p>
          )}
        </section>
      )}
        </div>
      )}
    </section>
  )
}
