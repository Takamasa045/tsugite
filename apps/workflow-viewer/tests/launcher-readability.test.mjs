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
    expect(launcherStyleSheet).toMatch(/\.launcher-feedback-stage-guide p,[\s\S]*?font-size: \.75rem/)
    expect(launcherStyleSheet).toMatch(/\.launcher-feedback-promotion-flow small[\s\S]*?font-size: \.75rem/)
  })
})
