import { AlertTriangle, Users } from 'lucide-react'

import {
  characterHasMissingAssets,
  characterImageUrl,
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
  const imageKey = character.representativeImageKey
  const provenance = provenanceLabel(character.provenance)
  const a11yId = `launcher-character-card-a11y-${character.groupKey}`

  return (
    <button
      aria-describedby={a11yId}
      aria-label={`${character.displayName}の詳細を見る`}
      aria-pressed={selected}
      className="launcher-character-card"
      data-missing={hasMissing || undefined}
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
            pose {character.poseCount}
            {character.hasMouthFrames ? ' · 口パクあり' : ''}
          </small>
        </span>
      </span>

      <span className="sr-only" id={a11yId}>
        {provenance}。使用先{character.sources.length}件。
        {hasMissing ? '不足している画像があります。' : ''}
      </span>
    </button>
  )
}
