import type { TsugiteDesktopAgentsBridge } from './components/agent/agent-bridge'

declare global {
  interface Window {
    tsugiteDesktop?: {
      agents?: TsugiteDesktopAgentsBridge
    }
  }
}

export {}
