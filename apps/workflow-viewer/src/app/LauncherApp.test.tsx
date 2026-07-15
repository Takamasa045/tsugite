import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { LauncherApp } from './LauncherApp'

const projects = [
  {
    id: 'tengu-60s-landscape',
    name: '天狗の山寺 60秒映像',
    slug: 'tengu-60s-landscape',
    runId: 'tengu-60s-landscape-v3',
    status: 'completed',
    updatedAt: '2026-07-15T09:30:00+09:00',
    hasViewer: true,
    viewerUrl: '/viewers/tengu-60s-landscape/',
    valid: true,
  },
  {
    id: 'codex-goal-talk-paper',
    name: 'Codex Goal Talk',
    slug: 'codex-goal-talk-paper',
    runId: 'codex-goal-talk-paper-r6',
    status: 'running',
    updatedAt: '2026-07-15T10:00:00+09:00',
    hasViewer: false,
    valid: true,
  },
]

function jsonResponse(input: unknown, ok = true): Response {
  return { ok, json: async () => input } as Response
}

describe('LauncherApp', () => {
  it('既定のfetchでも一覧取得を一度だけ実行する', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ok: true, projects }))
    vi.stubGlobal('fetch', fetcher)

    render(<LauncherApp token="session-token" />)

    expect(await screen.findByRole('heading', { name: '制作の見取図を開く' })).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('案件を読み込み、検索・選択・前回の表示を案内する', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ok: true, projects }))
    const navigate = vi.fn()

    render(<LauncherApp fetcher={fetcher} navigate={navigate} token="session-token" />)

    expect(screen.getByText('制作案件を読み込んでいます…')).toBeVisible()
    expect(await screen.findByRole('heading', { name: '制作の見取図を開く' })).toBeVisible()
    expect(screen.getByText('全2件 / 表示2件')).toBeVisible()
    const selectedPanel = screen.getByRole('complementary', { name: '選択した制作案件' })
    expect(within(selectedPanel).getByRole('heading', { name: '天狗の山寺 60秒映像' })).toBeVisible()
    expect(within(selectedPanel).getByText('完了')).toBeVisible()
    expect(within(selectedPanel).getByText(/2026\/07\/15/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: /Codex Goal Talkを選ぶ/ }))
    expect(screen.getByText('codex-goal-talk-paper-r6')).toBeVisible()
    expect(screen.queryByRole('button', { name: '前回の表示を開く' })).not.toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: '制作案件を検索' }), '天狗')
    expect(screen.getByText('全2件 / 表示1件')).toBeVisible()
    const projectList = screen.getByRole('region', { name: '制作案件を選ぶ' })
    expect(within(projectList).queryByRole('heading', { name: 'Codex Goal Talk' })).not.toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: '制作案件を検索' }))
    await user.click(screen.getByRole('button', { name: /天狗の山寺 60秒映像を選ぶ/ }))
    await user.click(screen.getByRole('button', { name: '前回の表示を開く' }))
    expect(navigate).toHaveBeenCalledWith('/viewers/tengu-60s-landscape/')
  })

  it('選択した案件をtoken付きで更新し、成功したViewerへ移動する', async () => {
    const user = userEvent.setup()
    let resolveRefresh!: (response: Response) => void
    const refreshRequest = new Promise<Response>((resolve) => { resolveRefresh = resolve })
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, projects }))
      .mockReturnValueOnce(refreshRequest)
    const navigate = vi.fn()

    render(<LauncherApp fetcher={fetcher} navigate={navigate} token="session-token" />)
    await screen.findByRole('button', { name: /天狗の山寺 60秒映像を選ぶ/ })

    await user.click(screen.getByRole('button', { name: '最新状態に更新して開く' }))
    expect(screen.getByRole('button', { name: '制作の記録を更新しています…' })).toBeDisabled()

    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith(
      '/api/projects/tengu-60s-landscape/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-tsugite-token': 'session-token',
        }),
      }),
    ))
    resolveRefresh(jsonResponse({
      ok: true,
      viewerUrl: '/viewers/tengu-60s-landscape/?updated=1',
      project: projects[0],
    }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/viewers/tengu-60s-landscape/?updated=1'))
  })

  it('無効な案件と検索の空状態を、次の行動が分かる日本語で表示する', async () => {
    const user = userEvent.setup()
    const invalidProject = {
      ...projects[0],
      id: 'broken',
      name: '設定確認が必要な案件',
      valid: false,
      hasViewer: false,
      viewerUrl: undefined,
      issue: 'manifest.jsonが見つかりません。',
    }
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ok: true, projects: [invalidProject] }))

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('button', { name: /設定確認が必要な案件を選ぶ/ })

    const selectedPanel = screen.getByRole('complementary', { name: '選択した制作案件' })
    expect(within(selectedPanel).getByText('設定の確認が必要')).toBeVisible()
    expect(screen.getByText('manifest.jsonが見つかりません。')).toBeVisible()
    expect(screen.getByRole('button', { name: '最新状態に更新して開く' })).toBeDisabled()
    expect(screen.getByText('project.yamlと参照ファイルを確認してください。')).toBeVisible()

    await user.type(screen.getByRole('searchbox', { name: '制作案件を検索' }), '存在しない')
    expect(screen.getByText('検索条件に合う制作案件はありません。')).toBeVisible()
  })

  it('metaのsession tokenを使い、更新失敗時はViewerへ移動しない', async () => {
    const user = userEvent.setup()
    const meta = document.createElement('meta')
    meta.name = 'tsugite-launcher-token'
    meta.content = 'meta-session-token'
    document.head.append(meta)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, projects }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, issues: [{ message: 'broken' }] }, false))
    const navigate = vi.fn()

    render(<LauncherApp fetcher={fetcher} navigate={navigate} />)
    await screen.findByRole('button', { name: /天狗の山寺 60秒映像を選ぶ/ })
    await user.click(screen.getByRole('button', { name: '最新状態に更新して開く' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('最新の制作記録を開けませんでした。')
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/projects/tengu-60s-landscape/refresh',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-tsugite-token': 'meta-session-token' }),
      }),
    )
    expect(navigate).not.toHaveBeenCalled()
    meta.remove()
  })

  it('一覧取得の失敗から再読込でき、空の一覧も案内する', async () => {
    const user = userEvent.setup()
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse({ ok: true, projects: [] }))

    render(<LauncherApp fetcher={fetcher} token="session-token" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('制作案件を読み込めませんでした。')
    await user.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(await screen.findByText('表示できる制作案件はまだありません。')).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
