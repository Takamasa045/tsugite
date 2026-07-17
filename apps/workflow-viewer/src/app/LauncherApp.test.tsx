import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { LauncherApp } from './LauncherApp'

const projects = [
  {
    id: 'project-alpha',
    name: 'サンプル映像A',
    slug: 'project-alpha',
    runId: 'project-alpha-r3',
    status: 'completed',
    updatedAt: '2026-07-15T09:30:00+09:00',
    hasViewer: true,
    viewerUrl: '/viewers/project-alpha/',
    thumbnailUrl: '/thumbnail/project-alpha',
    valid: true,
    refreshable: true,
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
    refreshable: true,
  },
]

const templates = [
  {
    id: 'blog-dialogue-60s',
    name: 'ブログ掛け合い 60秒',
    summary: 'ブログ記事を初心者役と解説役の会話で伝える動画です。',
    category: '記事を動画化',
    useCases: ['ブログ記事', '初心者向け解説'],
    duration: '60秒',
    aspectRatio: '16:9',
    speakers: 2,
    requiredInputs: ['記事本文と出典', '2人分のキャラクター画像'],
    tags: ['掛け合い', '記事', '60秒'],
    audio: '音声とBGMは任意です。',
    status: 'stable' as const,
    distribution: 'local-only' as const,
    valid: true,
  },
  {
    id: 'qa-dialogue',
    name: 'Q&A掛け合い',
    summary: 'FAQの質問と回答から横型動画を作ります。',
    category: 'Q&A・FAQ',
    useCases: ['よくある質問', '操作説明'],
    duration: 'Q&A件数に応じて可変',
    aspectRatio: '16:9',
    speakers: 2,
    requiredInputs: ['質問と回答の一覧', '2人分のキャラクター画像'],
    tags: ['FAQ', '掛け合い'],
    audio: '音声とBGMは任意です。',
    status: 'stable' as const,
    distribution: 'local-only' as const,
    valid: true,
  },
  {
    id: 'broken-template',
    name: 'broken-template',
    summary: '',
    category: '',
    useCases: [],
    duration: '',
    aspectRatio: '',
    requiredInputs: [],
    tags: [],
    audio: '',
    status: 'unknown' as const,
    distribution: 'unknown' as const,
    valid: false,
    issue: {
      code: 'template_metadata.invalid',
      message: 'template.yamlの形式が正しくありません。',
    },
  },
]

const feedback = {
  metrics: {
    observed: 3,
    recurring: 2,
    promoted: 1,
    verified: 1,
    issues: 0,
  },
  preferences: [
    {
      key: 'wa-modern-interface',
      category: '画面デザイン',
      signal: 'prefer' as const,
      stage: 'promoted' as const,
      summary: '和モダンの意匠を制作画面に取り入れる。',
      projectCount: 3,
      projectNames: ['サンプル案件A', 'サンプル案件B', 'サンプル案件C'],
      runIds: ['sample-a-r3', 'sample-b-r9', 'sample-c-r13'],
      evidence: ['projects/sample-a/notes.md', 'LESSONS.md#wa-modern'],
      promotion: {
        projectId: 'sample-a',
        projectName: 'サンプル案件A',
        kind: 'template' as const,
        target: 'templates/wa-modern-launcher',
      },
      promotions: [
        {
          projectId: 'sample-a',
          projectName: 'サンプル案件A',
          kind: 'template' as const,
          target: 'templates/wa-modern-launcher',
        },
        {
          projectId: 'sample-b',
          projectName: 'サンプル案件B',
          kind: 'rule' as const,
          target: 'LESSONS.md#wa-modern',
        },
      ],
      lastSeenAt: '2026-07-17T08:30:00+09:00',
    },
    {
      key: 'opening-audio',
      category: '音声',
      signal: 'keep' as const,
      stage: 'verified' as const,
      summary: '冒頭からBGMまたは短いSFXを入れる。',
      projectCount: 2,
      projectNames: ['サンプル案件A', 'サンプル会話案件'],
      runIds: ['sample-a-r3', 'sample-dialogue-r2'],
      evidence: ['LESSONS.md#opening-audio'],
      promotion: {
        projectId: 'sample-a',
        projectName: 'サンプル案件A',
        kind: 'qa' as const,
        target: 'Gate 3 opening-audio check',
      },
      promotions: [{
        projectId: 'sample-a',
        projectName: 'サンプル案件A',
        kind: 'qa' as const,
        target: 'Gate 3 opening-audio check',
      }],
      lastSeenAt: '2026-07-16T21:00:00+09:00',
    },
    {
      key: 'caption-safe-area',
      category: '字幕',
      signal: 'keep' as const,
      stage: 'recurring' as const,
      summary: '字幕をセーフエリア内に収める。',
      projectCount: 2,
      projectNames: ['サンプル案件A', 'サンプル案件B'],
      runIds: ['sample-a-r3', 'sample-b-r9'],
      evidence: ['projects/sample-a/feedback.jsonl', 'projects/sample-b/feedback.jsonl'],
      promotions: [],
      promotionProposal: {
        projectId: 'sample-a',
        projectName: 'サンプル案件A',
        id: 'caption-safe-area-v1',
        kind: 'qa' as const,
        target: 'src/orchestrator/gate3Qc.ts',
        changeSummary: '字幕のセーフエリア判定をGate 3へ追加する。',
        verification: '後続案件のgate3-qc.jsonと代表フレームで確認する。',
        decision: 'pending' as const,
      },
      lastSeenAt: '2026-07-17T09:00:00+09:00',
    },
  ],
  issues: [],
}

function jsonResponse(input: unknown, ok = true): Response {
  return { ok, json: async () => input } as Response
}

describe('LauncherApp', () => {
  it('昇格承認待ちをタブへ表示し、新しい待ち案件だけをデスクトップ通知する', async () => {
    const user = userEvent.setup()
    let permission: NotificationPermission = 'default'
    let currentFeedback: unknown = feedback
    const notify = vi.fn()
    const requestPermission = vi.fn(async () => {
      permission = 'granted'
      return permission
    })
    const notificationStorage = new Map<string, string>()
    const storage = {
      getItem: (key: string) => notificationStorage.get(key) ?? null,
      setItem: (key: string, value: string) => { notificationStorage.set(key, value) },
    }
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/feedback') return Promise.resolve(jsonResponse({ ok: true, feedback: currentFeedback }))
      return Promise.resolve(jsonResponse({ ok: true, projects }))
    })

    render(
      <LauncherApp
        feedbackPollIntervalMs={20}
        fetcher={fetcher}
        notificationApi={{
          getPermission: () => permission,
          isSupported: () => true,
          requestPermission,
          show: notify,
        }}
        notificationStorage={storage}
        token="session-token"
      />,
    )
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    const feedbackTab = screen.getByRole('tab', { name: '好み・学び' })
    await user.click(feedbackTab)

    expect(await screen.findByText('昇格承認待ち 1件')).toBeVisible()
    expect(feedbackTab).toHaveTextContent('1')
    await user.click(screen.getByRole('button', { name: '承認待ちの通知を有効にする' }))

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(notify).toHaveBeenCalledWith(
      '昇格承認待ちが1件あります',
      expect.objectContaining({ body: '字幕をセーフエリア内に収める。' }),
    ))
    expect(screen.getByText('デスクトップ通知は有効です')).toBeVisible()

    currentFeedback = {
      ...feedback,
      preferences: [
        ...feedback.preferences,
        {
          ...feedback.preferences[2]!,
          key: 'opening-black-frame',
          summary: '冒頭の黒画面を避ける。',
          promotionProposal: {
            ...feedback.preferences[2]!.promotionProposal!,
            id: 'opening-black-frame-v1',
          },
        },
      ],
    }

    await waitFor(() => expect(notify).toHaveBeenCalledWith(
      '昇格承認待ちが2件あります',
      expect.objectContaining({ body: '新しく1件が承認待ちになりました。' }),
    ))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(notify).toHaveBeenCalledTimes(2)
    expect(screen.getByText('昇格承認待ち 2件')).toBeVisible()
  })

  it('通知を拒否した場合は再要求せず、ブラウザ設定の案内を表示する', async () => {
    const user = userEvent.setup()
    let permission: NotificationPermission = 'default'
    const show = vi.fn()
    const fetcher = vi.fn().mockImplementation((url: string) => (
      url === '/api/feedback'
        ? Promise.resolve(jsonResponse({ ok: true, feedback }))
        : Promise.resolve(jsonResponse({ ok: true, projects }))
    ))

    render(
      <LauncherApp
        fetcher={fetcher}
        notificationApi={{
          getPermission: () => permission,
          isSupported: () => true,
          requestPermission: async () => {
            permission = 'denied'
            return permission
          },
          show,
        }}
        token="session-token"
      />,
    )
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    await user.click(screen.getByRole('tab', { name: '好み・学び' }))
    await user.click(await screen.findByRole('button', { name: '承認待ちの通知を有効にする' }))

    expect(await screen.findByText('通知がブロックされています。ブラウザのサイト設定から通知を許可してください。')).toBeVisible()
    expect(screen.queryByRole('button', { name: '承認待ちの通知を有効にする' })).not.toBeInTheDocument()
    expect(show).not.toHaveBeenCalled()
  })

  it('棚タブを矢印キーとHome・Endで移動できる', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/templates') return Promise.resolve(jsonResponse({ ok: true, templates }))
      if (url === '/api/feedback') return Promise.resolve(jsonResponse({ ok: true, feedback }))
      return Promise.resolve(jsonResponse({ ok: true, projects }))
    })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    const projectsTab = screen.getByRole('tab', { name: '制作案件' })
    const templatesTab = screen.getByRole('tab', { name: 'テンプレート' })
    const feedbackTab = screen.getByRole('tab', { name: '好み・学び' })

    projectsTab.focus()
    await user.keyboard('{ArrowRight}')
    expect(templatesTab).toHaveFocus()
    expect(templatesTab).toHaveAttribute('aria-selected', 'true')
    expect(projectsTab).toHaveAttribute('tabindex', '-1')

    await user.keyboard('{End}')
    expect(feedbackTab).toHaveFocus()
    expect(feedbackTab).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Home}')
    expect(projectsTab).toHaveFocus()
    expect(projectsTab).toHaveAttribute('aria-selected', 'true')
  })

  it('既定のfetchでも一覧取得を一度だけ実行する', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ok: true, projects }))
    vi.stubGlobal('fetch', fetcher)

    render(<LauncherApp token="session-token" />)

    expect(await screen.findByRole('heading', { name: '制作の見取図を開く' })).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('案件を読み込み、検索と前回の表示を案内する', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ok: true, projects }))
    const navigate = vi.fn()

    render(<LauncherApp fetcher={fetcher} navigate={navigate} token="session-token" />)

    expect(screen.getByText('制作案件を読み込んでいます…')).toBeVisible()
    expect(await screen.findByRole('heading', { name: '制作の見取図を開く' })).toBeVisible()
    expect(screen.getByText('全2件 / 表示2件')).toBeVisible()
    const selectedPanel = screen.getByRole('complementary', { name: '選択した制作案件' })
    expect(within(selectedPanel).getByRole('heading', { name: 'サンプル映像A' })).toBeVisible()
    expect(within(selectedPanel).getByText('完了')).toBeVisible()
    expect(within(selectedPanel).getByText(/2026\/07\/15/)).toBeVisible()
    expect(document.querySelector('img[src="/thumbnail/project-alpha"]')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: '制作案件を検索' }), 'サンプル映像A')
    expect(screen.getByText('全2件 / 表示1件')).toBeVisible()
    const projectList = screen.getByRole('region', { name: '制作案件を選ぶ' })
    expect(within(projectList).queryByRole('heading', { name: 'Codex Goal Talk' })).not.toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: '制作案件を検索' }))
    await user.click(screen.getByRole('button', { name: '前回の表示を開く' }))
    expect(navigate).toHaveBeenCalledWith('/viewers/project-alpha/')
  })

  it('大量の案件を最近更新順に12件ずつ表示し、状態で絞り込める', async () => {
    const user = userEvent.setup()
    const manyProjects = Array.from({ length: 14 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `案件${String(index + 1).padStart(2, '0')}`,
      slug: `project-${index + 1}`,
      runId: `run-${index + 1}`,
      status: index % 2 === 0 ? 'completed' : 'running',
      updatedAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00+09:00`,
      hasViewer: false,
      valid: true,
      refreshable: true,
    }))
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ok: true, projects: manyProjects }))

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('button', { name: '案件14の制作記録を開く' })

    expect(screen.getByText('全14件 / 表示12件')).toBeVisible()
    expect(screen.queryByRole('button', { name: '案件02の制作記録を開く' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '残り2件を表示' }))
    expect(screen.getByText('全14件 / 表示14件')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '制作中で絞り込む' }))
    expect(screen.getByText('全14件 / 表示7件')).toBeVisible()
    expect(screen.queryByRole('button', { name: '案件13の制作記録を開く' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '案件14の制作記録を開く' })).toBeVisible()
    expect(screen.getByRole('button', { name: '案件02の制作記録を開く' })).toBeVisible()
  })

  it('テンプレート棚を必要時に読み込み、検索・用途絞り込み・詳細確認ができる', async () => {
    const user = userEvent.setup()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, projects }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, templates }))

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('tab', { name: 'テンプレート' }))
    expect(await screen.findByRole('heading', { name: 'テンプレートを選ぶ' })).toBeVisible()
    expect(fetcher).toHaveBeenLastCalledWith('/api/templates', {
      headers: { accept: 'application/json' },
    })
    expect(screen.getByText('全3件 / 表示3件')).toBeVisible()

    const detail = screen.getByRole('complementary', { name: '選択したテンプレート' })
    expect(within(detail).getByRole('heading', { name: 'ブログ掛け合い 60秒' })).toBeVisible()
    expect(within(detail).getByText('ブログ記事を初心者役と解説役の会話で伝える動画です。')).toBeVisible()
    expect(within(detail).getByText('記事本文と出典')).toBeVisible()
    expect(within(detail).getByText('閲覧専用')).toBeVisible()

    await user.type(screen.getByRole('searchbox', { name: 'テンプレートを検索' }), 'FAQ')
    expect(screen.getByText('全3件 / 表示1件')).toBeVisible()
    expect(screen.getByRole('button', { name: /Q&A掛け合いを選ぶ/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ })).not.toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: 'テンプレートを検索' }))
    await user.click(screen.getByRole('button', { name: 'Q&A・FAQで絞り込む' }))
    expect(screen.getByText('全3件 / 表示1件')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /Q&A掛け合いを選ぶ/ }))
    expect(within(detail).getByText(/Q&A件数に応じて可変/)).toBeVisible()

    await user.click(screen.getByRole('tab', { name: '制作案件' }))
    expect(screen.getByRole('heading', { name: '制作案件を選ぶ' })).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('テンプレート一覧の読込失敗から再試行できる', async () => {
    const user = userEvent.setup()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, projects }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse({ ok: true, templates: [] }))

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    await user.click(screen.getByRole('tab', { name: 'テンプレート' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('テンプレートを読み込めませんでした。')
    await user.click(screen.getByRole('button', { name: 'テンプレートをもう一度読み込む' }))
    expect(await screen.findByText('表示できるテンプレートはまだありません。')).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('好み・学びを必要時だけ読み込み、4段階と根拠を表示する', async () => {
    const user = userEvent.setup()
    let resolveFeedback!: (response: Response) => void
    const feedbackRequest = new Promise<Response>((resolve) => { resolveFeedback = resolve })
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, projects }))
      .mockReturnValueOnce(feedbackRequest)

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    const feedbackTab = screen.getByRole('tab', { name: '好み・学び' })
    await user.click(feedbackTab)
    expect(feedbackTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('好み・学びを整理しています…')).toBeVisible()
    expect(fetcher).toHaveBeenLastCalledWith('/api/feedback', {
      headers: { accept: 'application/json' },
    })

    resolveFeedback(jsonResponse({ ok: true, feedback }))
    const metrics = await screen.findByLabelText('学びの4段階')
    expect(within(metrics).getByText('観測中').parentElement).toHaveTextContent('観測中 / 到達済み3')
    expect(within(metrics).getByText('学習中').parentElement).toHaveTextContent('学習中 / 到達済み2')
    expect(within(metrics).getByText('反映済み').parentElement).toHaveTextContent('反映済み / 到達済み1')
    expect(within(metrics).getByText('適用確認済み').parentElement).toHaveTextContent('適用確認済み / 到達済み1')

    const stageGuide = screen.getByRole('region', { name: '学びの状態と適用状況' })
    expect(within(stageGuide).getByText('未適用・記録中')).toBeVisible()
    expect(within(stageGuide).getByText('未適用・昇格候補')).toBeVisible()
    expect(within(stageGuide).getByText('適用済み・確認待ち')).toBeVisible()
    expect(within(stageGuide).getByText('適用済み・確認済み')).toBeVisible()

    const promotionFlow = screen.getByRole('region', { name: '学習中から昇格する流れ' })
    expect(within(promotionFlow).getByText('反復根拠をそろえる')).toBeVisible()
    expect(within(promotionFlow).getByText('人が昇格を承認する')).toBeVisible()
    expect(within(promotionFlow).getByText('再利用先へ反映する')).toBeVisible()
    expect(within(promotionFlow).getByText('後続案件で確認する')).toBeVisible()

    const promotedCard = screen.getByRole('button', { name: '和モダンの意匠を制作画面に取り入れる。の詳細を見る' })
    expect(promotedCard).toHaveAttribute('aria-pressed', 'true')
    expect(promotedCard).toHaveTextContent('画面デザイン')
    expect(promotedCard).toHaveTextContent('取り入れたい')
    expect(promotedCard).toHaveTextContent('3案件')
    expect(promotedCard).toHaveTextContent('反映済み')
    expect(promotedCard).toHaveTextContent('templates/wa-modern-launcher')
    expect(promotedCard).toHaveTextContent('ほか1件')
    expect(promotedCard).toHaveTextContent('適用済み・確認待ち')

    const detail = screen.getByRole('complementary', { name: '選択した好み・学び' })
    expect(within(detail).getAllByText('サンプル案件A').length).toBeGreaterThan(0)
    expect(within(detail).getByText('sample-a-r3')).toBeVisible()
    expect(within(detail).getByText('projects/sample-a/notes.md')).toBeVisible()
    const promotionSection = within(detail).getByRole('heading', { name: '昇格先' }).closest('section')
    expect(promotionSection).not.toBeNull()
    expect(within(promotionSection!).getByText('LESSONS.md#wa-modern')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '冒頭からBGMまたは短いSFXを入れる。の詳細を見る' }))
    expect(within(detail).getByText('適用確認').parentElement).toHaveTextContent('適用確認済み')

    const recurringCard = screen.getByRole('button', { name: '字幕をセーフエリア内に収める。の詳細を見る' })
    expect(recurringCard).toHaveTextContent('未適用・昇格候補')
    expect(recurringCard).toHaveTextContent('昇格承認待ち')
    await user.click(recurringCard)
    expect(within(detail).getByText('次の段階').parentElement).toHaveTextContent('昇格案を確認し、人が承認または見送り')
    const approvalSection = within(detail).getByRole('heading', { name: '昇格承認' }).closest('section')
    expect(approvalSection).not.toBeNull()
    expect(within(approvalSection!).getByText('字幕のセーフエリア判定をGate 3へ追加する。')).toBeVisible()
    expect(within(approvalSection!).getByText('後続案件のgate3-qc.jsonと代表フレームで確認する。')).toBeVisible()
    expect(within(approvalSection!).getByRole('button', { name: '昇格を承認' })).toBeVisible()
    expect(within(approvalSection!).getByRole('button', { name: '今回は見送る' })).toBeVisible()

    fetcher.mockResolvedValueOnce(jsonResponse({ ok: true, decision: 'approved' }))
    await user.click(within(approvalSection!).getByRole('button', { name: '昇格を承認' }))
    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith(
      '/api/feedback/sample-a/promotion-decision',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-tsugite-token': 'session-token' }),
        body: JSON.stringify({
          key: 'caption-safe-area',
          proposalId: 'caption-safe-area-v1',
          decision: 'approved',
        }),
      }),
    ))
    expect(await within(detail).findByText('承認済み・反映待ち')).toBeVisible()
    expect(within(detail).getByText('次の段階').parentElement).toHaveTextContent('共有先へ反映し、テストして反映済みへ')
    expect(within(detail).getByRole('heading', { name: '次にすること' }).parentElement).toHaveTextContent('承認された案を共有先へ実装')

    await user.click(screen.getByRole('tab', { name: '制作案件' }))
    await user.click(feedbackTab)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('好み・学びを状態タグで絞り込み、選択中の詳細と件数を同期する', async () => {
    const user = userEvent.setup()
    const observedPreference = {
      ...feedback.preferences[0]!,
      key: 'opening-title-density',
      stage: 'observed' as const,
      summary: '冒頭タイトルの情報量を抑える。',
      promotions: [],
      promotion: undefined,
    }
    const filterableFeedback = {
      ...feedback,
      preferences: [observedPreference, ...feedback.preferences],
    }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, projects }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, feedback: filterableFeedback }))

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    await user.click(screen.getByRole('tab', { name: '好み・学び' }))

    const filters = await screen.findByRole('group', { name: '状態で絞り込む' })
    const allFilter = within(filters).getByRole('button', { name: 'すべて 4件' })
    expect(allFilter).toHaveAttribute('aria-pressed', 'true')

    await user.click(within(filters).getByRole('button', { name: '学習中 1件' }))
    expect(screen.getByText('全4件 / 表示1件')).toBeVisible()
    expect(screen.getByRole('button', { name: '字幕をセーフエリア内に収める。の詳細を見る' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '冒頭タイトルの情報量を抑える。の詳細を見る' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '和モダンの意匠を制作画面に取り入れる。の詳細を見る' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '選択した好み・学び' })).toHaveTextContent('字幕をセーフエリア内に収める。')

    await user.click(within(filters).getByRole('button', { name: '観測中 1件' }))
    expect(screen.getByRole('button', { name: '冒頭タイトルの情報量を抑える。の詳細を見る' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '字幕をセーフエリア内に収める。の詳細を見る' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: '選択した好み・学び' })).toHaveTextContent('冒頭タイトルの情報量を抑える。')

    await user.click(allFilter)
    expect(allFilter).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('全4件 / 表示4件')).toBeVisible()
    expect(screen.getByRole('button', { name: '字幕をセーフエリア内に収める。の詳細を見る' })).toBeVisible()
    expect(screen.getByRole('button', { name: '和モダンの意匠を制作画面に取り入れる。の詳細を見る' })).toBeVisible()
  })

  it('読み取り警告は最大5件の詳細と残件数を表示する', async () => {
    const user = userEvent.setup()
    const issues = Array.from({ length: 6 }, (_, index) => ({
      code: `feedback.issue_${index + 1}`,
      message: `確認が必要な記録${index + 1}`,
      projectName: `案件${index + 1}`,
      line: index + 10,
      path: `projects/project-${index + 1}/feedback.jsonl`,
    }))
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, projects }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        feedback: { ...feedback, metrics: { ...feedback.metrics, issues: 6 }, issues },
      }))

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    await user.click(screen.getByRole('tab', { name: '好み・学び' }))

    const warning = await screen.findByRole('status', { name: '読み取り警告' })
    expect(warning).toHaveTextContent('案件1')
    expect(warning).toHaveTextContent('feedback.issue_1')
    expect(warning).toHaveTextContent('10行')
    expect(warning).toHaveTextContent('確認が必要な記録1')
    expect(warning).not.toHaveTextContent('案件6')
    expect(warning).toHaveTextContent('ほか1件')
  })

  it('好み・学びを24件ずつ表示し、棚に戻ると表示件数を戻す', async () => {
    const user = userEvent.setup()
    const manyPreferences = Array.from({ length: 25 }, (_, index) => ({
      ...feedback.preferences[0]!,
      key: `preference-${index + 1}`,
      summary: `好み・学び ${String(index + 1).padStart(2, '0')}`,
    }))
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, projects }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        feedback: { ...feedback, preferences: manyPreferences },
      }))

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    const feedbackTab = screen.getByRole('tab', { name: '好み・学び' })
    await user.click(feedbackTab)

    expect(await screen.findByText('全25件 / 表示24件')).toBeVisible()
    expect(screen.queryByRole('button', { name: '好み・学び 25の詳細を見る' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '残り1件を表示' }))
    expect(screen.getByRole('button', { name: '好み・学び 25の詳細を見る' })).toBeVisible()

    await user.click(screen.getByRole('tab', { name: '制作案件' }))
    await user.click(feedbackTab)
    expect(screen.getByText('全25件 / 表示24件')).toBeVisible()
    expect(screen.queryByRole('button', { name: '好み・学び 25の詳細を見る' })).not.toBeInTheDocument()
  })

  it('好み・学びの読込失敗から再試行でき、空状態を案内する', async () => {
    const user = userEvent.setup()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, projects }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        feedback: {
          metrics: { observed: 0, recurring: 0, promoted: 0, verified: 0, issues: 0 },
          preferences: [],
          issues: [],
        },
      }))

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    await user.click(screen.getByRole('tab', { name: '好み・学び' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('好み・学びを読み込めませんでした。')
    await user.click(screen.getByRole('button', { name: '好み・学びをもう一度読み込む' }))
    expect(await screen.findByText('まだ整理された好み・学びはありません。')).toBeVisible()
    expect(screen.getByText('pipeline feedback')).toBeVisible()
    expect(screen.getByText('feedback.jsonl')).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(3)
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
    const projectCard = await screen.findByRole('button', { name: 'サンプル映像Aの制作記録を開く' })

    await user.click(projectCard)

    await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith(
      '/api/projects/project-alpha/refresh',
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
      viewerUrl: '/viewers/project-alpha/?updated=1',
      project: projects[0],
    }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/viewers/project-alpha/?updated=1'))
  })

  it('無効な案件と検索の空状態を、次の行動が分かる日本語で表示する', async () => {
    const user = userEvent.setup()
    const invalidProject = {
      ...projects[0],
      id: 'broken',
      name: '設定確認が必要な案件',
      valid: false,
      refreshable: false,
      hasViewer: false,
      viewerUrl: undefined,
      issue: 'manifest.jsonが見つかりません。',
    }
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ok: true, projects: [invalidProject] }))

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await user.click(await screen.findByRole('button', { name: '設定確認が必要な案件の設定を確認' }))

    const selectedPanel = screen.getByRole('complementary', { name: '選択した制作案件' })
    expect(within(selectedPanel).getByText('設定の確認が必要')).toBeVisible()
    expect(within(selectedPanel).getByText('manifest.jsonが見つかりません。')).toBeVisible()
    expect(screen.getByRole('button', { name: '最新状態に更新して開く' })).toBeDisabled()
    expect(screen.getByText('project.yamlと参照ファイルを確認してください。')).toBeVisible()

    await user.type(screen.getByRole('searchbox', { name: '制作案件を検索' }), '存在しない')
    expect(screen.getByText('検索条件に合う制作案件はありません。')).toBeVisible()
  })

  it('更新不能な理由を事前表示し、前回のViewerは開ける', async () => {
    const user = userEvent.setup()
    const unrefreshableProject = {
      ...projects[0],
      id: 'unsupported-showreel',
      name: '未対応ショーリール',
      valid: true,
      refreshable: false,
      hasViewer: true,
      viewerUrl: '/viewers/unsupported-showreel/',
      issue: "manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it",
    }
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ok: true, projects: [unrefreshableProject] }))
    const navigate = vi.fn()

    render(<LauncherApp fetcher={fetcher} navigate={navigate} token="session-token" />)

    const reasonCard = await screen.findByRole('button', { name: '未対応ショーリールの更新できない理由を確認' })
    expect(reasonCard).toHaveTextContent('最新状態に更新できません')
    expect(reasonCard).toHaveTextContent("manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it")
    expect(reasonCard).toHaveAccessibleDescription("manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it")

    const selectedPanel = screen.getByRole('complementary', { name: '選択した制作案件' })
    expect(within(selectedPanel).getByText("manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it")).toBeVisible()
    expect(within(selectedPanel).getByRole('button', { name: '最新状態に更新して開く' })).toBeDisabled()

    await user.click(reasonCard)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '完了で絞り込む' }))
    expect(screen.getByRole('button', { name: '未対応ショーリールの更新できない理由を確認' })).toBeVisible()
    await user.click(within(selectedPanel).getByRole('button', { name: '前回の表示を開く' }))
    expect(navigate).toHaveBeenCalledWith('/viewers/unsupported-showreel/')
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
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        issue: {
          code: 'viewer_launcher.project_invalid',
          message: '参照画像 section-01.png が見つかりません。',
        },
      }, false))
    const navigate = vi.fn()

    render(<LauncherApp fetcher={fetcher} navigate={navigate} />)
    await screen.findByRole('button', { name: 'サンプル映像Aの制作記録を開く' })
    await user.click(screen.getByRole('button', { name: '最新状態に更新して開く' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '最新の制作記録を開けませんでした。参照画像 section-01.png が見つかりません。',
    )
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/projects/project-alpha/refresh',
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
