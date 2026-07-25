import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CharacterShelf } from './CharacterShelf'
import type { LauncherCharacter } from './characterShelfModel'

const sampleCharacter: LauncherCharacter = {
  groupKey: 'grp-hana',
  id: 'hana',
  displayName: 'ハナ',
  poseCount: 1,
  hasMouthFrames: true,
  provenance: { kind: 'shitate', character: 'hana', run_id: 'run-1' },
  representativeImageKey: 'a'.repeat(32),
  sources: [{
    sourceKey: 'project:alpha:speaker-a',
    kind: 'project',
    label: 'サンプル映像A',
    speakerId: 'speaker-a',
    side: 'left',
    accent: '#c45c26',
    readOnly: false,
    canUse: true,
    poses: [{
      name: 'neutral',
      imageId: 'img-neutral',
      imageKey: 'a'.repeat(32),
      missing: false,
    }],
    mouthFrames: [
      { name: 'closed', imageId: 'm0', imageKey: 'b'.repeat(32), missing: false },
      { name: 'half', imageId: 'm1', imageKey: 'c'.repeat(32), missing: false },
      { name: 'open', imageId: 'm2', imageKey: 'd'.repeat(32), missing: false },
    ],
  }],
}

const missingCharacter: LauncherCharacter = {
  groupKey: 'grp-missing',
  id: 'missing-chan',
  displayName: '不足ちゃん',
  poseCount: 1,
  hasMouthFrames: false,
  sources: [{
    sourceKey: 'project:beta:missing',
    kind: 'project',
    label: 'B',
    speakerId: 'missing',
    side: 'right',
    accent: '#333',
    readOnly: false,
    canUse: false,
    poses: [{ name: 'neutral', imageId: 'x', missing: true }],
  }],
}

const writableProjects = [
  {
    id: 'project-alpha',
    name: 'サンプル映像A',
    runId: 'project-alpha-r3',
    revision: 'a'.repeat(64),
    valid: true,
  },
  {
    id: 'read-only-project',
    name: '他worktree',
    runId: 'ro-r1',
    revision: 'b'.repeat(64),
    readOnly: true,
    valid: true,
  },
]

function jsonResponse(input: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: async () => input,
  } as Response
}

function historyDetailState(): string | null {
  const state = window.history.state
  if (typeof state !== 'object' || state === null) return null
  const value = (state as { tsugiteCharacterDetail?: string | null }).tsugiteCharacterDetail
  return typeof value === 'string' && value.length > 0 ? value : null
}

describe('CharacterShelf', () => {
  it('loading / error / empty を表示する', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const { rerender } = render(
      <CharacterShelf characters={[]} loadState="loading" onRetry={onRetry} />,
    )
    expect(screen.getByText('キャラクターを読み込んでいます…')).toBeVisible()

    rerender(<CharacterShelf characters={[]} loadState="error" onRetry={onRetry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('キャラクターを読み込めませんでした。')
    await user.click(screen.getByRole('button', { name: 'キャラクターをもう一度読み込む' }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(<CharacterShelf characters={[]} loadState="ready" />)
    expect(screen.getByText('表示できるキャラクターはまだありません。')).toBeVisible()
  })

  it('カード一覧から詳細へ進み、使用元を選んで Use dialog を開く', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      added: true,
      alreadyPresent: false,
      speakerId: 'speaker-a',
      destinationDir: 'characters/speaker-a',
      imageIdMap: {},
      manifestPath: 'manifest.json',
    }))

    render(
      <CharacterShelf
        characters={[sampleCharacter, missingCharacter]}
        fetcher={fetcher}
        loadState="ready"
        projects={writableProjects}
        token="session-token"
      />,
    )

    expect(screen.getByRole('heading', { name: 'キャラクターを選ぶ' })).toBeVisible()
    expect(screen.getByText('全2件')).toBeVisible()
    expect(screen.getByRole('button', { name: 'ハナの詳細を見る' })).toBeVisible()
    expect(screen.getByText('Shitate取込')).toBeVisible()
    expect(screen.getByText('画像不足')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'ハナの詳細を見る' }))
    expect(screen.getByRole('heading', { name: 'ハナ' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'ポーズ' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '口パク（最大3コマ）' })).toBeVisible()
    expect(screen.getByText('使用元（sources）')).toBeVisible()

    const useButton = screen.getByRole('button', { name: 'このキャラクターを使う' })
    expect(useButton).toBeEnabled()
    await user.click(useButton)

    const dialog = screen.getByRole('dialog', { name: 'ハナ' })
    expect(dialog).toBeVisible()
    expect(within(dialog).getByText('サンプル映像A')).toBeVisible()
    expect(within(dialog).queryByText('他worktree')).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'この案件へ追加する' }))
    expect(await within(dialog).findByText('キャラクターを追加しました。')).toBeVisible()
    expect(fetcher).toHaveBeenCalledWith('/api/characters/use', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'x-tsugite-token': 'session-token',
        'content-type': 'application/json',
      }),
      body: JSON.stringify({
        sourceKey: sampleCharacter.sources[0]!.sourceKey,
        speakerId: 'speaker-a',
        targetProjectId: 'project-alpha',
        expectedRunId: 'project-alpha-r3',
        revision: 'a'.repeat(64),
      }),
    }))
  })

  it('missing のみのキャラは Use を無効にする', async () => {
    const user = userEvent.setup()
    render(
      <CharacterShelf
        characters={[missingCharacter]}
        loadState="ready"
        projects={writableProjects}
        token="session-token"
      />,
    )
    await user.click(screen.getByRole('button', { name: '不足ちゃんの詳細を見る' }))
    expect(screen.getByRole('button', { name: 'このキャラクターを使う' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('使用できる元データがありません')
  })

  it('一覧に戻る / ブラウザ戻る / Esc で詳細から一覧へ戻る', async () => {
    const user = userEvent.setup()
    render(
      <CharacterShelf
        characters={[sampleCharacter]}
        loadState="ready"
        projects={writableProjects}
        token="session-token"
      />,
    )

    await user.click(screen.getByRole('button', { name: 'ハナの詳細を見る' }))
    expect(screen.getByRole('heading', { name: 'ハナ' })).toBeVisible()
    expect(window.history.state).toMatchObject({ tsugiteCharacterDetail: sampleCharacter.groupKey })

    await user.click(screen.getByRole('button', { name: '一覧に戻る' }))
    await vi.waitFor(() => {
      expect(screen.getByRole('heading', { name: 'キャラクターを選ぶ' })).toBeVisible()
    })

    await user.click(screen.getByRole('button', { name: 'ハナの詳細を見る' }))
    expect(screen.getByRole('heading', { name: 'ハナ' })).toBeVisible()
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
    await vi.waitFor(() => {
      expect(screen.getByRole('heading', { name: 'キャラクターを選ぶ' })).toBeVisible()
    })

    await user.click(screen.getByRole('button', { name: 'ハナの詳細を見る' }))
    expect(screen.getByRole('heading', { name: 'ハナ' })).toBeVisible()
    fireEvent.keyDown(window, { key: 'Escape' })
    await vi.waitFor(() => {
      expect(screen.getByRole('heading', { name: 'キャラクターを選ぶ' })).toBeVisible()
    })
  })

  it('アンマウント時に詳細 history を破棄し、再マウント後の戻るが壊れない', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <CharacterShelf
        characters={[sampleCharacter]}
        loadState="ready"
        projects={writableProjects}
        token="session-token"
      />,
    )

    await user.click(screen.getByRole('button', { name: 'ハナの詳細を見る' }))
    expect(window.history.state).toMatchObject({ tsugiteCharacterDetail: sampleCharacter.groupKey })

    unmount()
    expect(historyDetailState()).toBeNull()

    render(
      <CharacterShelf
        characters={[sampleCharacter]}
        loadState="ready"
        projects={writableProjects}
        token="session-token"
      />,
    )
    expect(screen.getByRole('heading', { name: 'キャラクターを選ぶ' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'ハナの詳細を見る' }))
    await user.click(screen.getByRole('button', { name: '一覧に戻る' }))
    await vi.waitFor(() => {
      expect(screen.getByRole('heading', { name: 'キャラクターを選ぶ' })).toBeVisible()
    })
  })


  it('競合時は conflict メッセージを表示する', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      ok: false,
      issue: {
        code: 'character_add.speaker_conflict',
        message: '同じ speakerId が別内容で既に存在します',
      },
    }, false, 409))

    render(
      <CharacterShelf
        characters={[sampleCharacter]}
        fetcher={fetcher}
        loadState="ready"
        projects={writableProjects}
        token="session-token"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'ハナの詳細を見る' }))
    await user.click(screen.getByRole('button', { name: 'このキャラクターを使う' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'この案件へ追加する' }))
    expect(await within(dialog).findByText('競合のため追加できませんでした。')).toBeVisible()
    expect(within(dialog).getByText(/同じ speakerId/)).toBeVisible()
  })
})
