export interface DesktopWorkspaceInfo {
  label: string
}

export type DesktopWorkspaceSelectionResult = {
  status: 'busy' | 'canceled' | 'unchanged' | 'restarting'
  workspace: DesktopWorkspaceInfo
}

export interface TsugiteDesktopWorkspaceBridge {
  current(): Promise<DesktopWorkspaceInfo>
  select(): Promise<DesktopWorkspaceSelectionResult>
}
