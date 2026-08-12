/**
 * R3: unmocked writeWorkflowViewer → real App parser/render chain.
 * Fixture-only: no provider, network, billing, Gate mutation, finalize apply.
 * Does not invent test-only digests on the Mission Tree overlay.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowStore } from '../store/workflow-store'
import { validateWorkflowData } from '../lib/workflow-validator'
import { App } from './App'

type SpawnResult = { stdout: string; stderr: string; status: number | null }

async function spawnGenerateWorkflow(): Promise<{ workflowPath: string; workflow: unknown }> {
  // Dynamic string modules avoid tsconfig.app node-type requirements (same pattern as other tests).
  const childProcessId = 'node:child_process'
  const pathId = 'node:path'
  const childProcess = (await import(/* @vite-ignore */ childProcessId)) as {
    spawnSync: (
      command: string,
      args: string[],
      options: { cwd: string; encoding: string; maxBuffer: number },
    ) => SpawnResult
  }
  const path = (await import(/* @vite-ignore */ pathId)) as {
    resolve: (...parts: string[]) => string
  }
  const processRef = (globalThis as {
    process?: { execPath?: string; cwd?: () => string }
  }).process
  if (!processRef?.execPath || !processRef.cwd) {
    throw new Error('Node process is unavailable for writeWorkflowViewer E2E')
  }

  // vitest cwd is apps/workflow-viewer
  const viewerRoot = processRef.cwd()
  const generator = path.resolve(viewerRoot, 'tests/generate-active-mission-workflow.mjs')
  const repoRoot = path.resolve(viewerRoot, '../..')
  const result = childProcess.spawnSync(processRef.execPath, [generator], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(
      `writeWorkflowViewer generator failed (${String(result.status)}): ${result.stderr || result.stdout}`,
    )
  }
  return JSON.parse(result.stdout) as { workflowPath: string; workflow: unknown }
}

describe('App ← writeWorkflowViewer E2E (R3)', () => {
  beforeEach(() => {
    useWorkflowStore.getState().clearWorkflow()
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses and renders unmocked writeWorkflowViewer workflow.json through App', async () => {
    const generated = await spawnGenerateWorkflow()
    const raw = generated.workflow as Record<string, unknown>

    // Real App parser — no test-only fake digest injection on the payload.
    const validation = validateWorkflowData(raw)
    expect(validation.success).toBe(true)
    if (!validation.success) return

    expect(validation.data.missionTree?.mode).toBe('active')
    expect(validation.data.missionTree?.taskTreeReadOnly).toBe(true)
    expect(validation.data.nodes.length).toBeGreaterThan(1)
    expect(validation.data.edges.length).toBeGreaterThan(0)
    expect(JSON.stringify(raw)).toMatch(/"missionTree"/)
    expect(JSON.stringify(raw)).not.toMatch(/"mission_tree"\s*:/)
    expect(JSON.stringify(raw)).not.toMatch(/subject_digest|decision_digest|approved_input_digest/)

    const user = userEvent.setup()
    render(
      <App samples={[{ id: 'from-writer', label: 'writeWorkflowViewer', data: raw }]} />,
    )

    const fallback = await screen.findByTestId('workflow-scene-fallback', undefined, {
      timeout: 15_000,
    })
    expect(fallback).toBeVisible()
    expect(screen.getByTestId('mission-tree-status')).toBeVisible()
    expect(screen.getByTestId('mission-tree-decision-kind')).toHaveTextContent('awaiting_human')

    const treeItems = within(fallback).getAllByRole('treeitem', { name: /詳細を表示$/ })
    expect(treeItems.length).toBe(validation.data.nodes.length)
    expect(fallback.querySelectorAll('[data-edge-id]').length).toBeGreaterThan(0)

    // Keyboard + SidePanel sync
    treeItems[0]!.focus()
    await user.keyboard('{ArrowDown}')
    const selectedId = useWorkflowStore.getState().selectedNodeId
    expect(selectedId).toBeTruthy()
    expect(within(fallback).getByRole('treeitem', { selected: true })).toBeVisible()
    if (selectedId) {
      const selectedNode = validation.data.nodes.find((entry) => entry.id === selectedId)
      expect(selectedNode).toBeDefined()
      expect(
        screen.getByRole('button', { name: `${selectedNode!.name}の工程詳細を表示` }),
      ).toHaveAttribute('aria-pressed', 'true')
    }

    // snake_case / unknown rejected by the same parser App uses
    expect(validateWorkflowData({ ...raw, mission_tree: { mode: 'active' } }).success).toBe(false)
    expect(
      validateWorkflowData({
        ...raw,
        missionTree: {
          ...(raw.missionTree as object),
          subject_digest: 'f'.repeat(64),
        },
      }).success,
    ).toBe(false)
  }, 45_000)
})
