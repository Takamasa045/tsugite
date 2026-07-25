import { RefreshCw, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { CharacterCard } from './CharacterCard'
import { CharacterDetail } from './CharacterDetail'
import { UseCharacterDialog } from './UseCharacterDialog'
import {
  usableSources,
  type CharacterLoadState,
  type CharacterUseTargetProject,
  type LauncherCharacter,
} from './characterShelfModel'

const HISTORY_KEY = 'tsugiteCharacterDetail'

type CharacterHistoryState = {
  [HISTORY_KEY]?: string | null
}

export interface CharacterShelfProps {
  characters: LauncherCharacter[]
  loadState?: CharacterLoadState
  onRetry?: () => void
  projects?: CharacterUseTargetProject[]
  token?: string
  fetcher?: typeof fetch
}

function historyDetailKey(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null
  const value = (state as CharacterHistoryState)[HISTORY_KEY]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function CharacterShelf({
  characters,
  loadState = 'ready',
  onRetry,
  projects = [],
  token = '',
  fetcher,
}: CharacterShelfProps) {
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null)
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null)
  const [useDialogOpen, setUseDialogOpen] = useState(false)

  const selectedCharacter = useMemo(
    () => characters.find((character) => character.groupKey === selectedGroupKey) ?? null,
    [characters, selectedGroupKey],
  )

  const clearDetail = useCallback(() => {
    setSelectedGroupKey(null)
    setSelectedSourceKey(null)
    setUseDialogOpen(false)
  }, [])

  const goBack = useCallback(() => {
    // Clear UI immediately so click / Esc work even when history.back() is a no-op (jsdom).
    clearDetail()
    if (historyDetailKey(window.history.state)) {
      window.history.back()
    }
  }, [clearDetail])

  const openDetail = useCallback((groupKey: string) => {
    setSelectedGroupKey(groupKey)
    setUseDialogOpen(false)
    const base =
      typeof window.history.state === 'object' && window.history.state !== null
        ? (window.history.state as CharacterHistoryState)
        : {}
    window.history.pushState({ ...base, [HISTORY_KEY]: groupKey }, '')
  }, [])

  // Restore/sync when the shelf remounts; drop stale detail history when the tab unmounts.
  useEffect(() => {
    const currentKey = historyDetailKey(window.history.state)
    if (currentKey) setSelectedGroupKey(currentKey)

    return () => {
      if (!historyDetailKey(window.history.state)) return
      const base =
        typeof window.history.state === 'object' && window.history.state !== null
          ? (window.history.state as CharacterHistoryState)
          : {}
      window.history.replaceState({ ...base, [HISTORY_KEY]: null }, '')
    }
  }, [])

  useEffect(() => {
    if (!selectedCharacter) {
      setSelectedSourceKey(null)
      setUseDialogOpen(false)
      return
    }
    const usable = usableSources(selectedCharacter)
    setSelectedSourceKey((current) => {
      if (current && selectedCharacter.sources.some((source) => source.sourceKey === current && source.canUse)) {
        return current
      }
      return usable[0]?.sourceKey ?? null
    })
  }, [selectedCharacter])

  // Browser / mouse back button + Esc return from detail to list.
  useEffect(() => {
    function onPopState(event: PopStateEvent) {
      const nextKey = historyDetailKey(event.state)
      setSelectedGroupKey(nextKey)
      if (!nextKey) {
        setSelectedSourceKey(null)
        setUseDialogOpen(false)
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (useDialogOpen) {
        setUseDialogOpen(false)
        return
      }
      if (selectedGroupKey) {
        event.preventDefault()
        goBack()
      }
    }

    window.addEventListener('popstate', onPopState)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [goBack, selectedGroupKey, useDialogOpen])

  const selectedSource = selectedCharacter
    ? selectedCharacter.sources.find((source) => source.sourceKey === selectedSourceKey) ?? null
    : null

  return (
    <section
      aria-labelledby="launcher-characters-tab"
      className="launcher-workbench launcher-character-shelf-shell"
      id="launcher-characters-panel"
      role="tabpanel"
    >
      <section
        aria-labelledby="character-list-title"
        className="launcher-projects launcher-character-shelf"
      >
        <div className="launcher-section-heading launcher-character-shelf-heading">
          <div>
            <span className="eyebrow">キャラの棚</span>
            <h2 id="character-list-title">
              {selectedCharacter ? 'キャラクター詳細' : 'キャラクターを選ぶ'}
            </h2>
          </div>
          {loadState === 'ready' && !selectedCharacter && (
            <span className="launcher-count">全{characters.length}件</span>
          )}
        </div>

        {loadState === 'loading' && (
          <div className="launcher-empty" aria-live="polite">
            <RefreshCw aria-hidden="true" className="is-spinning" size={22} />
            <strong>キャラクターを読み込んでいます…</strong>
          </div>
        )}

        {loadState === 'error' && (
          <div className="launcher-catalog-error" role="alert">
            <strong>キャラクターを読み込めませんでした。</strong>
            <p>ギャラリーを確認して、もう一度読み込んでください。</p>
            {onRetry && (
              <button className="launcher-secondary" onClick={onRetry} type="button">
                <RefreshCw aria-hidden="true" size={16} />
                キャラクターをもう一度読み込む
              </button>
            )}
          </div>
        )}

        {loadState === 'ready' && characters.length === 0 && (
          <div className="launcher-empty">
            <Users aria-hidden="true" size={24} />
            <strong>表示できるキャラクターはまだありません。</strong>
            <p>制作案件やテンプレートに speaker 画像を置くと、ここに集まります。</p>
          </div>
        )}

        {loadState === 'ready' && characters.length > 0 && !selectedCharacter && (
          <div className="launcher-character-list">
            {characters.map((character) => (
              <CharacterCard
                key={character.groupKey}
                character={character}
                onSelect={openDetail}
              />
            ))}
          </div>
        )}

        {loadState === 'ready' && selectedCharacter && (
          <CharacterDetail
            character={selectedCharacter}
            onAddToProject={() => setUseDialogOpen(true)}
            onBack={goBack}
            onSelectSource={setSelectedSourceKey}
            selectedSourceKey={selectedSourceKey}
          />
        )}
      </section>

      {selectedCharacter && selectedSource && (
        <UseCharacterDialog
          character={selectedCharacter}
          fetcher={fetcher}
          onClose={() => setUseDialogOpen(false)}
          open={useDialogOpen}
          projects={projects}
          source={selectedSource}
          token={token}
        />
      )}
    </section>
  )
}
