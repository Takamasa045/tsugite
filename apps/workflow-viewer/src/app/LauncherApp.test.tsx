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
    revision: 'revision-alpha',
    status: 'completed',
    updatedAt: '2026-07-15T09:30:00+09:00',
    hasViewer: true,
    viewerUrl: '/viewers/project-alpha/',
    thumbnailUrl: '/thumbnail/project-alpha',
    valid: true,
    refreshable: true,
    workflowNodes: [
      { id: 'validate', label: '検証', status: 'completed' as const, action: 'validate' as const },
      { id: 'gate-3', label: '完成確認', status: 'completed' as const, action: 'gate-3-approve' as const },
    ],
    availableActions: ['validate', 'review'] as const,
  },
  {
    id: 'codex-goal-talk-paper',
    name: 'Codex Goal Talk',
    slug: 'codex-goal-talk-paper',
    runId: 'codex-goal-talk-paper-r6',
    revision: 'revision-codex',
    status: 'running',
    updatedAt: '2026-07-15T10:00:00+09:00',
    hasViewer: false,
    valid: true,
    refreshable: true,
    workflowNodes: [
      { id: 'validate', label: '検証', status: 'completed' as const, action: 'validate' as const },
      { id: 'run', label: '素材生成', status: 'pending' as const, action: 'run' as const },
    ],
    availableActions: ['validate', 'run'] as const,
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
    requiredInputDetails: [
      { type: 'text' as const, label: '記事本文と出典' },
      { type: 'image' as const, label: '2人分のキャラクター画像' },
    ],
    preview: {
      frames: [
        { kind: 'text' as const, label: '記事の要点' },
        { kind: 'person' as const, label: '初心者の質問' },
        { kind: 'interface' as const, label: '解説とまとめ' },
      ],
      flow: ['記事の要点', '疑問を代弁', '専門家が解説', '要点を回収'],
    },
    notFor: ['実演だけで魅力が伝わる商品'],
    variants: [
      {
        id: 'cast',
        label: 'キャラクター構成',
        defaultOptionId: 'beginner-expert',
        options: [
          { id: 'beginner-expert', label: '初心者＋専門家', description: '初心者が問い、専門家が答える定番構成です。' },
          { id: 'peer-dialogue', label: '同僚同士', description: '同じ目線の二人で事例を整理します。' },
        ],
      },
      {
        id: 'background',
        label: '背景',
        options: [
          { id: 'paper-cutout', label: '紙の切り絵', description: '紙素材と柔らかな陰影で見せます。' },
          { id: 'ui-window', label: '画面デモ', description: '製品画面や操作例を背景に表示します。' },
        ],
      },
    ],
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
    requiredInputDetails: [
      { type: 'text' as const, label: '質問と回答の一覧' },
      { type: 'image' as const, label: '2人分のキャラクター画像' },
    ],
    preview: null,
    notFor: [],
    variants: [],
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
    requiredInputDetails: [],
    preview: null,
    notFor: [],
    variants: [],
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
  {
    id: 'invalid-preview-shape',
    name: '旧形式プレビュー',
    summary: '不完全なプレビューでも安全な構成イメージへ戻します。',
    category: '記事を動画化',
    useCases: ['旧形式の確認'],
    duration: '30秒',
    aspectRatio: '16:9',
    requiredInputs: ['台本'],
    requiredInputDetails: [{ type: 'text' as const, label: '台本' }],
    preview: {
      frames: [{ kind: 'text' as const, label: '導入だけ' }],
      flow: ['導入だけ'],
    },
    notFor: [],
    variants: [],
    tags: ['旧形式'],
    audio: '音声は任意です。',
    status: 'stable' as const,
    distribution: 'local-only' as const,
    valid: true,
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
        promotedAt: '2026-07-17T08:20:00+09:00',
      },
      promotions: [
        {
          projectId: 'sample-a',
          projectName: 'サンプル案件A',
          kind: 'template' as const,
          target: 'templates/wa-modern-launcher',
          promotedAt: '2026-07-17T08:20:00+09:00',
        },
        {
          projectId: 'sample-b',
          projectName: 'サンプル案件B',
          kind: 'rule' as const,
          target: 'LESSONS.md#wa-modern',
          promotedAt: '2026-07-17T08:30:00+09:00',
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
        source: {
          kind: 'codex_automation' as const,
          workflowId: 'tsugite-learning-promotion-review',
          runId: 'review-run-20260717',
        },
      },
      lastSeenAt: '2026-07-17T09:00:00+09:00',
    },
  ],
  issues: [],
}

function jsonResponse(input: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => input } as Response
}

function createLauncherFetcher({
  projectList = projects,
  feedbackAggregate = feedback,
  templateList = templates,
}: {
  projectList?: unknown
  feedbackAggregate?: unknown
  templateList?: unknown
} = {}) {
  return vi.fn().mockImplementation((url: string) => {
    if (url === '/api/projects') return Promise.resolve(jsonResponse({ ok: true, projects: projectList }))
    if (url === '/api/feedback') return Promise.resolve(jsonResponse({ ok: true, feedback: feedbackAggregate }))
    if (url === '/api/templates') return Promise.resolve(jsonResponse({ ok: true, templates: templateList }))
    return Promise.resolve(jsonResponse({ ok: false }, false))
  })
}

describe('LauncherApp', () => {
  it('初回起動で dedicated workflow の確認待ちだけをタブとピックアップへ表示する', async () => {
    const user = userEvent.setup()
    const manualPending = {
      ...feedback.preferences[2]!,
      key: 'manual-pending',
      summary: '手動で記録した昇格案。',
      promotionProposal: {
        ...feedback.preferences[2]!.promotionProposal!,
        id: 'manual-pending-v1',
        source: undefined,
      },
    }
    const otherWorkflowPending = {
      ...feedback.preferences[2]!,
      key: 'other-workflow-pending',
      summary: '別のworkflowが作成した昇格案。',
      promotionProposal: {
        ...feedback.preferences[2]!.promotionProposal!,
        id: 'other-workflow-pending-v1',
        source: {
          kind: 'codex_automation' as const,
          workflowId: 'another-workflow',
        },
      },
    }
    const claudeDesktopPending = {
      ...feedback.preferences[2]!,
      key: 'claude-desktop-pending',
      summary: 'Claude Desktopが見つけた昇格案。',
      promotionProposal: {
        ...feedback.preferences[2]!.promotionProposal!,
        id: 'claude-desktop-pending-v1',
        source: {
          kind: 'claude_desktop_automation' as const,
          workflowId: 'tsugite-learning-promotion-review',
        },
      },
    }
    const claudeCodePending = {
      ...feedback.preferences[2]!,
      key: 'claude-code-pending',
      summary: 'Claude Codeが見つけた昇格案。',
      promotionProposal: {
        ...feedback.preferences[2]!.promotionProposal!,
        id: 'claude-code-pending-v1',
        source: {
          kind: 'claude_code_automation' as const,
          workflowId: 'tsugite-learning-promotion-review',
        },
      },
    }
    const fetcher = createLauncherFetcher({
      feedbackAggregate: {
        ...feedback,
        preferences: [
          ...feedback.preferences,
          manualPending,
          otherWorkflowPending,
          claudeDesktopPending,
          claudeCodePending,
        ],
      },
    })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    const feedbackTab = screen.getByRole('tab', { name: '好み・学び' })
    await waitFor(() => expect(feedbackTab).toHaveAccessibleDescription('確認待ちの学び 3件'))
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/feedback')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: '制作案件を選ぶ' })).toBeVisible()
    await user.click(feedbackTab)

    expect(await screen.findByRole('heading', { name: '制作に活かす学び' })).toBeVisible()
    expect(feedbackTab).toHaveTextContent('3')
    const pickup = screen.getByRole('region', { name: '確認してほしい学び' })
    const pickupButton = within(pickup).getByRole('button', {
      name: '「字幕をセーフエリア内に収める。」の昇格案を確認',
    })
    expect(pickupButton).toBeVisible()
    expect(within(pickup).getByRole('button', {
      name: '「Claude Desktopが見つけた昇格案。」の昇格案を確認',
    })).toBeVisible()
    expect(within(pickup).getByRole('button', {
      name: '「Claude Codeが見つけた昇格案。」の昇格案を確認',
    })).toBeVisible()
    expect(within(pickup).queryByText('手動で記録した昇格案。')).not.toBeInTheDocument()
    expect(within(pickup).queryByText('別のworkflowが作成した昇格案。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '手動で記録した昇格案。の詳細を見る' })).toBeVisible()
    expect(screen.getByRole('button', { name: '別のworkflowが作成した昇格案。の詳細を見る' })).toBeVisible()

    await user.click(pickupButton)
    expect(screen.getByRole('complementary', { name: '選択した好み・学び' })).toHaveTextContent('字幕をセーフエリア内に収める。')
    expect(feedbackTab).toHaveAccessibleDescription('確認待ちの学び 3件')
    expect(screen.queryByRole('region', { name: '昇格承認待ちの通知' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '承認待ちの通知を有効にする' })).not.toBeInTheDocument()
    expect(screen.queryByText(/デスクトップ通知/)).not.toBeInTheDocument()
  })

  it('見送りの記録に成功したときだけ、確認待ち件数とピックアップから外す', async () => {
    const user = userEvent.setup()
    let decisionAttempts = 0
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse({ ok: true, projects }))
      if (url === '/api/feedback') return Promise.resolve(jsonResponse({ ok: true, feedback }))
      decisionAttempts += 1
      return Promise.resolve(decisionAttempts === 1
        ? jsonResponse({ ok: false }, false)
        : jsonResponse({ ok: true, decision: 'rejected' }))
    })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    const feedbackTab = screen.getByRole('tab', { name: '好み・学び' })
    await waitFor(() => expect(feedbackTab).toHaveAccessibleDescription('確認待ちの学び 1件'))
    await user.click(feedbackTab)

    const pickup = await screen.findByRole('region', { name: '確認してほしい学び' })
    await user.click(within(pickup).getByRole('button', {
      name: '「字幕をセーフエリア内に収める。」の昇格案を確認',
    }))
    expect(feedbackTab).toHaveAccessibleDescription('確認待ちの学び 1件')

    await user.click(screen.getByRole('button', { name: '今回は見送る' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('承認結果を記録できませんでした')
    expect(screen.getByRole('region', { name: '確認してほしい学び' })).toBeVisible()
    expect(feedbackTab).toHaveAccessibleDescription('確認待ちの学び 1件')

    await user.click(screen.getByRole('button', { name: '今回は見送る' }))

    await waitFor(() => expect(screen.queryByRole('region', { name: '確認してほしい学び' })).not.toBeInTheDocument())
    expect(feedbackTab).not.toHaveAttribute('aria-describedby')
    expect(screen.getByRole('complementary', { name: '選択した好み・学び' })).toHaveTextContent('見送り済み')
  })

  it('既決定の409競合は最新feedbackを再取得し、詳細・件数・ピックアップを同期する', async () => {
    const user = userEvent.setup()
    let feedbackGetCount = 0
    const decidedFeedback = {
      ...feedback,
      preferences: feedback.preferences.map((preference) => (
        preference.key === 'caption-safe-area' && preference.promotionProposal
          ? {
              ...preference,
              promotionProposal: {
                ...preference.promotionProposal,
                decision: 'approved' as const,
                decidedAt: '2026-07-17T10:15:00.000Z',
                decidedBy: 'human' as const,
              },
            }
          : preference
      )),
    }
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse({ ok: true, projects }))
      if (url === '/api/feedback') {
        feedbackGetCount += 1
        return Promise.resolve(jsonResponse({
          ok: true,
          feedback: feedbackGetCount === 1 ? feedback : decidedFeedback,
        }))
      }
      return Promise.resolve(jsonResponse({
        ok: false,
        issue: {
          code: 'feedback.proposal_already_decided',
          message: 'promotion proposal was already decided',
        },
      }, false, 409))
    })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    const feedbackTab = screen.getByRole('tab', { name: '好み・学び' })
    await waitFor(() => expect(feedbackTab).toHaveAccessibleDescription('確認待ちの学び 1件'))
    await user.click(feedbackTab)

    const pickup = await screen.findByRole('region', { name: '確認してほしい学び' })
    await user.click(within(pickup).getByRole('button', {
      name: '「字幕をセーフエリア内に収める。」の昇格案を確認',
    }))
    await user.click(screen.getByRole('button', { name: '昇格を承認' }))

    await waitFor(() => expect(feedbackGetCount).toBe(2))
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/feedback')).toHaveLength(2)
    expect(screen.queryByRole('region', { name: '確認してほしい学び' })).not.toBeInTheDocument()
    expect(feedbackTab).not.toHaveAttribute('aria-describedby')
    expect(screen.getByRole('complementary', { name: '選択した好み・学び' })).toHaveTextContent('承認済み')
    expect(screen.queryByText('承認済み・反映待ち')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
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

  it('既定のfetchで案件と好み・学びを初回に一度ずつ取得する', async () => {
    const fetcher = createLauncherFetcher()
    vi.stubGlobal('fetch', fetcher)

    render(<LauncherApp token="session-token" />)

    expect(await screen.findByRole('heading', { name: '制作の見取図を開く' })).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/projects')).toHaveLength(1)
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/feedback')).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('案件を読み込み、検索と最近更新した案件を案内する', async () => {
    const user = userEvent.setup()
    const fetcher = createLauncherFetcher()

    render(<LauncherApp fetcher={fetcher} token="session-token" />)

    expect(screen.getByText('制作案件を読み込んでいます…')).toBeVisible()
    expect(await screen.findByRole('heading', { name: '制作の見取図を開く' })).toBeVisible()
    expect(document.querySelector('img.launcher-favicon-mark[src="./assets/tsugite-favicon.png"]')).toBeInTheDocument()
    expect(screen.getByText('全2件 / 表示2件')).toBeVisible()
    const selectedPanel = screen.getByRole('complementary', { name: '選択した制作案件' })
    expect(within(selectedPanel).getByRole('heading', { name: 'Codex Goal Talk' })).toBeVisible()
    expect(within(selectedPanel).queryByRole('region', { name: 'Codex Goal Talkの制作工程' })).not.toBeInTheDocument()
    expect(within(selectedPanel).queryByRole('button', { name: '生成キャンバスを開く' })).not.toBeInTheDocument()
    expect(within(selectedPanel).getByText('制作中')).toBeVisible()
    expect(within(selectedPanel).getByText(/2026\/07\/15/)).toBeVisible()
    expect(document.querySelector('img[src="/thumbnail/project-alpha"]')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: '制作案件を検索' }), 'サンプル映像A')
    expect(screen.getByText('全2件 / 表示1件')).toBeVisible()
    const projectList = screen.getByRole('region', { name: '制作案件を選ぶ' })
    expect(within(projectList).queryByRole('heading', { name: 'Codex Goal Talk' })).not.toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: '制作案件を検索' }))
  })

  it('初期選択は表示順と同じupdatedAt降順で最新のvalid案件にする', async () => {
    const newestInvalid = {
      ...projects[0],
      id: 'newest-invalid',
      name: '最新の要確認案件',
      updatedAt: '2026-07-16T12:00:00+09:00',
      valid: false,
      refreshable: false,
    }
    const newestValid = {
      ...projects[1],
      id: 'newest-valid',
      name: '最新の有効案件',
      updatedAt: '2026-07-16T11:00:00+09:00',
    }
    const olderValid = {
      ...projects[0],
      id: 'older-valid',
      name: '古い有効案件',
      updatedAt: '2026-07-16T10:00:00+09:00',
    }
    const fetcher = createLauncherFetcher({
      projectList: [olderValid, newestInvalid, newestValid],
    })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)

    const projectList = await screen.findByRole('region', { name: '制作案件を選ぶ' })
    expect(within(projectList).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      '最新の要確認案件',
      '最新の有効案件',
      '古い有効案件',
    ])
    expect(within(screen.getByRole('complementary', { name: '選択した制作案件' }))
      .getByRole('heading', { name: '最新の有効案件' })).toBeVisible()
  })

  it('制作案件棚を画面に残したまま手動再取得し、存在する選択を維持する', async () => {
    const user = userEvent.setup()
    const initiallySelected = {
      ...projects[0],
      updatedAt: '2026-07-16T10:00:00+09:00',
    }
    const olderProject = {
      ...projects[1],
      updatedAt: '2026-07-16T09:00:00+09:00',
    }
    const newlyUpdatedProject = {
      ...projects[1],
      id: 'newly-updated-project',
      name: '新しく更新された案件',
      updatedAt: '2026-07-16T11:00:00+09:00',
    }
    let projectRequestCount = 0
    let resolveRefresh!: (response: Response) => void
    const refreshRequest = new Promise<Response>((resolve) => { resolveRefresh = resolve })
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/feedback') return Promise.resolve(jsonResponse({ ok: true, feedback }))
      if (url === '/api/projects') {
        projectRequestCount += 1
        return projectRequestCount === 1
          ? Promise.resolve(jsonResponse({ ok: true, projects: [olderProject, initiallySelected] }))
          : refreshRequest
      }
      return Promise.resolve(jsonResponse({ ok: false }, false))
    })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)

    const selectedPanel = await screen.findByRole('complementary', { name: '選択した制作案件' })
    expect(within(selectedPanel).getByRole('heading', { name: 'サンプル映像A' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '制作案件を再読み込み' }))

    const refreshingButton = screen.getByRole('button', { name: '制作案件を再読み込み中…' })
    expect(refreshingButton).toBeDisabled()
    expect(refreshingButton).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('heading', { name: '制作の見取図を開く' })).toBeVisible()
    expect(within(selectedPanel).getByRole('heading', { name: 'サンプル映像A' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'サンプル映像Aの制作工程を選ぶ' })).toBeDisabled()
    expect(within(selectedPanel).getByRole('button', { name: '最新状態に更新して開く' })).toBeDisabled()

    resolveRefresh(jsonResponse({
      ok: true,
      projects: [newlyUpdatedProject, initiallySelected],
    }))

    expect(await screen.findByRole('heading', { name: '新しく更新された案件' })).toBeVisible()
    expect(within(selectedPanel).getByRole('heading', { name: 'サンプル映像A' })).toBeVisible()
    expect(screen.getByRole('button', { name: '制作案件を再読み込み' })).toBeEnabled()
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/projects')).toHaveLength(2)
  })

  it('手動再取得に失敗しても現在の制作案件棚と選択を残す', async () => {
    const user = userEvent.setup()
    let projectRequestCount = 0
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/feedback') return Promise.resolve(jsonResponse({ ok: true, feedback }))
      projectRequestCount += 1
      return projectRequestCount === 1
        ? Promise.resolve(jsonResponse({ ok: true, projects }))
        : Promise.reject(new Error('offline'))
    })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    const selectedPanel = await screen.findByRole('complementary', { name: '選択した制作案件' })

    await user.click(screen.getByRole('button', { name: '制作案件を再読み込み' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('制作案件を再読み込みできませんでした。')
    expect(screen.getByRole('heading', { name: '制作の見取図を開く' })).toBeVisible()
    expect(within(selectedPanel).getByRole('heading', { name: 'Codex Goal Talk' })).toBeVisible()
  })

  it('大量の案件を最近更新順に12件ずつ表示し、状態で絞り込める', async () => {
    const user = userEvent.setup()
    const manyProjects = Array.from({ length: 14 }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `案件${String(index + 1).padStart(2, '0')}`,
      slug: `project-${index + 1}`,
      runId: `run-${index + 1}`,
      revision: `revision-${index + 1}`,
      status: index % 2 === 0 ? 'completed' : 'running',
      updatedAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00+09:00`,
      hasViewer: false,
      valid: true,
      refreshable: true,
      workflowNodes: [],
      availableActions: [],
    }))
    const fetcher = createLauncherFetcher({ projectList: manyProjects })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('button', { name: '案件14の制作工程を選ぶ' })

    expect(screen.getByText('全14件 / 表示12件')).toBeVisible()
    expect(screen.queryByRole('button', { name: '案件02の制作工程を選ぶ' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '残り2件を表示' }))
    expect(screen.getByText('全14件 / 表示14件')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '制作中で絞り込む' }))
    expect(screen.getByText('全14件 / 表示7件')).toBeVisible()
    expect(screen.queryByRole('button', { name: '案件13の制作工程を選ぶ' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '案件14の制作工程を選ぶ' })).toBeVisible()
    expect(screen.getByRole('button', { name: '案件02の制作工程を選ぶ' })).toBeVisible()
  })

  it('テンプレート棚を必要時に読み込み、検索・用途絞り込み・詳細確認ができる', async () => {
    const user = userEvent.setup()
    const fetcher = createLauncherFetcher()

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    expect(fetcher).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('tab', { name: 'テンプレート' }))
    expect(await screen.findByRole('heading', { name: 'テンプレートを選ぶ' })).toBeVisible()
    expect(fetcher).toHaveBeenLastCalledWith('/api/templates', {
      headers: { accept: 'application/json' },
    })
    expect(screen.getByText('全4件 / 表示4件')).toBeVisible()

    const storyboardCard = screen.getByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ })
    expect(within(storyboardCard).getByText('構成イメージ')).toBeVisible()
    expect(within(storyboardCard).getAllByRole('img')).toHaveLength(3)
    expect(within(storyboardCard).getByText('60秒 · 16:9')).toBeVisible()
    expect(within(storyboardCard).getByText('記事の要点 → 疑問を代弁 → 専門家が解説 → 要点を回収')).toBeVisible()
    expect(within(storyboardCard).getByText('テキスト')).toBeVisible()
    expect(within(storyboardCard).getByText('画像')).toBeVisible()
    expect(storyboardCard).toHaveAttribute('aria-describedby', 'launcher-template-card-a11y-blog-dialogue-60s')
    expect(document.getElementById('launcher-template-card-a11y-blog-dialogue-60s')).toHaveTextContent(
      '60秒、16:9。構成: 記事の要点、疑問を代弁、専門家が解説、要点を回収。必要素材: テキスト、画像。',
    )

    const fallbackCard = screen.getByRole('button', { name: /Q&A掛け合いを選ぶ/ })
    expect(within(fallbackCard).getByText('構成イメージ')).toBeVisible()
    expect(within(fallbackCard).getAllByRole('img')).toHaveLength(3)
    expect(within(fallbackCard).getByText('プレビュー準備中')).toBeVisible()

    const invalidPreviewCard = screen.getByRole('button', { name: /旧形式プレビューを選ぶ/ })
    expect(within(invalidPreviewCard).getAllByRole('img')).toHaveLength(3)
    expect(within(invalidPreviewCard).getByText('プレビュー準備中')).toBeVisible()

    const detail = screen.getByRole('complementary', { name: '選択したテンプレート' })
    expect(within(detail).getByRole('heading', { name: 'ブログ掛け合い 60秒' })).toBeVisible()
    expect(within(detail).getByText('ブログ記事を初心者役と解説役の会話で伝える動画です。')).toBeVisible()
    expect(within(detail).getByText('記事本文と出典')).toBeVisible()
    expect(within(detail).getByRole('heading', { name: '選べるバリエーション' })).toBeVisible()
    expect(within(detail).getByText('キャラクター構成')).toBeVisible()
    expect(within(detail).getByText('初心者＋専門家')).toBeVisible()
    expect(within(detail).getByText('紙の切り絵')).toBeVisible()
    expect(within(detail).getByRole('heading', { name: '構成の流れ' })).toBeVisible()
    expect(within(detail).getByText('専門家が解説')).toBeVisible()
    expect(within(detail).getByRole('heading', { name: '向いている用途' })).toBeVisible()
    expect(within(detail).getByText('初心者向け解説')).toBeVisible()
    expect(within(detail).getByRole('heading', { name: '向かない用途' })).toBeVisible()
    expect(within(detail).getByText('実演だけで魅力が伝わる商品')).toBeVisible()
    expect(within(detail).getByRole('heading', { name: '同じ系統のテンプレート' })).toBeVisible()
    expect(within(detail).getByText('Q&A掛け合い')).toBeVisible()
    expect(within(detail).getByText('閲覧専用')).toBeVisible()

    const relatedTemplate = within(detail).getByRole('button', {
      name: 'Q&A掛け合い Q&A件数に応じて可変 · 16:9',
    })
    await user.click(relatedTemplate)
    expect(await within(detail).findByRole('heading', { name: 'Q&A掛け合い' })).toHaveFocus()

    await user.type(screen.getByRole('searchbox', { name: 'テンプレートを検索' }), '紙の切り絵')
    expect(screen.getByText('全4件 / 表示1件')).toBeVisible()
    expect(screen.getByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ })).toBeVisible()

    await user.clear(screen.getByRole('searchbox', { name: 'テンプレートを検索' }))
    await user.type(screen.getByRole('searchbox', { name: 'テンプレートを検索' }), 'FAQ')
    expect(screen.getByText('全4件 / 表示1件')).toBeVisible()
    expect(screen.getByRole('button', { name: /Q&A掛け合いを選ぶ/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: /ブログ掛け合い 60秒を選ぶ/ })).not.toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: 'テンプレートを検索' }))
    await user.click(screen.getByRole('button', { name: 'Q&A・FAQで絞り込む' }))
    expect(screen.getByText('全4件 / 表示1件')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /Q&A掛け合いを選ぶ/ }))
    expect(within(detail).getByText(/Q&A件数に応じて可変/)).toBeVisible()

    await user.click(screen.getByRole('tab', { name: '制作案件' }))
    expect(screen.getByRole('heading', { name: '制作案件を選ぶ' })).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('テンプレート一覧の読込失敗から再試行できる', async () => {
    const user = userEvent.setup()
    let templateAttempts = 0
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse({ ok: true, projects }))
      if (url === '/api/feedback') return Promise.resolve(jsonResponse({ ok: true, feedback }))
      templateAttempts += 1
      return templateAttempts === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(jsonResponse({ ok: true, templates: [] }))
    })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    await user.click(screen.getByRole('tab', { name: 'テンプレート' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('テンプレートを読み込めませんでした。')
    await user.click(screen.getByRole('button', { name: 'テンプレートをもう一度読み込む' }))
    expect(await screen.findByText('表示できるテンプレートはまだありません。')).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('初回起動で読み込んだ好み・学びの4段階と根拠を表示する', async () => {
    const user = userEvent.setup()
    let resolveFeedback!: (response: Response) => void
    const feedbackRequest = new Promise<Response>((resolve) => { resolveFeedback = resolve })
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse({ ok: true, projects }))
      if (url === '/api/feedback') return feedbackRequest
      if (url === '/api/feedback/sample-a/promotion-decision') {
        return Promise.resolve(jsonResponse({ ok: true, decision: 'approved' }))
      }
      return Promise.resolve(jsonResponse({ ok: false }, false))
    })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    expect(fetcher).toHaveBeenCalledTimes(2)

    const feedbackTab = screen.getByRole('tab', { name: '好み・学び' })
    await user.click(feedbackTab)
    expect(feedbackTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('好み・学びを整理しています…')).toBeVisible()
    expect(fetcher).toHaveBeenLastCalledWith('/api/feedback', {
      headers: { accept: 'application/json' },
    })

    resolveFeedback(jsonResponse({ ok: true, feedback }))
    const metrics = await screen.findByLabelText('学びの4段階')
    expect(within(metrics).getByText('記録').parentElement).toHaveTextContent('記録 / 到達済み3')
    expect(within(metrics).getByText('学習中').parentElement).toHaveTextContent('学習中 / 到達済み2')
    expect(within(metrics).getByText('反映済み').parentElement).toHaveTextContent('反映済み / 到達済み1')
    expect(within(metrics).getByText('効果確認済み').parentElement).toHaveTextContent('効果確認済み / 到達済み1')

    const stageGuide = screen.getByRole('region', { name: '記録の状態' })
    expect(within(stageGuide).getByText('まず1件を記録')).toBeVisible()
    expect(within(stageGuide).getByText('同じ傾向を確認中')).toBeVisible()
    expect(within(stageGuide).getByText('制作ルールに反映済み')).toBeVisible()
    expect(within(stageGuide).getByText('反映後の効果を確認済み')).toBeVisible()
    expect(within(stageGuide).getByRole('heading', { name: 'この記録は今どこ？' })).toBeVisible()
    expect(within(stageGuide).getByText('承認は状態ではありません。')).toBeVisible()

    const promotedCard = screen.getByRole('button', { name: '和モダンの意匠を制作画面に取り入れる。の詳細を見る' })
    expect(promotedCard).toHaveAttribute('aria-pressed', 'true')
    expect(promotedCard).toHaveTextContent('画面デザイン')
    expect(promotedCard).toHaveTextContent('取り入れたい')
    expect(promotedCard).toHaveTextContent('3案件')
    expect(promotedCard).toHaveTextContent('反映済み')
    expect(promotedCard).toHaveTextContent('templates/wa-modern-launcher')
    expect(promotedCard).toHaveTextContent('反映 2026/07/17 08:20')
    expect(promotedCard).toHaveTextContent('ほか1件')
    expect(promotedCard).toHaveTextContent('制作ルールに反映済み')

    const detail = screen.getByRole('complementary', { name: '選択した好み・学び' })
    expect(within(detail).getAllByText('サンプル案件A').length).toBeGreaterThan(0)
    expect(within(detail).getByText('sample-a-r3')).toBeVisible()
    expect(within(detail).getByText('projects/sample-a/notes.md')).toBeVisible()
    const promotionSection = within(detail).getByRole('heading', { name: '昇格先' }).closest('section')
    expect(promotionSection).not.toBeNull()
    expect(within(promotionSection!).getByText('LESSONS.md#wa-modern')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '冒頭からBGMまたは短いSFXを入れる。の詳細を見る' }))
    expect(within(detail).getByText('適用確認').parentElement).toHaveTextContent('反映後の効果を確認済み')

    const recurringCard = screen.getByRole('button', { name: '字幕をセーフエリア内に収める。の詳細を見る' })
    expect(recurringCard).toHaveTextContent('同じ傾向を確認中')
    expect(recurringCard).toHaveTextContent('昇格承認待ち')
    await user.click(recurringCard)
    expect(within(detail).getByText('次の段階').parentElement).toHaveTextContent('昇格案を確認し、人が承認または見送り')
    const approvalSection = within(detail).getByRole('heading', { name: '昇格承認' }).closest('section')
    expect(approvalSection).not.toBeNull()
    expect(within(approvalSection!).getByText('字幕のセーフエリア判定をGate 3へ追加する。')).toBeVisible()
    expect(within(approvalSection!).getByText('後続案件のgate3-qc.jsonと代表フレームで確認する。')).toBeVisible()
    expect(within(approvalSection!).getByRole('button', { name: '昇格を承認' })).toBeVisible()
    expect(within(approvalSection!).getByRole('button', { name: '今回は見送る' })).toBeVisible()

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
    expect(await within(detail).findByText('承認済み')).toBeVisible()
    expect(within(detail).getByText('次の段階').parentElement).toHaveTextContent('共有先へ反映し、テストして反映済みへ')
    expect(within(detail).getByRole('heading', { name: '次にすること' }).parentElement).toHaveTextContent('承認は記録済みです。共有先へ実装')
    expect(screen.queryByRole('region', { name: '確認してほしい学び' })).not.toBeInTheDocument()
    expect(feedbackTab).not.toHaveAttribute('aria-describedby')

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

    await user.click(within(filters).getByRole('button', { name: '記録 1件' }))
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
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse({ ok: true, projects }))
      if (url === '/api/feedback') return Promise.resolve(jsonResponse({ ok: true, feedback }))
      return refreshRequest
    })
    const navigate = vi.fn()

    render(<LauncherApp fetcher={fetcher} navigate={navigate} token="session-token" />)
    const projectCard = await screen.findByRole('button', { name: 'サンプル映像Aの制作工程を選ぶ' })

    await user.click(projectCard)
    expect(navigate).not.toHaveBeenCalled()
    await user.click(within(screen.getByRole('complementary', { name: '選択した制作案件' }))
      .getByRole('button', { name: '最新状態に更新して開く' }))

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

  it('左のサムネイルから最新の3Dワークフローへ直接移動する', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse({ ok: true, projects }))
      if (url === '/api/feedback') return Promise.resolve(jsonResponse({ ok: true, feedback }))
      if (url === '/api/projects/project-alpha/refresh') {
        return Promise.resolve(jsonResponse({
          ok: true,
          viewerUrl: '/viewers/project-alpha/?from=thumbnail',
          project: projects[0],
        }))
      }
      return Promise.resolve(jsonResponse({ ok: false }, false))
    })
    const navigate = vi.fn()

    render(<LauncherApp fetcher={fetcher} navigate={navigate} token="session-token" />)

    await user.click(await screen.findByRole('button', {
      name: 'サンプル映像Aの3Dワークフローを最新にして開く',
    }))

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      '/api/projects/project-alpha/refresh',
      expect.objectContaining({ method: 'POST' }),
    ))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/viewers/project-alpha/?from=thumbnail'))
  })

  it('variantsが欠けたテンプレート応答を棚のエラーとして扱う', async () => {
    const user = userEvent.setup()
    const malformedTemplate = { ...templates[0] } as Record<string, unknown>
    delete malformedTemplate.variants
    const fetcher = createLauncherFetcher({ templateList: [malformedTemplate] })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)
    await screen.findByRole('heading', { name: '制作の見取図を開く' })
    await user.click(screen.getByRole('tab', { name: 'テンプレート' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('テンプレートを読み込めませんでした。')
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
    const fetcher = createLauncherFetcher({ projectList: [invalidProject] })

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
    const fetcher = createLauncherFetcher({ projectList: [unrefreshableProject] })
    const navigate = vi.fn()

    render(<LauncherApp fetcher={fetcher} navigate={navigate} token="session-token" />)

    const reasonCard = await screen.findByRole('button', { name: '未対応ショーリールの更新できない理由を確認' })
    expect(reasonCard).toHaveTextContent('最新状態に更新できません')
    expect(reasonCard).toHaveTextContent("manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it")
    expect(reasonCard).toHaveAccessibleDescription("manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it")

    await user.click(screen.getByRole('button', { name: '未対応ショーリールの前回の3Dワークフローを開く' }))
    expect(navigate).toHaveBeenCalledWith('/viewers/unsupported-showreel/')
    navigate.mockClear()

    const selectedPanel = screen.getByRole('complementary', { name: '選択した制作案件' })
    expect(within(selectedPanel).getByText("manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it")).toBeVisible()
    expect(within(selectedPanel).getByRole('button', { name: '最新状態に更新して開く' })).toBeDisabled()

    await user.click(reasonCard)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: '完了で絞り込む' }))
    expect(screen.getByRole('button', { name: '未対応ショーリールの更新できない理由を確認' })).toBeVisible()
    await user.click(within(selectedPanel).getByRole('button', { name: '前回の表示を開く' }))
    expect(navigate).toHaveBeenCalledWith('/viewers/unsupported-showreel/')
  })

  it('Viewer更新で許容する実行能力の不一致を警告し、要確認に分類する', async () => {
    const user = userEvent.setup()
    const capabilityWarningProject = {
      ...projects[0],
      id: 'viewer-refreshable-warning',
      name: '実行条件要確認',
      issue: "manifest requires presentation preset 'unsupported-showreel-16x9', but backend does not support it",
    }
    const fetcher = createLauncherFetcher({ projectList: [capabilityWarningProject] })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)

    const warningCard = await screen.findByRole('button', { name: '実行条件要確認の注意事項を確認' })
    expect(warningCard).toHaveTextContent('実行条件の確認が必要')
    expect(warningCard).toHaveAccessibleDescription(capabilityWarningProject.issue)

    const selectedPanel = screen.getByRole('complementary', { name: '選択した制作案件' })
    expect(within(selectedPanel).getByText('Viewerは更新できますが実行条件の確認が必要です')).toBeVisible()
    expect(within(selectedPanel).getByText(capabilityWarningProject.issue)).toBeVisible()
    expect(within(selectedPanel).getByRole('button', { name: '最新状態に更新して開く' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '要確認で絞り込む' }))
    expect(warningCard).toBeVisible()
  })

  it('metaのsession tokenを使い、更新失敗時はViewerへ移動しない', async () => {
    const user = userEvent.setup()
    const meta = document.createElement('meta')
    meta.name = 'tsugite-launcher-token'
    meta.content = 'meta-session-token'
    document.head.append(meta)
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse({ ok: true, projects }))
      if (url === '/api/feedback') return Promise.resolve(jsonResponse({ ok: true, feedback }))
      return Promise.resolve(jsonResponse({
        ok: false,
        issue: {
          code: 'viewer_launcher.project_invalid',
          message: '参照画像 section-01.png が見つかりません。',
        },
      }, false))
    })
    const navigate = vi.fn()

    render(<LauncherApp fetcher={fetcher} navigate={navigate} />)
    await screen.findByRole('button', { name: 'サンプル映像Aの制作工程を選ぶ' })
    await user.click(screen.getByRole('button', { name: '最新状態に更新して開く' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '最新の制作記録を開けませんでした。参照画像 section-01.png が見つかりません。',
    )
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/projects/codex-goal-talk-paper/refresh',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-tsugite-token': 'meta-session-token' }),
      }),
    )
    expect(navigate).not.toHaveBeenCalled()
    meta.remove()
  })

  it('一覧取得の失敗から再読込でき、空の一覧も案内する', async () => {
    const user = userEvent.setup()
    let projectAttempts = 0
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/feedback') return Promise.resolve(jsonResponse({ ok: true, feedback }))
      projectAttempts += 1
      return projectAttempts === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(jsonResponse({ ok: true, projects: [] }))
    })

    render(<LauncherApp fetcher={fetcher} token="session-token" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('制作案件を読み込めませんでした。')
    await user.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(await screen.findByText('表示できる制作案件はまだありません。')).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
