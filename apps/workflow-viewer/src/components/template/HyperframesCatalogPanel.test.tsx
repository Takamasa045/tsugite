import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HyperframesCatalogPanel } from './HyperframesCatalogPanel'
import {
  HYPERFRAMES_CATALOG_ADVISORY_NOTE,
  HYPERFRAMES_CATALOG_ENDPOINT,
} from './hyperframesCatalogModel'

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: async () => payload,
  } as Response
}

const catalogPayload = {
  ok: true as const,
  schemaVersion: 1 as const,
  source: 'hyperframes' as const,
  advisoryOnly: true as const,
  capabilityVerified: false as const,
  summary: {
    total: 3,
    returned: 3,
    omitted: 0,
    byType: { block: 2, component: 1 },
  },
  items: [
    {
      id: 'data-chart',
      type: 'block' as const,
      title: 'Data Chart',
      description: 'Animated bar chart',
      tags: ['data', 'chart'],
      dimensions: { width: 1920, height: 1080 },
      durationSeconds: 15,
    },
    {
      id: 'code-typewriter',
      type: 'component' as const,
      title: 'Code Typewriter',
      description: 'Typing code on screen',
      tags: ['code', 'syntax'],
    },
    {
      id: 'logo-outro',
      type: 'block' as const,
      title: 'Logo Outro',
      description: 'Brand outro',
      tags: ['branding', 'logo'],
    },
  ],
  warnings: [],
}

describe('HyperframesCatalogPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('stays closed by default and fetches only after open', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(catalogPayload))

    render(<HyperframesCatalogPanel fetcher={fetcher} token="session-token" />)

    const summary = screen.getByText('表現のヒントを探す')
    const details = summary.closest('details')
    expect(details).toBeTruthy()
    expect(details).not.toHaveAttribute('open')
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.getByText(HYPERFRAMES_CATALOG_ADVISORY_NOTE)).toBeInTheDocument()

    await user.click(summary)
    await screen.findByText('Data Chart')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(HYPERFRAMES_CATALOG_ENDPOINT, {
      headers: {
        accept: 'application/json',
        'x-tsugite-token': 'session-token',
      },
    })

    // 閉じても再fetchしない
    await user.click(summary)
    await user.click(summary)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('supports search, type, estimated category, tags, detail, and id copy', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(catalogPayload))

    render(<HyperframesCatalogPanel fetcher={fetcher} token="session-token" />)
    await user.click(screen.getByText('表現のヒントを探す'))
    await screen.findByText('Data Chart')

    expect(screen.getByText(/全3件/)).toBeVisible()
    expect(screen.getByText(/公式categoryではありません/)).toBeVisible()

    await user.selectOptions(screen.getByLabelText('type'), 'component')
    expect(screen.getByText('Code Typewriter')).toBeVisible()
    expect(screen.queryByText('Data Chart')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('type'), 'all')
    await user.selectOptions(screen.getByLabelText('Tsugite推定分類'), 'データ・図表')
    expect(screen.getByText('Data Chart')).toBeVisible()
    expect(screen.queryByText('Logo Outro')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Tsugite推定分類'), 'すべて')
    await user.type(screen.getByLabelText('検索'), 'logo')
    expect(screen.getByText('Logo Outro')).toBeVisible()
    expect(screen.queryByText('Data Chart')).not.toBeInTheDocument()

    await user.clear(screen.getByLabelText('検索'))
    expect(screen.getByText('Data Chart')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Data Chartの詳細' }))
    expect(screen.getByText('1920×1080')).toBeVisible()
    expect(screen.getByText('15秒')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'logo-outro をコピー' }))
    expect(writeText).toHaveBeenCalledWith('logo-outro')
  })

  it('keeps the previous list when reload fails and does not block surrounding actions', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse(catalogPayload))
      .mockResolvedValueOnce(jsonResponse({ ok: false, issue: { code: 'reference_catalog.timeout', message: 'timeout' } }, false))

    render(<HyperframesCatalogPanel fetcher={fetcher} token="session-token" />)
    await user.click(screen.getByText('表現のヒントを探す'))
    await screen.findByText('Data Chart')

    await user.click(screen.getByRole('button', { name: '再読み込み' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/前回の一覧/)
    })
    expect(screen.getByText('Data Chart')).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('shows a non-blocking error when the first load fails', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, issue: { code: 'reference_catalog.unavailable', message: 'missing' } }, false),
    )

    render(<HyperframesCatalogPanel fetcher={fetcher} token="session-token" />)
    await user.click(screen.getByText('表現のヒントを探す'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/表現のヒントを読み込めませんでした/)
    expect(within(alert).getByText(/仕上げ構成や制作依頼はそのまま使えます/)).toBeVisible()
  })

  it('does not crash on malformed success payloads', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      schemaVersion: 1,
      source: 'hyperframes',
      advisoryOnly: true,
      capabilityVerified: false,
      summary: { total: 1 },
      items: [{ id: 'x', type: 'block', title: 'X', description: 'y', tags: ['t'] }],
      warnings: [],
    }))

    render(<HyperframesCatalogPanel fetcher={fetcher} token="session-token" />)
    await user.click(screen.getByText('表現のヒントを探す'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/表現のヒントを読み込めませんでした/)
    expect(screen.queryByText('X')).not.toBeInTheDocument()
  })

  it('keeps catalog toolbar/list single-column under 600px after two-column base rules', async () => {
    const nodeFs = 'node:fs'
    const nodePath = 'node:path'
    const fs = await import(/* @vite-ignore */ nodeFs) as {
      readFileSync: (path: string, encoding: string) => string
    }
    const path = await import(/* @vite-ignore */ nodePath) as {
      resolve: (...parts: string[]) => string
    }
    const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.()
    if (!cwd) throw new Error('process.cwd is unavailable')
    const stylePath = path.resolve(cwd, 'src/styles/launcher-yakisugi.css')
    const css = fs.readFileSync(stylePath, 'utf8')

    const twoColToolbar = css.indexOf(
      '.launcher-hyperframes-catalog-toolbar {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));',
    )
    const twoColList = css.indexOf(
      '.launcher-hyperframes-catalog-list {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));',
    )
    expect(twoColToolbar).toBeGreaterThanOrEqual(0)
    expect(twoColList).toBeGreaterThanOrEqual(0)

    const mobileMatch = /@media \(max-width: 600px\) \{[\s\S]*?\.launcher-hyperframes-catalog-toolbar \{[\s\S]*?grid-template-columns: 1fr;[\s\S]*?\.launcher-hyperframes-catalog-list \{[\s\S]*?grid-template-columns: 1fr;/.exec(
      css,
    )
    expect(mobileMatch).not.toBeNull()
    expect(mobileMatch!.index).toBeGreaterThan(twoColToolbar)
    expect(mobileMatch!.index).toBeGreaterThan(twoColList)
  })

  it('reload uses aria-disabled while loading and keeps focus without re-entry fetch', async () => {
    const user = userEvent.setup()
    let resolveReload: ((value: Response) => void) | null = null
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse(catalogPayload))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveReload = resolve
      }))

    render(<HyperframesCatalogPanel fetcher={fetcher} token="session-token" />)
    await user.click(screen.getByText('表現のヒントを探す'))
    await screen.findByText('Data Chart')

    const reload = screen.getByRole('button', { name: '再読み込み' })
    reload.focus()
    await user.click(reload)

    const busy = screen.getByRole('button', { name: '再読み込み' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).not.toHaveAttribute('disabled')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveFocus()
    expect(fetcher).toHaveBeenCalledTimes(2)

    await user.click(busy)
    expect(fetcher).toHaveBeenCalledTimes(2)

    await waitFor(async () => {
      resolveReload?.(jsonResponse(catalogPayload))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '再読み込み' })).not.toHaveAttribute('aria-disabled')
    })
    expect(screen.getByRole('button', { name: '再読み込み' })).toHaveFocus()
  })

  it('production source keeps soft-disable reload (no dynamic native disabled)', async () => {
    const nodeFs = 'node:fs'
    const nodePath = 'node:path'
    const fs = await import(/* @vite-ignore */ nodeFs) as {
      readFileSync: (path: string, encoding: string) => string
    }
    const path = await import(/* @vite-ignore */ nodePath) as {
      resolve: (...parts: string[]) => string
    }
    const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.()
    if (!cwd) throw new Error('process.cwd is unavailable')
    const source = fs.readFileSync(
      path.resolve(cwd, 'src/components/template/HyperframesCatalogPanel.tsx'),
      'utf8',
    )
    expect(source).toMatch(/aria-disabled=\{loadState === 'loading' \|\| undefined\}/)
    expect(source).not.toMatch(/disabled=\{loadState === 'loading'\}/)
    expect(source).toMatch(/if \(loadState === 'loading'\) return/)
  })
})
