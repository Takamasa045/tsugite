import type { TsugiteDesktopAgentsBridge } from './components/agent/agent-bridge'
import type { TsugiteDesktopWorkspaceBridge } from './components/workspace/workspace-bridge'

declare global {
  interface Window {
    tsugiteDesktop?: {
      agents?: TsugiteDesktopAgentsBridge
      workspace?: TsugiteDesktopWorkspaceBridge
    }
  }
}

export {}
