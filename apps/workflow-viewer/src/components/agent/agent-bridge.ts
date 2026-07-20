export type AgentHostId = 'codex' | 'claude'

export interface AgentHost {
  id: AgentHostId
  label: string
  installed: boolean
  detail: string
}

export interface AgentHostList {
  workspaceLabel: string
  hosts: AgentHost[]
}

export interface AgentSessionEvent {
  sessionId: string
  data: string
}

export interface AgentExitEvent {
  sessionId: string
  exitCode: number
}

export interface TsugiteDesktopAgentsBridge {
  list(): Promise<AgentHostList>
  start(input: { hostId: AgentHostId; cols: number; rows: number }): Promise<{ sessionId: string }>
  write(input: { sessionId: string; data: string }): Promise<void> | void
  resize(input: { sessionId: string; cols: number; rows: number }): Promise<void> | void
  stop(input: { sessionId: string }): Promise<void> | void
  onData(listener: (event: AgentSessionEvent) => void): () => void
  onExit(listener: (event: AgentExitEvent) => void): () => void
}
