import { ArrowLeft, AlertTriangle, Check, ClipboardCopy, FolderInput } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  assetRoleLabel,
  buildCharacterAgentPrompt,
  buildCharacterHandoffMarkdown,
  characterImageUrl,
  characterIsReferenceOnly,
  characterSpeakerIds,
  isReferenceSource,
  provenanceLabel,
  sideLabel,
  sourceKindLabel,
  usableSources,
  type LauncherCharacter,
  type LauncherCharacterPose,
  type LauncherCharacterSource,
} from './characterShelfModel'

export interface CharacterDetailProps {
  character: LauncherCharacter
  selectedSourceKey: string | null
  onSelectSource: (sourceKey: string) => void
  onBack: () => void
  /** 既存の書込可能案件へコピーする補助（制作前の本筋ではない）。 */
  onAddToProject: () => void
}

type CopyKind = 'handoff' | 'prompt' | 'speakerId' | 'sourceKey'

function PoseThumb({ pose, label }: { pose: LauncherCharacterPose; label?: string }) {
  return (
    <li
      className="launcher-character-pose"
      data-missing={pose.missing || undefined}
    >
      <span className="launcher-character-pose-frame">
        {pose.imageKey && !pose.missing ? (
          <img
            alt=""
            decoding="async"
            loading="lazy"
            src={characterImageUrl(pose.imageKey)}
          />
        ) : (
          <span className="launcher-character-pose-missing" aria-hidden="true">
            <AlertTriangle size={16} />
          </span>
        )}
      </span>
      <small>{label ?? pose.name}{pose.missing ? '（不足）' : ''}</small>
    </li>
  )
}

function SourceRow({
  source,
  selected,
  onSelect,
}: {
  source: LauncherCharacterSource
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        aria-pressed={selected}
        className="launcher-character-source"
        data-can-use={source.canUse}
        disabled={!source.canUse}
        onClick={onSelect}
        type="button"
      >
        <span className="launcher-character-source-topline">
          <strong>{source.label}</strong>
          <small>{sourceKindLabel(source.kind)}</small>
        </span>
        <span className="launcher-character-source-meta">
          <span>speaker: {source.speakerId}</span>
          <span>{sideLabel(source.side)}</span>
          <span style={{ color: source.accent }}>accent</span>
          <span>{assetRoleLabel(source.assetRole)}</span>
          {source.readOnly && <span>読取専用</span>}
          {isReferenceSource(source) && (
            <span className="launcher-character-badge launcher-character-badge-reference">キャラ以外</span>
          )}
          {!source.canUse && (
            <span className="launcher-character-badge launcher-character-badge-warning">使用不可</span>
          )}
        </span>
        {source.provenance && (
          <span className="launcher-character-source-provenance">
            {provenanceLabel(source.provenance)}
          </span>
        )}
      </button>
    </li>
  )
}

export function CharacterDetail({
  character,
  selectedSourceKey,
  onSelectSource,
  onBack,
  onAddToProject,
}: CharacterDetailProps) {
  const canUseList = usableSources(character)
  const selectedSource = character.sources.find((source) => source.sourceKey === selectedSourceKey)
    ?? canUseList[0]
    ?? null
  const poseList = selectedSource?.poses ?? character.sources[0]?.poses ?? []
  const mouthFrames = (selectedSource?.mouthFrames ?? character.sources[0]?.mouthFrames ?? []).slice(0, 3)
  const useEnabled = Boolean(selectedSource?.canUse)
  const speakerIds = characterSpeakerIds(character)
  const referenceOnly = characterIsReferenceOnly(character)
  const [copyKind, setCopyKind] = useState<CopyKind | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)

  useEffect(() => {
    if (!copyKind) return
    const timer = window.setTimeout(() => setCopyKind(null), 2000)
    return () => window.clearTimeout(timer)
  }, [copyKind])

  async function copyText(kind: CopyKind, text: string) {
    setCopyFailed(false)
    try {
      await navigator.clipboard.writeText(text)
      setCopyKind(kind)
    } catch {
      setCopyFailed(true)
      setCopyKind(null)
    }
  }

  const handoff = selectedSource
    ? buildCharacterHandoffMarkdown(character, selectedSource)
    : ''
  const agentPrompt = selectedSource
    ? buildCharacterAgentPrompt(character, selectedSource)
    : ''

  return (
    <section className="launcher-character-detail" aria-labelledby="character-detail-title">
      <div className="launcher-character-detail-heading">
        <button className="launcher-template-back" onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" size={16} />
          一覧に戻る
        </button>
        <span className="eyebrow">キャラクター詳細</span>
        <h2 id="character-detail-title">{character.displayName}</h2>
        <p>
          <span className="launcher-character-badge launcher-character-badge-provenance">
            {provenanceLabel(character.provenance)}
          </span>
          {referenceOnly && (
            <>
              {' '}
              <span className="launcher-character-badge launcher-character-badge-reference">
                キャラ以外
              </span>
            </>
          )}
          {' '}
          pose {character.poseCount} · 使用先 {character.sources.length}件
          {character.hasMouthFrames ? ' · 口パクあり' : ''}
          {' · '}id {speakerIds.join(' / ')}
        </p>
      </div>

      <section aria-label="ポーズ" className="launcher-character-detail-section">
        <h3>ポーズ</h3>
        {poseList.length === 0 ? (
          <p className="launcher-character-empty-inline">ポーズがありません。</p>
        ) : (
          <ul className="launcher-character-pose-list">
            {poseList.map((pose) => (
              <PoseThumb key={`${pose.imageId}-${pose.name}`} pose={pose} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="口パクフレーム" className="launcher-character-detail-section">
        <h3>口パク（最大3コマ）</h3>
        {mouthFrames.length === 0 ? (
          <p className="launcher-character-empty-inline">口パクフレームはありません。</p>
        ) : (
          <ul className="launcher-character-pose-list launcher-character-mouth-list">
            {mouthFrames.map((frame, index) => (
              <PoseThumb
                key={`${frame.imageId}-${frame.name}-${index}`}
                label={`${index + 1}. ${frame.name}`}
                pose={frame}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="使用元" className="launcher-character-detail-section">
        <h3>使用元（sources）</h3>
        <p className="launcher-character-detail-hint">
          依頼メモに載せる元データを選んでください。画像不足の元は選べません。
        </p>
        <ul className="launcher-character-source-list">
          {character.sources.map((source) => (
            <SourceRow
              key={source.sourceKey}
              onSelect={() => onSelectSource(source.sourceKey)}
              selected={selectedSource?.sourceKey === source.sourceKey}
              source={source}
            />
          ))}
        </ul>
      </section>

      <section
        aria-label="制作前の受け渡し"
        className="launcher-character-detail-section launcher-character-handoff"
        role="region"
      >
        <h3>制作前の受け渡し</h3>
        <p className="launcher-character-detail-hint">
          案件がまだ無い段階では、ここで依頼メモや識別子をコピーして Codex / Claude に渡すのが本筋です。
          既存案件への直接コピーは補助です。
        </p>

        <div className="launcher-character-detail-actions">
          <button
            className="launcher-primary"
            disabled={!useEnabled || !selectedSource}
            onClick={() => void copyText('handoff', handoff)}
            type="button"
          >
            {copyKind === 'handoff' ? (
              <>
                <Check aria-hidden="true" size={16} />
                依頼メモをコピーしました
              </>
            ) : (
              <>
                <ClipboardCopy aria-hidden="true" size={16} />
                依頼メモをコピー
              </>
            )}
          </button>
          <button
            className="launcher-secondary"
            disabled={!useEnabled || !selectedSource}
            onClick={() => void copyText('prompt', agentPrompt)}
            type="button"
          >
            {copyKind === 'prompt' ? (
              <>
                <Check aria-hidden="true" size={16} />
                短い依頼文をコピーしました
              </>
            ) : (
              <>
                <ClipboardCopy aria-hidden="true" size={16} />
                短い依頼文をコピー
              </>
            )}
          </button>
        </div>

        {selectedSource && (
          <div className="launcher-character-id-row" aria-label="識別子">
            <div className="launcher-character-id-chip">
              <span>
                <small>speakerId</small>
                <code>{selectedSource.speakerId}</code>
              </span>
              <button
                className="launcher-secondary"
                disabled={!useEnabled}
                onClick={() => void copyText('speakerId', selectedSource.speakerId)}
                type="button"
              >
                {copyKind === 'speakerId' ? 'コピー済' : 'コピー'}
              </button>
            </div>
            <div className="launcher-character-id-chip">
              <span>
                <small>sourceKey</small>
                <code>{selectedSource.sourceKey}</code>
              </span>
              <button
                className="launcher-secondary"
                disabled={!useEnabled}
                onClick={() => void copyText('sourceKey', selectedSource.sourceKey)}
                type="button"
              >
                {copyKind === 'sourceKey' ? 'コピー済' : 'コピー'}
              </button>
            </div>
          </div>
        )}

        {selectedSource && (
          <pre
            aria-label="短い依頼文のプレビュー"
            className="launcher-character-handoff-preview"
          >
            {agentPrompt}
          </pre>
        )}

        <div className="launcher-character-detail-actions launcher-character-detail-actions-secondary">
          <button
            className="launcher-secondary"
            disabled={!useEnabled}
            onClick={onAddToProject}
            type="button"
          >
            <FolderInput aria-hidden="true" size={16} />
            既存の案件へ追加…
          </button>
        </div>

        {!useEnabled && (
          <p className="launcher-character-detail-disabled-hint" role="status">
            使用できる元データがありません。不足画像を補ってから再度お試しください。
          </p>
        )}
        {copyFailed && (
          <p className="launcher-character-detail-disabled-hint" role="alert">
            クリップボードへコピーできませんでした。プレビューを選択して手動でコピーしてください。
          </p>
        )}
      </section>
    </section>
  )
}
