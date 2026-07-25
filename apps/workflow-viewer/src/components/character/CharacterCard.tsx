import { AlertTriangle, Users } from 'lucide-react'

import {
  characterHasMissingAssets,
  characterImageUrl,
  characterIsReferenceOnly,
  characterSourceLabels,
  characterSpeakerIds,
  provenanceLabel,
  type LauncherCharacter,
} from './characterShelfModel'

export interface CharacterCardProps {
  character: LauncherCharacter
  selected?: boolean
  onSelect: (groupKey: string) => void
}

export function CharacterCard({ character, selected = false, onSelect }: CharacterCardProps) {
  const hasMissing = characterHasMissingAssets(character)
  const referenceOnly = characterIsReferenceOnly(character)
  const imageKey = character.representativeImageKey
  const provenance = provenanceLabel(character.provenance)
  const speakerIds = characterSpeakerIds(character)
  const sourceLabels = characterSourceLabels(character)
  const extraSources = Math.max(0, character.sources.length - sourceLabels.length)
  const a11yId = `launcher-character-card-a11y-${character.groupKey}`

  return (
    <button
      aria-describedby={a11yId}
      aria-label={`${character.displayName}の詳細を見る`}
      aria-pressed={selected}
      className="launcher-character-card"
      data-missing={hasMissing || undefined}
      data-reference={referenceOnly || undefined}
      data-selected={selected || undefined}
      onClick={() => onSelect(character.groupKey)}
      type="button"
    >
      <span className="launcher-character-card-media" aria-hidden={imageKey ? undefined : true}>
        {imageKey ? (
          <img
            alt=""
            className="launcher-character-card-image"
            decoding="async"
            loading="lazy"
            src={characterImageUrl(imageKey)}
          />
        ) : (
          <span className="launcher-character-card-placeholder">画像なし</span>
        )}
      </span>

      <span className="launcher-character-card-body">
        <span className="launcher-character-card-topline">
          <span className="launcher-character-badge launcher-character-badge-provenance">{provenance}</span>
          {referenceOnly && (
            <span className="launcher-character-badge launcher-character-badge-reference">
              キャラ以外
            </span>
          )}
          {hasMissing && (
            <span className="launcher-character-badge launcher-character-badge-warning">
              <AlertTriangle aria-hidden="true" size={12} />
              画像不足
            </span>
          )}
        </span>

        <span className="launcher-character-card-name" role="heading" aria-level={3}>
          {character.displayName}
        </span>

        <span className="launcher-character-card-meta">
          <span>
            <Users aria-hidden="true" size={13} />
            使用先 {character.sources.length}件
          </span>
          <small>
            id {speakerIds.join(' / ')}
            {character.hasMouthFrames ? ' · 口パクあり' : ''}
          </small>
        </span>

        <span className="launcher-character-card-sources">
          {sourceLabels.join(' · ')}
          {extraSources > 0 ? ` ほか${extraSources}` : ''}
        </span>
      </span>

      <span className="sr-only" id={a11yId}>
        {provenance}。使用先{character.sources.length}件。speaker id: {speakerIds.join(', ')}。
        {referenceOnly ? 'キャラクター画像ではなく参考画像です。' : ''}
        {hasMissing ? '不足している画像があります。' : ''}
      </span>
    </button>
  )
}
