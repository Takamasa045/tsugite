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

  it('keeps expression shelf readable in dark and light themes', () => {
    // dark default: light ink on dark panels
    expect(launcherStyleSheet).toMatch(
      /\.launcher-expression-shelf \{[\s\S]*?color: var\(--launcher-kinari\)/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-expression-heading h2,[\s\S]*?color: var\(--launcher-kinari\)/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-expression-intent-free textarea,[\s\S]*?color: var\(--launcher-kinari\)/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-expression-card \{[\s\S]*?color: var\(--launcher-kinari\)/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-expression-tray-list strong \{[\s\S]*?color: var\(--launcher-kinari\)/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-checklist-expressions \{[\s\S]*?color: var\(--launcher-kinari\)/,
    )

    // light: dark ink on paper
    expect(launcherStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-shelf \{[\s\S]*?color: #24302b/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-heading h2,[\s\S]*?color: #24302b/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-intent-free textarea,[\s\S]*?color: #24302b/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-card \{[\s\S]*?color: #24302b/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-template-checklist-expressions \{[\s\S]*?color: #24302b/,
    )
  })
})
