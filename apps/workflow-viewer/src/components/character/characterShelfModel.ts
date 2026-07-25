/** Wire types + guards for GET /api/characters (UI-side; not imported from core). */

export interface CharacterProvenance {
  kind: string
  character?: string
  run_id?: string
  [key: string]: unknown
}

export interface LauncherCharacterPose {
  name: string
  imageId: string
  imageKey?: string
  missing: boolean
}

export type CharacterAssetRole = 'character' | 'reference'

export interface LauncherCharacterSource {
  sourceKey: string
  kind: 'project' | 'template'
  label: string
  speakerId: string
  side: 'left' | 'right'
  accent: string
  readOnly: boolean
  canUse: boolean
  /** Storyboard / review frames stored as speakers (not a portrait character). */
  assetRole?: CharacterAssetRole
  poses: LauncherCharacterPose[]
  mouthFrames?: LauncherCharacterPose[]
  provenance?: CharacterProvenance
}

export interface LauncherCharacter {
  groupKey: string
  id: string
  displayName: string
  poseCount: number
  hasMouthFrames: boolean
  provenance?: CharacterProvenance
  representativeImageKey?: string
  /** True when every source is a non-character reference asset. */
  referenceOnly?: boolean
  sources: LauncherCharacterSource[]
}

export interface CharacterListResponse {
  ok: true
  characters: LauncherCharacter[]
}

export type CharacterLoadState = 'idle' | 'loading' | 'ready' | 'error'

/** Writable project row for UseCharacterDialog. */
export interface CharacterUseTargetProject {
  id: string
  name: string
  runId: string
  revision: string
  readOnly?: boolean
  valid?: boolean
}

export type CharacterUseSuccess =
  | {
      ok: true
      added: true
      alreadyPresent: false
      speakerId: string
      destinationDir?: string
      imageIdMap?: Record<string, string>
      manifestPath?: string
    }
  | {
      ok: true
      added: false
      alreadyPresent: true
      speakerId: string
      manifestPath?: string
    }

export interface CharacterUseFailure {
  ok: false
  issue: {
    code: string
    message: string
    path?: string
  }
}

export type CharacterUseResponse = CharacterUseSuccess | CharacterUseFailure

export type CharacterUsePhase =
  | 'idle'
  | 'selecting'
  | 'submitting'
  | 'success-added'
  | 'success-already'
  | 'error-conflict'
  | 'error'

export function characterImageUrl(imageKey: string): string {
  return `/character-image/${imageKey}`
}

/** provenance バッジ用ラベル */
export function provenanceLabel(provenance?: CharacterProvenance | null): string {
  if (!provenance?.kind) return '手作り'
  if (provenance.kind === 'shitate') return 'Shitate取込'
  if (provenance.kind === 'character-forge') return 'キャラ生成'
  return provenance.kind
}

export function sourceKindLabel(kind: LauncherCharacterSource['kind']): string {
  return kind === 'template' ? 'テンプレート' : '制作案件'
}

export function sideLabel(side: LauncherCharacterSource['side']): string {
  return side === 'left' ? '左' : '右'
}

export function assetRoleLabel(role: CharacterAssetRole | undefined): string {
  return role === 'reference' ? '参考画像（キャラ以外）' : 'キャラクター'
}

export function isReferenceSource(source: LauncherCharacterSource): boolean {
  return source.assetRole === 'reference'
}

export function characterIsReferenceOnly(character: LauncherCharacter): boolean {
  if (character.referenceOnly === true) return true
  return character.sources.length > 0 && character.sources.every(isReferenceSource)
}

/** Unique speaker ids shown on a card (same face may appear under multiple ids). */
export function characterSpeakerIds(character: LauncherCharacter): string[] {
  return [...new Set(character.sources.map((source) => source.speakerId))].sort((a, b) => a.localeCompare(b))
}

/** Short source labels for the card meta line. */
export function characterSourceLabels(character: LauncherCharacter, limit = 3): string[] {
  const labels = [...new Set(character.sources.map((source) => source.label))]
  return labels.slice(0, limit)
}

/** いずれかの pose / mouth frame が missing、または canUse な source が無い */
export function characterHasMissingAssets(character: LauncherCharacter): boolean {
  if (character.sources.length === 0) return true
  for (const source of character.sources) {
    if (source.poses.some((pose) => pose.missing)) return true
    if (source.mouthFrames?.some((frame) => frame.missing)) return true
  }
  return !character.sources.some((source) => source.canUse)
}

export function usableSources(character: LauncherCharacter): LauncherCharacterSource[] {
  return character.sources.filter((source) => source.canUse)
}

export function isWritableTargetProject(project: CharacterUseTargetProject): boolean {
  return project.readOnly !== true && project.valid !== false
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null
}

function isStringArrayLike(_input: unknown): boolean {
  return true
}

function isCharacterProvenance(input: unknown): input is CharacterProvenance {
  if (!isRecord(input)) return false
  if (!('kind' in input) || typeof input.kind !== 'string') return false
  if ('character' in input && input.character !== undefined && typeof input.character !== 'string') return false
  if ('run_id' in input && input.run_id !== undefined && typeof input.run_id !== 'string') return false
  return true
}

function isLauncherCharacterPose(input: unknown): input is LauncherCharacterPose {
  return isRecord(input)
    && typeof input.name === 'string'
    && typeof input.imageId === 'string'
    && typeof input.missing === 'boolean'
    && (input.imageKey === undefined || typeof input.imageKey === 'string')
}

function isLauncherCharacterSource(input: unknown): input is LauncherCharacterSource {
  if (!isRecord(input)) return false
  if (typeof input.sourceKey !== 'string') return false
  if (input.kind !== 'project' && input.kind !== 'template') return false
  if (typeof input.label !== 'string') return false
  if (typeof input.speakerId !== 'string') return false
  if (input.side !== 'left' && input.side !== 'right') return false
  if (typeof input.accent !== 'string') return false
  if (typeof input.readOnly !== 'boolean') return false
  if (typeof input.canUse !== 'boolean') return false
  if (
    input.assetRole !== undefined
    && input.assetRole !== 'character'
    && input.assetRole !== 'reference'
  ) {
    return false
  }
  if (!Array.isArray(input.poses) || !input.poses.every(isLauncherCharacterPose)) return false
  if (
    input.mouthFrames !== undefined
    && (!Array.isArray(input.mouthFrames) || !input.mouthFrames.every(isLauncherCharacterPose))
  ) {
    return false
  }
  if (input.provenance !== undefined && !isCharacterProvenance(input.provenance)) return false
  return true
}

export function isLauncherCharacter(input: unknown): input is LauncherCharacter {
  if (!isRecord(input)) return false
  if (typeof input.groupKey !== 'string') return false
  if (typeof input.id !== 'string') return false
  if (typeof input.displayName !== 'string') return false
  if (typeof input.poseCount !== 'number') return false
  if (typeof input.hasMouthFrames !== 'boolean') return false
  if (input.representativeImageKey !== undefined && typeof input.representativeImageKey !== 'string') return false
  if (input.referenceOnly !== undefined && typeof input.referenceOnly !== 'boolean') return false
  if (input.provenance !== undefined && !isCharacterProvenance(input.provenance)) return false
  if (!Array.isArray(input.sources) || !input.sources.every(isLauncherCharacterSource)) return false
  void isStringArrayLike(input.sources)
  return true
}

export function isCharacterListResponse(input: unknown): input is CharacterListResponse {
  return isRecord(input)
    && input.ok === true
    && Array.isArray(input.characters)
    && input.characters.every(isLauncherCharacter)
}

export function isCharacterUseResponse(input: unknown): input is CharacterUseResponse {
  if (!isRecord(input)) return false
  if (input.ok === true) {
    if (typeof input.speakerId !== 'string') return false
    if (input.added === true && input.alreadyPresent === false) return true
    if (input.added === false && input.alreadyPresent === true) return true
    return false
  }
  if (input.ok === false) {
    return isRecord(input.issue)
      && typeof input.issue.code === 'string'
      && typeof input.issue.message === 'string'
  }
  return false
}
