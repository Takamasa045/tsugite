import { describe, expect, it } from 'vitest'

import {
  buildCharacterAgentPrompt,
  buildCharacterHandoffMarkdown,
  characterHasMissingAssets,
  characterImageUrl,
  isCharacterListResponse,
  isCharacterUseResponse,
  isLauncherCharacter,
  isWritableTargetProject,
  provenanceLabel,
  usableSources,
  type LauncherCharacter,
} from './characterShelfModel'

const pose = {
  name: 'neutral',
  imageId: 'img-neutral',
  imageKey: 'a'.repeat(32),
  missing: false,
}

const usableSource = {
  sourceKey: 'project:alpha:speaker-a',
  kind: 'project' as const,
  label: 'サンプル映像A',
  speakerId: 'speaker-a',
  side: 'left' as const,
  accent: '#c45c26',
  readOnly: false,
  canUse: true,
  poses: [pose],
  mouthFrames: [
    { name: 'closed', imageId: 'm0', imageKey: 'b'.repeat(32), missing: false },
    { name: 'half', imageId: 'm1', imageKey: 'c'.repeat(32), missing: false },
    { name: 'open', imageId: 'm2', imageKey: 'd'.repeat(32), missing: false },
  ],
  provenance: { kind: 'shitate', character: 'hana', run_id: 'run-1' },
}

const sampleCharacter: LauncherCharacter = {
  groupKey: 'grp-hana',
  id: 'hana',
  displayName: 'ハナ',
  poseCount: 1,
  hasMouthFrames: true,
  provenance: { kind: 'shitate', character: 'hana', run_id: 'run-1' },
  representativeImageKey: 'a'.repeat(32),
  sources: [usableSource],
}

const missingCharacter: LauncherCharacter = {
  ...sampleCharacter,
  groupKey: 'grp-missing',
  id: 'missing-chan',
  displayName: '不足ちゃん',
  provenance: undefined,
  representativeImageKey: undefined,
  sources: [{
    ...usableSource,
    sourceKey: 'project:beta:missing',
    canUse: false,
    poses: [{ name: 'neutral', imageId: 'x', missing: true }],
    mouthFrames: undefined,
    provenance: undefined,
  }],
}

describe('characterShelfModel', () => {
  it('provenanceLabel は由来種別を日本語化する', () => {
    expect(provenanceLabel(undefined)).toBe('手作り')
    expect(provenanceLabel({ kind: 'shitate' })).toBe('Shitate取込')
    expect(provenanceLabel({ kind: 'character-forge' })).toBe('キャラ生成')
    expect(provenanceLabel({ kind: 'custom-pipeline' })).toBe('custom-pipeline')
  })

  it('characterImageUrl は opaque key の画像 path を返す', () => {
    expect(characterImageUrl('ab'.repeat(16))).toBe(`/character-image/${'ab'.repeat(16)}`)
  })

  it('isLauncherCharacter / isCharacterListResponse が wire 形を受け入れる', () => {
    expect(isLauncherCharacter(sampleCharacter)).toBe(true)
    expect(isCharacterListResponse({ ok: true, characters: [sampleCharacter, missingCharacter] })).toBe(true)
  })

  it('壊れた character / list を拒否する', () => {
    expect(isLauncherCharacter({ ...sampleCharacter, sources: 'nope' })).toBe(false)
    expect(isLauncherCharacter({ ...sampleCharacter, poseCount: '1' })).toBe(false)
    expect(isCharacterListResponse({ ok: true, characters: [{ id: 'x' }] })).toBe(false)
    expect(isCharacterListResponse({ ok: false, characters: [] })).toBe(false)
  })

  it('usableSources / missing 判定', () => {
    expect(usableSources(sampleCharacter)).toHaveLength(1)
    expect(characterHasMissingAssets(sampleCharacter)).toBe(false)
    expect(usableSources(missingCharacter)).toHaveLength(0)
    expect(characterHasMissingAssets(missingCharacter)).toBe(true)
  })

  it('isWritableTargetProject は readOnly / invalid を除外する', () => {
    expect(isWritableTargetProject({
      id: 'a', name: 'A', runId: 'r1', revision: 'rev',
    })).toBe(true)
    expect(isWritableTargetProject({
      id: 'b', name: 'B', runId: 'r1', revision: 'rev', readOnly: true,
    })).toBe(false)
    expect(isWritableTargetProject({
      id: 'c', name: 'C', runId: 'r1', revision: 'rev', valid: false,
    })).toBe(false)
  })

  it('isCharacterUseResponse が成功・失敗を判別する', () => {
    expect(isCharacterUseResponse({
      ok: true, added: true, alreadyPresent: false, speakerId: 'speaker-a',
    })).toBe(true)
    expect(isCharacterUseResponse({
      ok: true, added: false, alreadyPresent: true, speakerId: 'speaker-a',
    })).toBe(true)
    expect(isCharacterUseResponse({
      ok: false, issue: { code: 'character_add.speaker_conflict', message: '衝突' },
    })).toBe(true)
    expect(isCharacterUseResponse({ ok: true, speakerId: 'x' })).toBe(false)
  })

  it('buildCharacterHandoffMarkdown は依頼メモに識別子と自然言語依頼を含める', () => {
    const md = buildCharacterHandoffMarkdown(sampleCharacter, usableSource)
    expect(md).toContain('# キャラクター依頼メモ: ハナ')
    expect(md).toContain('speakerId: `speaker-a`')
    expect(md).toContain('sourceKey: `project:alpha:speaker-a`')
    expect(md).toContain('生成・run・render・Gate')
    expect(md).not.toMatch(/\/Users\//)
  })

  it('buildCharacterAgentPrompt は短い自然言語依頼になる', () => {
    const prompt = buildCharacterAgentPrompt(sampleCharacter, usableSource)
    expect(prompt).toContain('「ハナ」')
    expect(prompt).toContain('speaker-a')
    expect(prompt).toContain('project:alpha:speaker-a')
    expect(prompt).toContain('承認するまで実行しない')
  })
})
