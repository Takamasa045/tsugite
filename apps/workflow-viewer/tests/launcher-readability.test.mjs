import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const launcherStyleSheet = readFileSync(
  resolve(process.cwd(), 'src/styles/launcher-yakisugi.css'),
  'utf8',
)

describe('launcher readability contract', () => {
  it('uses a smooth Japanese UI font and solid paper surfaces for learning content', () => {
    expect(launcherStyleSheet).toContain('font-family: "Hiragino Sans"')
    expect(launcherStyleSheet).toContain('--launcher-feedback-paper: #faf7ef')
    expect(launcherStyleSheet).toMatch(/\.launcher-feedback-pickup \{[\s\S]*?border: 2px solid #c17b43/)
    expect(launcherStyleSheet).toMatch(/\.launcher-feedback-pickup li button:focus-visible \{[\s\S]*?outline: 3px solid #275e58/)
    // DOM から削除済みの legacy stage-guide / promotion-flow は契約しない
    expect(launcherStyleSheet).not.toContain('.launcher-feedback-stage-guide')
    expect(launcherStyleSheet).not.toContain('.launcher-feedback-promotion-flow')
    // 現行の確認ガイドと summary metric の可読サイズを契約する
    expect(launcherStyleSheet).toMatch(/\.launcher-feedback-review-guide li > span \{[\s\S]*?font-size: \.72rem/)
    expect(launcherStyleSheet).toMatch(/\.launcher-feedback-summary-metric > span \{[\s\S]*?font-size: \.8125rem/)
  })
})
