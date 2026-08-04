import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const launcherStyleSheet = readFileSync(
  resolve(process.cwd(), 'src/styles/launcher-yakisugi.css'),
  'utf8',
)
const expressionStyleSheet = readFileSync(
  resolve(process.cwd(), 'src/styles/expression-shelf.css'),
  'utf8',
)
const globalsStyleSheet = readFileSync(
  resolve(process.cwd(), 'src/styles/globals.css'),
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
    // dark default: light ink on dark panels (expression-shelf.css owns these rules)
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-shelf \{[\s\S]*?color: var\(--launcher-kinari\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-heading h2,[\s\S]*?color: var\(--launcher-kinari\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-intent-free textarea,[\s\S]*?color: var\(--launcher-kinari\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-card \{[\s\S]*?color: var\(--launcher-kinari\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-tray-list strong \{[\s\S]*?color: var\(--launcher-kinari\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-template-checklist-expressions \{[\s\S]*?color: var\(--launcher-kinari\)/,
    )

    // light: dark ink on paper
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-shelf \{[\s\S]*?color: #24302b/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-heading h2,[\s\S]*?color: #24302b/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-intent-free textarea,[\s\S]*?color: #24302b/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-card \{[\s\S]*?color: #24302b/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-template-checklist-expressions \{[\s\S]*?color: #24302b/,
    )

    // launcher sheet no longer carries expression shelf chrome
    expect(launcherStyleSheet).not.toMatch(/\.launcher-expression-shelf\s*\{/)
  })

  /**
   * Contrast contract for intent heading, placeholders, and caption accent.
   * Ratios are computed against the documented composite backgrounds
   * (not against transparent layers alone). WCAG AA normal text ≥ 4.5:1.
   */
  it('keeps expression intent heading, placeholders, and caption accent ≥ AA 4.5:1', () => {
    // Theme tokens exist on the shelf (dark default + light override)
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-shelf \{[\s\S]*?--launcher-expr-label-text:[\s\S]*?--launcher-expr-placeholder:[\s\S]*?--launcher-expr-accent-text:/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-shelf \{[\s\S]*?--launcher-expr-label-text: #24302b[\s\S]*?--launcher-expr-placeholder:[\s\S]*?--launcher-expr-accent-text:/,
    )

    // Intent free label + span use the token (light must not keep kinari ink)
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-intent-free \{[\s\S]*?color: var\(--launcher-expr-label-text\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-intent-free > span \{[\s\S]*?color: var\(--launcher-expr-label-text\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-intent-free,[\s\S]*?\.launcher-expression-intent-free > span \{[\s\S]*?color: var\(--launcher-expr-label-text\)/,
    )

    // Placeholders use theme tokens (not the old .45 alpha that failed AA)
    expect(expressionStyleSheet).toMatch(
      /textarea::placeholder,[\s\S]*?input::placeholder \{[\s\S]*?color: var\(--launcher-expr-placeholder\)/,
    )
    expect(expressionStyleSheet).not.toMatch(
      /textarea::placeholder,[\s\S]*?input::placeholder \{[\s\S]*?color: rgba\(244, 237, 223, \.45\)/,
    )
    expect(expressionStyleSheet).not.toMatch(
      /\[data-theme="light"\][\s\S]*?textarea::placeholder,[\s\S]*?color: rgba\(36, 48, 43, \.45\)/,
    )

    // Caption emphasis uses theme accent (not raw --launcher-urushi on dark cards)
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-preview-caption b \{[\s\S]*?color: var\(--launcher-expr-accent-text\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-preview-caption b \{[\s\S]*?color: var\(--launcher-expr-accent-text\)/,
    )

    // Explicit numeric floors for the documented composites
    const darkPlaceholder = readCssCustomProp(expressionStyleSheet, '--launcher-expr-placeholder', 'dark')
    const lightPlaceholder = readCssCustomProp(expressionStyleSheet, '--launcher-expr-placeholder', 'light')
    const darkAccent = readCssCustomProp(expressionStyleSheet, '--launcher-expr-accent-text', 'dark')
    const lightAccent = readCssCustomProp(expressionStyleSheet, '--launcher-expr-accent-text', 'light')
    const lightLabel = readCssCustomProp(expressionStyleSheet, '--launcher-expr-label-text', 'light')

    // Dark placeholder vs input fill rgba(12,11,9) ≈ solid #0c0b09
    expect(contrastRatio(parseCssColor(darkPlaceholder, [12, 11, 9]), [12, 11, 9])).toBeGreaterThanOrEqual(4.5)
    // Light placeholder vs white input fill
    expect(contrastRatio(parseCssColor(lightPlaceholder, [255, 255, 255]), [255, 255, 255])).toBeGreaterThanOrEqual(4.5)
    // Light intent heading vs intent panel paper-ish surface
    expect(contrastRatio(parseCssColor(lightLabel, [255, 252, 245]), [255, 252, 245])).toBeGreaterThanOrEqual(4.5)
    // Dark caption b vs dark card composite ~#141210
    expect(contrastRatio(parseCssColor(darkAccent, [20, 18, 15]), [20, 18, 15])).toBeGreaterThanOrEqual(4.5)
    // Light caption b vs paper
    expect(contrastRatio(parseCssColor(lightAccent, [255, 252, 245]), [255, 252, 245])).toBeGreaterThanOrEqual(4.5)
  })

  /**
   * Expression shelf secondary buttons (追加 / さらに表示 / 再読込 / 外す).
   * Dark must not inherit globals --ai-700 (#244d49) which is ~2:1 on card/panel.
   * Ratios use documented composite surfaces from expression-shelf tokens.
   */
  it('keeps light hero shelf-tab focus ring ≥ 3:1 on paper without breaking dark', () => {
    // Light override must exist and must not keep globals #d18d39 on hero tabs
    expect(launcherStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-hero \.launcher-shelf-tabs button:focus-visible \{[\s\S]*?outline:\s*3px\s+solid\s+#9a3d30/,
    )
    // Dark theme still uses default / non-light path (no light-only color forced globally)
    expect(launcherStyleSheet).not.toMatch(
      /^\.launcher-hero \.launcher-shelf-tabs button:focus-visible \{[\s\S]*?#9a3d30/m,
    )
    // Selected state styles remain separate from focus-visible
    expect(launcherStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-hero \.launcher-shelf-tabs button\[aria-selected="true"\] \{[\s\S]*?color: #24302b/,
    )

    // Composite: focus ring #9a3d30 on light hero paper #fffdf8 ≥ 3:1 (UI component)
    const ring = [0x9a, 0x3d, 0x30]
    const paper = [0xff, 0xfd, 0xf8]
    expect(contrastRatio(ring, paper)).toBeGreaterThanOrEqual(3)
    // globals #d18d39 fails this floor on the same paper
    expect(contrastRatio([0xd1, 0x8d, 0x39], paper)).toBeLessThan(3)
  })

  /**
   * TemplateChecklist presentation preset options at narrow widths (e.g. 320px).
   * Unknown/long preset IDs are shown as-is; CSS must shrink flex/grid children
   * and wrap continuous alphanumerics without clipping selection chrome.
   */
  it('keeps presentation preset option text wrappable at narrow widths', () => {
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-preset-options \{[\s\S]*?min-width:\s*0[\s\S]*?max-width:\s*100%/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-preset-option \{[\s\S]*?min-width:\s*0[\s\S]*?max-width:\s*100%/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-preset-option-topline \{[\s\S]*?min-width:\s*0[\s\S]*?max-width:\s*100%/,
    )
    // label / backend chips / description / id must wrap unbroken tokens
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-preset-option-topline strong \{[\s\S]*?min-width:\s*0[\s\S]*?overflow-wrap:\s*anywhere/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-preset-option-topline small \{[\s\S]*?min-width:\s*0[\s\S]*?overflow-wrap:\s*anywhere/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-preset-option-description \{[\s\S]*?min-width:\s*0[\s\S]*?overflow-wrap:\s*anywhere/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-preset-option-tech code \{[\s\S]*?overflow-wrap:\s*anywhere/,
    )
    // selection / focus chrome stays intact (not removed by overflow fix)
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-preset-option\[aria-pressed="true"\] \{[\s\S]*?border-color: var\(--launcher-urushi/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-preset-option:focus-visible[\s,\{][\s\S]*?outline:\s*3px\s+solid\s+#a65f3f/,
    )
  })

  /**
   * Template wizard back + past-step chips: former rgba(166,61,47,.35) was ~1.7:1 on paper.
   * Scope only these two families; do not weaken TemplateChecklist dual-surface rings.
   */
  it('keeps template wizard back/step focus rings ≥ 3:1 solid on paper', () => {
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-back:focus-visible \{[\s\S]*?outline:\s*3px\s+solid\s+#9a3d30/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-wizard-steps button:focus-visible \{[\s\S]*?outline:\s*3px\s+solid\s+#9a3d30/,
    )
    // Must not keep the low-contrast alpha wash on these two controls
    expect(launcherStyleSheet).not.toMatch(
      /\.launcher-template-back:focus-visible \{[^}]*rgba\(\s*166\s*,\s*61\s*,\s*47\s*,\s*\.35\s*\)/,
    )
    expect(launcherStyleSheet).not.toMatch(
      /\.launcher-template-wizard-steps button:focus-visible \{[^}]*rgba\(\s*166\s*,\s*61\s*,\s*47\s*,\s*\.35\s*\)/,
    )
    // Checklist dual-surface rings stay on their own tokens (not forced to only #9a3d30 base)
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-checklist button:focus-visible,[\s\S]*?outline:\s*3px\s+solid\s+#a65f3f/,
    )

    const paper = [0xff, 0xfa, 0xf0]
    const solidRing = [0x9a, 0x3d, 0x30]
    const fadedUrushi = parseCssColor('rgba(166, 61, 47, 0.35)', paper)
    expect(contrastRatio(solidRing, paper)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(fadedUrushi, paper)).toBeLessThan(3)
  })

  /**
   * TemplateChecklist dual-surface focus + tech meta (Sol dark/light final audit).
   * - Base ring #a65f3f ≥ 3:1 on paper #fffaf0 and dark expressions #1c1a16
   * - Light override #9a3d30 remains on paper
   * - Backend/id tech code is normal text at .58rem → ≥ 4.5:1 solid (no opacity)
   */
  it('keeps TemplateChecklist focus rings ≥ 3:1 on paper and dark expressions', () => {
    // Dual-surface base covers button / preset option / details summary
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-checklist button:focus-visible,[\s\S]*?\.launcher-template-preset-option:focus-visible,[\s\S]*?\.launcher-template-checklist-details > summary:focus-visible \{[\s\S]*?outline:\s*3px\s+solid\s+#a65f3f/,
    )
    // Light paper override keeps stronger urushi (not forced as dark base)
    expect(launcherStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-template-checklist button:focus-visible,[\s\S]*?\.launcher-template-preset-option:focus-visible \{[\s\S]*?outline:\s*3px\s+solid\s+#9a3d30/,
    )
    expect(launcherStyleSheet).not.toMatch(
      /^\.launcher-template-checklist button:focus-visible \{[\s\S]*?#9a3d30/m,
    )
    // No legacy alpha wash focus
    expect(launcherStyleSheet).not.toMatch(
      /\.launcher-template-checklist-details > summary:focus-visible \{[^}]*rgba\(\s*166\s*,\s*61\s*,\s*47\s*,\s*\.35\s*\)/,
    )
    // Selected/pressed chrome stays separate from focus-visible
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-preset-option\[aria-pressed="true"\] \{[\s\S]*?border-color: var\(--launcher-urushi/,
    )
    // open / marker chrome must remain (summary focus fix is outline-only)
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-checklist-details\[open\] > summary::before \{[\s\S]*?content:\s*"▾ "/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-checklist-details\[open\] > summary \{[\s\S]*?border-bottom:/,
    )

    // Tech id/backend: solid #5c564b, no opacity washout
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-preset-option-tech code \{[\s\S]*?color:\s*#5c564b[\s\S]*?font-size:\s*\.58rem/,
    )
    expect(launcherStyleSheet).not.toMatch(
      /\.launcher-template-preset-option-tech code \{[\s\S]*?opacity:\s*\.85/,
    )
    expect(launcherStyleSheet).not.toMatch(
      /\.launcher-template-preset-option-tech code \{[\s\S]*?color:\s*#7a7368/,
    )

    // Surfaces: light paper + opaque dark expressions panel
    const hinoki = [0xff, 0xfa, 0xf0] // preset option #fffaf0
    const paper = [0xff, 0xfd, 0xf8]
    const detailsSurface = parseCssColor('rgba(255, 250, 240, 0.45)', hinoki)
    const darkExpressions = [0x1c, 0x1a, 0x16] // opaque sumi panel
    const dualRing = [0xa6, 0x5f, 0x3f]
    const lightRing = [0x9a, 0x3d, 0x30]
    const tech = [0x5c, 0x56, 0x4b]

    // Dual-surface base ≥ 3:1 on paper and dark expressions
    expect(contrastRatio(dualRing, hinoki)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(dualRing, paper)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(dualRing, detailsSurface)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(dualRing, darkExpressions)).toBeGreaterThanOrEqual(3)
    // Light override still ≥ 3:1 on paper (and stronger than dual base on hinoki)
    expect(contrastRatio(lightRing, hinoki)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(lightRing, paper)).toBeGreaterThanOrEqual(3)
    // Former base #9a3d30 fails dark expressions; dual base must not regress to it alone
    expect(contrastRatio(lightRing, darkExpressions)).toBeLessThan(3)
    // globals #d18d39 and old rgba urushi fail the UI floor on paper
    expect(contrastRatio([0xd1, 0x8d, 0x39], paper)).toBeLessThan(3)
    const fadedUrushi = parseCssColor('rgba(166, 61, 47, 0.35)', hinoki)
    expect(contrastRatio(fadedUrushi, hinoki)).toBeLessThan(3)
    expect(contrastRatio(fadedUrushi, detailsSurface)).toBeLessThan(3)

    // Normal text floor for .58rem tech meta (composite includes former opacity washout)
    expect(contrastRatio(tech, hinoki)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(tech, [255, 255, 255])).toBeGreaterThanOrEqual(4.5)
    const washedTech = parseCssColor('rgba(122, 115, 104, 0.85)', hinoki)
    expect(contrastRatio(washedTech, hinoki)).toBeLessThan(4.5)
  })

  /**
   * TemplateChecklist expressions panel (default/dark): opaque sumi + kinari alphas.
   * Former rgba(28,26,22,.55) over paper composite ~#7d7970 failed AA for heading/body/small.
   */
  it('keeps dark TemplateChecklist expressions heading/body/small ≥ AA 4.5:1', () => {
    // Opaque dark panel (not alpha wash over paper kinari)
    expect(expressionStyleSheet).toMatch(
      /\.launcher-template-checklist-expressions \{[\s\S]*?background:\s*#1c1a16/,
    )
    expect(expressionStyleSheet).not.toMatch(
      /\.launcher-template-checklist-expressions \{[\s\S]*?background:\s*rgba\(\s*28\s*,\s*26\s*,\s*22\s*,\s*\.55\s*\)/,
    )
    // Light paper override preserved
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-template-checklist-expressions \{[\s\S]*?background:\s*rgba\(\s*255\s*,\s*252\s*,\s*245\s*,\s*\.92\s*\)/,
    )
    // Text tokens
    expect(expressionStyleSheet).toMatch(
      /\.launcher-template-checklist-expressions \{[\s\S]*?color:\s*var\(--launcher-kinari\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-template-checklist-expressions h3,[\s\S]*?color:\s*var\(--launcher-kinari\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-template-checklist-expressions p,[\s\S]*?color:\s*rgba\(\s*244\s*,\s*237\s*,\s*223\s*,\s*\.78\s*\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-template-expression-selection-list small \{[\s\S]*?color:\s*rgba\(\s*244\s*,\s*237\s*,\s*223\s*,\s*\.62\s*\)/,
    )

    const panel = [0x1c, 0x1a, 0x16]
    const paperKinari = [0xf4, 0xed, 0xdf]
    // Former translucent panel composite over paper (must stay failing as regression guard)
    const legacyPanel = parseCssColor('rgba(28, 26, 22, 0.55)', paperKinari)
    const heading = parseCssColor('#f4eddf')
    const body = parseCssColor('rgba(244, 237, 223, 0.78)', panel)
    const small = parseCssColor('rgba(244, 237, 223, 0.62)', panel)
    // selection li is rgba(18,16,13,.45) over the opaque panel
    const liSurface = parseCssColor('rgba(18, 16, 13, 0.45)', panel)
    const smallOnLi = parseCssColor('rgba(244, 237, 223, 0.62)', liSurface)

    expect(contrastRatio(heading, panel)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(body, panel)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(small, panel)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(smallOnLi, liSurface)).toBeGreaterThanOrEqual(4.5)
    // Legacy translucent composite fails AA (document why opaque base is required)
    expect(contrastRatio(heading, legacyPanel)).toBeLessThan(4.5)
    expect(contrastRatio(parseCssColor('rgba(244, 237, 223, 0.78)', legacyPanel), legacyPanel)).toBeLessThan(4.5)
  })

  /**
   * TemplateChecklist expression selection list small captions (light + dark).
   * Light: solid tray ink #2a3832 ≥ 4.5:1.
   * Dark: kinari alpha .62 on opaque #1c1a16 (and li composite) ≥ 4.5:1.
   */
  it('keeps template expression-selection-list small ≥ AA 4.5:1 on light and dark', () => {
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-template-expression-selection-list small \{[\s\S]*?color:\s*#2a3832/,
    )
    // Align with tray destination small contract
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-tray-list small \{[\s\S]*?color:\s*#2a3832/,
    )
    // Dark path keeps muted kinari alpha (not forced to light ink)
    expect(expressionStyleSheet).toMatch(
      /\.launcher-template-expression-selection-list small \{[\s\S]*?color:\s*rgba\(244,\s*237,\s*223,\s*\.62\)/,
    )
    expect(expressionStyleSheet).not.toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-template-expression-selection-list small \{[\s\S]*?color:\s*rgba\(36,\s*48,\s*43,\s*\.62\)/,
    )

    const ink = [0x2a, 0x38, 0x32]
    const white = [255, 255, 255]
    const hinoki = [0xff, 0xfa, 0xf0]
    // li surface is rgba(255,255,255,.72) over hinoki-ish paper
    const liSurface = parseCssColor('rgba(255, 255, 255, 0.72)', hinoki)

    expect(contrastRatio(ink, white)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(ink, hinoki)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(ink, liSurface)).toBeGreaterThanOrEqual(4.5)

    const faded = parseCssColor('rgba(36, 48, 43, 0.62)', white)
    expect(contrastRatio(faded, white)).toBeLessThan(4.5)

    // Dark: composite small on opaque panel + selection li
    const darkPanel = [0x1c, 0x1a, 0x16]
    const darkLi = parseCssColor('rgba(18, 16, 13, 0.45)', darkPanel)
    const darkSmall = parseCssColor('rgba(244, 237, 223, 0.62)', darkPanel)
    const darkSmallOnLi = parseCssColor('rgba(244, 237, 223, 0.62)', darkLi)
    expect(contrastRatio(darkSmall, darkPanel)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(darkSmallOnLi, darkLi)).toBeGreaterThanOrEqual(4.5)
  })

  /**
   * Expression shelf display-group toggle (表示グループ) selected chrome.
   * Dark panel ~#171613: base --launcher-urushi #a63d2f is ~2.87:1 (fails UI 3:1).
   * Selected border/inset must use --launcher-expr-accent-text #d0705c (~5.3:1).
   * Light keeps solid urushi #9a3d30 on paper; text/hover/focus-visible contracts stay separate.
   */
  it('keeps expression group-toggle selected indicator ≥ 3:1 on dark panel', () => {
    // Capture only the dark (non-light) selected block so light urushi does not false-match
    const darkSelected = expressionStyleSheet.match(
      /(?:^|\n)\.launcher-expression-group-toggle button\[aria-pressed="true"\] \{([^}]+)\}/,
    )
    expect(darkSelected).toBeTruthy()
    const darkSelectedBody = darkSelected[1]
    expect(darkSelectedBody).toMatch(/border-color:\s*var\(--launcher-expr-accent-text\)/)
    expect(darkSelectedBody).toMatch(/box-shadow:\s*inset\s+0\s+0\s+0\s+1px\s+var\(--launcher-expr-accent-text\)/)
    expect(darkSelectedBody).toMatch(/color:\s*var\(--launcher-kinari\)/)
    // Must not regress dark selected border to raw urushi
    expect(darkSelectedBody).not.toMatch(/border-color:\s*var\(--launcher-urushi\)/)

    // Light override keeps solid urushi on paper (not dark accent token as the only indicator)
    const lightSelected = expressionStyleSheet.match(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-group-toggle button\[aria-pressed="true"\] \{([^}]+)\}/,
    )
    expect(lightSelected).toBeTruthy()
    expect(lightSelected[1]).toMatch(/border-color:\s*var\(--launcher-urushi\)/)
    expect(lightSelected[1]).toMatch(/color:\s*#24302b/)

    // Unselected / base and light unselected remain distinct from selected accent
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-group-toggle button \{[\s\S]*?border:\s*1px solid rgba\(231, 212, 174, \.24\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-group-toggle button \{[\s\S]*?color:\s*#24302b/,
    )
    // focus-visible stays on shelf buttons (outline mokume), separate from pressed border
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-shelf button:focus-visible[\s\S]*?outline:\s*3px\s+solid\s+var\(--launcher-mokume\)/,
    )

    const darkPanel = [0x17, 0x16, 0x13] // documented composite under group chrome
    const darkAccent = parseCssColor(
      readCssCustomProp(expressionStyleSheet, '--launcher-expr-accent-text', 'dark'),
    )
    const lightPaper = [0xff, 0xfc, 0xf5]
    const lightUrushi = [0x9a, 0x3d, 0x30]
    const legacyUrushi = [0xa6, 0x3d, 0x2f] // --launcher-urushi dark base

    // Dark selected indicator ≥ 3:1 (UI component / non-text)
    expect(contrastRatio(darkAccent, darkPanel)).toBeGreaterThanOrEqual(3)
    // Light selected border keeps existing solid urushi on paper
    expect(contrastRatio(lightUrushi, lightPaper)).toBeGreaterThanOrEqual(3)
    // Synthetic regression: former dark urushi border fails the 3:1 floor
    expect(contrastRatio(legacyUrushi, darkPanel)).toBeLessThan(3)
    expect(contrastRatio(legacyUrushi, darkPanel)).toBeCloseTo(2.87, 1)
  })

  it('keeps expression-shelf .launcher-secondary ≥ AA 4.5:1 on dark/light composites', () => {
    // Scoped override exists (not only globals --ai-700)
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-shelf \.launcher-secondary \{[\s\S]*?color: var\(--launcher-expr-secondary-text\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-shelf \.launcher-secondary \{[\s\S]*?color: var\(--launcher-expr-secondary-text\)/,
    )
    // focus-visible remains clear on the shelf
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-shelf button:focus-visible[\s\S]*?outline:\s*3px\s+solid\s+var\(--launcher-mokume\)/,
    )
    // disabled / aria-disabled share look (focusable soft-disable for catalog pagination)
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-shelf \.launcher-secondary:disabled,\s*\.launcher-expression-shelf \.launcher-secondary\[aria-disabled="true"\] \{[\s\S]*?color: var\(--launcher-expr-secondary-disabled-text\)[\s\S]*?opacity:\s*1/,
    )

    const darkText = readCssCustomProp(expressionStyleSheet, '--launcher-expr-secondary-text', 'dark')
    const darkSurface = readCssCustomProp(expressionStyleSheet, '--launcher-expr-secondary-surface', 'dark')
    const darkDisabled = readCssCustomProp(expressionStyleSheet, '--launcher-expr-secondary-disabled-text', 'dark')
    const lightText = readCssCustomProp(expressionStyleSheet, '--launcher-expr-secondary-text', 'light')
    const lightSurface = readCssCustomProp(expressionStyleSheet, '--launcher-expr-secondary-surface', 'light')
    const lightDisabled = readCssCustomProp(expressionStyleSheet, '--launcher-expr-secondary-disabled-text', 'light')

    const darkFg = parseCssColor(darkText, parseCssColor(darkSurface))
    const darkBg = parseCssColor(darkSurface)
    const lightFg = parseCssColor(lightText, parseCssColor(lightSurface))
    const lightBg = parseCssColor(lightSurface)

    // Normal text ≥ 4.5:1
    expect(contrastRatio(darkFg, darkBg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(lightFg, lightBg)).toBeGreaterThanOrEqual(4.5)
    // Light preserves ~9:1 floor (globals --ai-700 on paper)
    expect(contrastRatio(lightFg, lightBg)).toBeGreaterThanOrEqual(8.5)

    // Disabled still distinguishable from background (UI component ≥ 3:1)
    const darkDisabledFg = parseCssColor(darkDisabled, darkBg)
    const lightDisabledFg = parseCssColor(lightDisabled, lightBg)
    expect(contrastRatio(darkDisabledFg, darkBg)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(lightDisabledFg, lightBg)).toBeGreaterThanOrEqual(3)
    // Disabled is dimmer than normal (state discrimination)
    expect(contrastRatio(darkDisabledFg, darkBg)).toBeLessThan(contrastRatio(darkFg, darkBg))
    expect(contrastRatio(lightDisabledFg, lightBg)).toBeLessThan(contrastRatio(lightFg, lightBg))
  })

  /**
   * TemplateChecklist expressions panel secondary (表現を変更).
   * Panel is opaque #1c1a16; without scoped override, globals --ai-700 (#244d49)
   * is ~1.85:1. Dark needs kinari label ≥4.5:1 and border ≥3:1; light keeps #244d49.
   */
  it('keeps TemplateChecklist expressions .launcher-secondary ≥ AA on dark/light panels', () => {
    // Dark cascade: scoped override wins over globals --ai-700
    const darkSecondary = expressionStyleSheet.match(
      /(?:^|\n)\.launcher-template-checklist-expressions \.launcher-secondary \{([^}]+)\}/,
    )
    expect(darkSecondary).toBeTruthy()
    const darkSecondaryBody = darkSecondary[1]
    expect(darkSecondaryBody).toMatch(/color:\s*var\(--launcher-kinari\)/)
    expect(darkSecondaryBody).toMatch(/border-color:\s*rgba\(\s*231\s*,\s*212\s*,\s*174\s*,\s*\.42\s*\)/)
    expect(darkSecondaryBody).toMatch(/background:\s*transparent/)
    // Must not leave globals teal as the dark panel label
    expect(darkSecondaryBody).not.toMatch(/color:\s*#244d49/)
    expect(darkSecondaryBody).not.toMatch(/color:\s*var\(--ai-700\)/)

    // Dark hover is inverted (distinguishable from default transparent kinari)
    const darkHover = expressionStyleSheet.match(
      /(?:^|\n)\.launcher-template-checklist-expressions \.launcher-secondary:hover:not\(:disabled\) \{([^}]+)\}/,
    )
    expect(darkHover).toBeTruthy()
    expect(darkHover[1]).toMatch(/color:\s*#171817/)
    expect(darkHover[1]).toMatch(/background:\s*var\(--launcher-kinari\)/)

    // Light cascade: explicit #244d49 series (not dark kinari bleed)
    const lightSecondary = expressionStyleSheet.match(
      /\.launcher-shell\[data-theme="light"\] \.launcher-template-checklist-expressions \.launcher-secondary \{([^}]+)\}/,
    )
    expect(lightSecondary).toBeTruthy()
    const lightSecondaryBody = lightSecondary[1]
    expect(lightSecondaryBody).toMatch(/color:\s*#244d49/)
    expect(lightSecondaryBody).toMatch(/border-color:\s*rgba\(\s*36\s*,\s*77\s*,\s*73\s*,\s*0\.24\s*\)/)
    expect(lightSecondaryBody).toMatch(/background:\s*transparent/)
    expect(lightSecondaryBody).not.toMatch(/color:\s*var\(--launcher-kinari\)/)

    const lightHover = expressionStyleSheet.match(
      /\.launcher-shell\[data-theme="light"\] \.launcher-template-checklist-expressions \.launcher-secondary:hover:not\(:disabled\) \{([^}]+)\}/,
    )
    expect(lightHover).toBeTruthy()
    expect(lightHover[1]).toMatch(/background:\s*#244d49/)
    expect(lightHover[1]).toMatch(/color:\s*#fffdf8/)

    // Contrast: dark label + border on opaque panel; light label on paper panel
    const darkPanel = [0x1c, 0x1a, 0x16]
    const darkLabel = [0xf4, 0xed, 0xdf] // --launcher-kinari dark
    const darkBorder = parseCssColor('rgba(231, 212, 174, 0.42)', darkPanel)
    const lightPanel = parseCssColor('rgba(255, 252, 245, 0.92)', [0xff, 0xfa, 0xf0])
    const lightLabel = [0x24, 0x4d, 0x49]
    const legacyAi700 = [0x24, 0x4d, 0x49]

    expect(contrastRatio(darkLabel, darkPanel)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(darkBorder, darkPanel)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(lightLabel, lightPanel)).toBeGreaterThanOrEqual(4.5)
    // Synthetic regression: unscoped globals teal fails dark panel text floor
    expect(contrastRatio(legacyAi700, darkPanel)).toBeLessThan(4.5)
    expect(contrastRatio(legacyAi700, darkPanel)).toBeCloseTo(1.85, 1)
  })

  /**
   * ExpressionShelf heading .eyebrow / .launcher-count.
   * globals .eyebrow #315f59 (~2.7:1) and .launcher-count #66736f (~3.9–4.4:1)
   * fail AA on dark shell #080808–#0d0d0c and light shell gradient #f7f2e8–#ede7dc.
   * Scoped overrides only under .launcher-expression-shelf.
   */
  it('keeps expression-shelf heading .eyebrow and .launcher-count ≥ AA 4.5:1 on dark/light shells', () => {
    // Dark cascade: kinari-series ink, not globals teal/muted
    const darkEyebrow = expressionStyleSheet.match(
      /(?:^|\n)\.launcher-expression-shelf \.eyebrow \{([^}]+)\}/,
    )
    expect(darkEyebrow).toBeTruthy()
    const darkEyebrowBody = darkEyebrow[1]
    expect(darkEyebrowBody).toMatch(/color:\s*var\(--launcher-kinari\)/)
    expect(darkEyebrowBody).not.toMatch(/color:\s*#315f59/)
    expect(darkEyebrowBody).not.toMatch(/color:\s*var\(--ai-600\)/)

    const darkCount = expressionStyleSheet.match(
      /(?:^|\n)\.launcher-expression-shelf \.launcher-count \{([^}]+)\}/,
    )
    expect(darkCount).toBeTruthy()
    const darkCountBody = darkCount[1]
    expect(darkCountBody).toMatch(/color:\s*rgba\(\s*244\s*,\s*237\s*,\s*223\s*,\s*\.78\s*\)/)
    expect(darkCountBody).not.toMatch(/color:\s*#66736f/)
    expect(darkCountBody).not.toMatch(/color:\s*var\(--muted\)/)

    // Light cascade: explicit design ink (not dark kinari bleed)
    const lightEyebrow = expressionStyleSheet.match(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-shelf \.eyebrow \{([^}]+)\}/,
    )
    expect(lightEyebrow).toBeTruthy()
    const lightEyebrowBody = lightEyebrow[1]
    expect(lightEyebrowBody).toMatch(/color:\s*#315f59/)
    expect(lightEyebrowBody).not.toMatch(/color:\s*var\(--launcher-kinari\)/)

    const lightCount = expressionStyleSheet.match(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-shelf \.launcher-count \{([^}]+)\}/,
    )
    expect(lightCount).toBeTruthy()
    const lightCountBody = lightCount[1]
    expect(lightCountBody).toMatch(/color:\s*#2a3832/)
    expect(lightCountBody).not.toMatch(/color:\s*var\(--launcher-kinari\)/)
    expect(lightCountBody).not.toMatch(/color:\s*#66736f/)

    // Documented shell composites (launcher-yakisugi dark gradient / light gradient)
    const darkShells = [
      [0x08, 0x08, 0x08], // --launcher-yakisugi / mid gradient
      [0x0d, 0x0d, 0x0c], // gradient end
    ]
    const lightShells = [
      [0xf7, 0xf2, 0xe8], // light shell gradient start
      [0xed, 0xe7, 0xdc], // light shell gradient end
    ]
    const darkEyebrowFg = [0xf4, 0xed, 0xdf] // --launcher-kinari
    const darkCountFgOn = (bg) => parseCssColor('rgba(244, 237, 223, 0.78)', bg)
    const lightEyebrowFg = [0x31, 0x5f, 0x59]
    const lightCountFg = [0x2a, 0x38, 0x32]
    const legacyEyebrow = [0x31, 0x5f, 0x59] // globals --ai-600
    const legacyCount = [0x66, 0x73, 0x6f] // globals --muted

    for (const bg of darkShells) {
      expect(contrastRatio(darkEyebrowFg, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(darkCountFgOn(bg), bg)).toBeGreaterThanOrEqual(4.5)
      // Synthetic regression: unscoped globals fail dark shell floors
      expect(contrastRatio(legacyEyebrow, bg)).toBeLessThan(4.5)
      expect(contrastRatio(legacyCount, bg)).toBeLessThan(4.5)
    }
    expect(contrastRatio(legacyEyebrow, darkShells[0])).toBeCloseTo(2.78, 1)
    expect(contrastRatio(legacyEyebrow, darkShells[1])).toBeCloseTo(2.70, 1)
    expect(contrastRatio(legacyCount, darkShells[0])).toBeCloseTo(4.05, 1)
    expect(contrastRatio(legacyCount, darkShells[1])).toBeCloseTo(3.93, 1)

    for (const bg of lightShells) {
      expect(contrastRatio(lightEyebrowFg, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(lightCountFg, bg)).toBeGreaterThanOrEqual(4.5)
      // Synthetic regression: globals muted fails light shell paper gradient
      expect(contrastRatio(legacyCount, bg)).toBeLessThan(4.5)
    }
    expect(contrastRatio(legacyCount, lightShells[0])).toBeCloseTo(4.43, 1)
    expect(contrastRatio(legacyCount, lightShells[1])).toBeCloseTo(4.02, 1)
  })

  /**
   * Sol Chrome/a11y residual batch: focus rings, expression input borders,
   * TemplateTypeCard text/selected chrome, template shared muted.
   */
  it('keeps TemplateAxis / shelf retry / Hyperframes focus rings ≥ 3:1 solid (not alpha/globals wash)', () => {
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-axis-option:focus-visible \{[\s\S]*?outline:\s*3px\s+solid\s+#9a3d30/,
    )
    expect(launcherStyleSheet).not.toMatch(
      /\.launcher-template-axis-option:focus-visible \{[^}]*rgba\(\s*166\s*,\s*61\s*,\s*47\s*,\s*\.35\s*\)/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-axis-heading \.launcher-secondary:focus-visible \{[\s\S]*?outline:\s*3px\s+solid\s+#9a3d30/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-catalog-error \.launcher-secondary:focus-visible,[\s\S]*?outline:\s*3px\s+solid\s+#9a3d30/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-hyperframes-catalog > summary:focus-visible \{[\s\S]*?outline:\s*3px\s+solid\s+#275e58/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-hyperframes-catalog-toolbar select:focus-visible,[\s\S]*?outline:\s*3px\s+solid\s+#275e58/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-hyperframes-catalog-tag:focus-visible \{[\s\S]*?outline:\s*3px\s+solid\s+#275e58/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-hyperframes-catalog \.launcher-secondary:focus-visible,[\s\S]*?outline:\s*3px\s+solid\s+#9a3d30/,
    )

    const paper = [0xff, 0xfa, 0xf0]
    const solidUrushi = [0x9a, 0x3d, 0x30]
    const solidSeiji = [0x27, 0x5e, 0x58]
    const fadedUrushi = parseCssColor('rgba(166, 61, 47, 0.35)', paper)
    const globalsAmber = [0xd1, 0x8d, 0x39]
    expect(contrastRatio(solidUrushi, paper)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(solidSeiji, paper)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(fadedUrushi, paper)).toBeLessThan(3)
    expect(contrastRatio(globalsAmber, paper)).toBeLessThan(3)
  })

  it('keeps expression input borders ≥ 3:1 on dark/light fills (hover/focus/readonly explicit)', () => {
    // Dark base borders use stronger alpha (not legacy .28 ~2.0:1)
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-intent-free textarea,[\s\S]*?border:\s*1px\s+solid\s+rgba\(\s*231\s*,\s*212\s*,\s*174\s*,\s*\.55\s*\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-search-field \{[\s\S]*?border:\s*1px\s+solid\s+rgba\(\s*231\s*,\s*212\s*,\s*174\s*,\s*\.55\s*\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-role-filter select \{[\s\S]*?border:\s*1px\s+solid\s+rgba\(\s*231\s*,\s*212\s*,\s*174\s*,\s*\.55\s*\)/,
    )
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-freeform-export-text \{[\s\S]*?border:\s*1px\s+solid\s+rgba\(\s*231\s*,\s*212\s*,\s*174\s*,\s*\.55\s*\)/,
    )
    expect(expressionStyleSheet).toMatch(/:hover \{[\s\S]*?border-color:\s*rgba\(\s*231\s*,\s*212\s*,\s*174\s*,\s*\.68\s*\)/)
    expect(expressionStyleSheet).toMatch(
      /\.launcher-expression-freeform-export-text\[readonly\],[\s\S]*?border-color:\s*rgba\(\s*231\s*,\s*212\s*,\s*174\s*,\s*\.55\s*\)/,
    )

    // Light borders ≥3:1 (not legacy .18 ~1.4:1)
    expect(expressionStyleSheet).toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-intent-free textarea,[\s\S]*?border-color:\s*rgba\(\s*52\s*,\s*43\s*,\s*30\s*,\s*\.55\s*\)/,
    )
    expect(expressionStyleSheet).not.toMatch(
      /\.launcher-shell\[data-theme="light"\] \.launcher-expression-intent-free textarea,[\s\S]*?border-color:\s*rgba\(\s*52\s*,\s*43\s*,\s*30\s*,\s*\.18\s*\)/,
    )

    const darkFill = [12, 11, 9]
    const lightFill = [255, 255, 255]
    const darkBorder = parseCssColor('rgba(231, 212, 174, 0.55)', darkFill)
    const darkLegacy = parseCssColor('rgba(231, 212, 174, 0.28)', darkFill)
    const lightBorder = parseCssColor('rgba(52, 43, 30, 0.55)', lightFill)
    const lightLegacy = parseCssColor('rgba(52, 43, 30, 0.18)', lightFill)
    expect(contrastRatio(darkBorder, darkFill)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(darkLegacy, darkFill)).toBeLessThan(3)
    expect(contrastRatio(lightBorder, lightFill)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(lightLegacy, lightFill)).toBeLessThan(3)
  })

  it('keeps TemplateTypeCard accent text ≥4.5, selected chrome ≥3, solid action focus ring ≥3', () => {
    // Darker tone accents (legacy product/explainer/assembly failed text or white-on-bar)
    // Tag ink may differ from accent (explainer needs denser ink on 13% wash)
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-card\[data-tone="product"\] \{ --template-accent: #8a3d32; --template-tag-ink: #8a3d32; \}/,
    )
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-card\[data-tone="explainer"\] \{ --template-accent: #3d6b5c; --template-tag-ink: #2f5a4d; \}/,
    )
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-card\[data-tone="assembly"\] \{ --template-accent: #7a4a28; --template-tag-ink: #7a4a28; \}/,
    )
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-card\[data-tone="seminar"\] \{ --template-accent: #3a5166; --template-tag-ink: #3a5166; \}/,
    )
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-card-tags b \{ color: var\(--template-tag-ink\); background: color-mix\(in srgb, var\(--template-accent\) 13%, transparent\); \}/,
    )
    // Solid focus ring (not accent 62%+white wash)
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-card-actions \.launcher-primary:focus-visible,[\s\S]*?outline:\s*3px\s+solid\s+#9a3d30/,
    )
    expect(globalsStyleSheet).not.toMatch(
      /color-mix\(in srgb, var\(--template-accent\) 62%, white\)/,
    )
    // Selected uses inset chrome + accent border (not label-only)
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-card\[data-selected="true"\] \{[\s\S]*?inset 0 0 0 1px/,
    )
    // Card muted denser than globals #66736f (topline/summary/flow/input-types)
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-card-topline small \{ color: #4a534e;/,
    )
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-card-summary \{[\s\S]*?color: #4a534e;/,
    )
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-flow \{[\s\S]*?color: #4a534e;/,
    )
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-input-types i \{[\s\S]*?color: #4a534e;/,
    )
    expect(globalsStyleSheet).not.toMatch(
      /\.launcher-template-flow \{[^}]*color:\s*var\(--muted\)/,
    )
    expect(globalsStyleSheet).not.toMatch(
      /\.launcher-template-input-types i \{[^}]*color:\s*var\(--muted\)/,
    )

    const paperStart = [0xff, 0xfd, 0xfa]
    const paperEnd = [0xee, 0xeb, 0xe1]
    const selectedBase = [0xf3, 0xee, 0xe5] // color-mix base for selected gradient dark end
    const white = [0xff, 0xfd, 0xf8]
    const tones = {
      product: { accent: [0x8a, 0x3d, 0x32], tagInk: [0x8a, 0x3d, 0x32] },
      explainer: { accent: [0x3d, 0x6b, 0x5c], tagInk: [0x2f, 0x5a, 0x4d] },
      assembly: { accent: [0x7a, 0x4a, 0x28], tagInk: [0x7a, 0x4a, 0x28] },
      seminar: { accent: [0x3a, 0x51, 0x66], tagInk: [0x3a, 0x51, 0x66] },
    }
    const legacy = {
      product: [0xb8, 0x5c, 0x4a],
      explainer: [0x6f, 0x9b, 0x8d],
      assembly: [0xa8, 0x6d, 0x45],
    }
    for (const [name, { accent }] of Object.entries(tones)) {
      expect(contrastRatio(accent, paperStart)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(accent, paperEnd)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(white, accent)).toBeGreaterThanOrEqual(4.5)
      // Selected border on paper ≥ 3:1
      expect(contrastRatio(accent, paperStart)).toBeGreaterThanOrEqual(3)
      void name
    }
    for (const accent of Object.values(legacy)) {
      // At least one legacy failure on card gradient / white-on-bar remains a negative check
      const textOnEnd = contrastRatio(accent, paperEnd)
      const whiteOn = contrastRatio(white, accent)
      expect(textOnEnd < 4.5 || whiteOn < 4.5).toBe(true)
    }
    const mutedNew = [0x4a, 0x53, 0x4e]
    const mutedLegacy = [0x66, 0x73, 0x6f]
    // Normal gradient dark end (~4.15 for legacy) + selected tint (~3.74) for all 4 tones
    expect(contrastRatio(mutedNew, paperEnd)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(mutedLegacy, paperEnd)).toBeLessThan(4.5)
    for (const { accent, tagInk } of Object.values(tones)) {
      // selected: linear-gradient end ≈ color-mix(in srgb, accent 11%, #f3eee5)
      const selectedEnd = accent.map((ch, i) => Math.round(ch * 0.11 + selectedBase[i] * 0.89))
      expect(contrastRatio(mutedNew, selectedEnd)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(mutedLegacy, selectedEnd)).toBeLessThan(4.5)
      // Tag b @ 0.59rem on accent 13% wash over card ends (normal + selected)
      const tagWashNormal = accent.map((ch, i) => Math.round(ch * 0.13 + paperEnd[i] * 0.87))
      const tagWashSelected = accent.map((ch, i) => Math.round(ch * 0.13 + selectedEnd[i] * 0.87))
      expect(contrastRatio(tagInk, tagWashNormal)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(tagInk, tagWashSelected)).toBeGreaterThanOrEqual(4.5)
    }
    // Regression: bare explainer accent fails AA on the same tag washes (~4.29 / ~3.89)
    {
      const explainerAccent = tones.explainer.accent
      const selectedEnd = explainerAccent.map((ch, i) =>
        Math.round(ch * 0.11 + selectedBase[i] * 0.89),
      )
      const tagWashNormal = explainerAccent.map((ch, i) =>
        Math.round(ch * 0.13 + paperEnd[i] * 0.87),
      )
      const tagWashSelected = explainerAccent.map((ch, i) =>
        Math.round(ch * 0.13 + selectedEnd[i] * 0.87),
      )
      expect(contrastRatio(explainerAccent, tagWashNormal)).toBeLessThan(4.5)
      expect(contrastRatio(explainerAccent, tagWashSelected)).toBeLessThan(4.5)
    }
    const solidRing = [0x9a, 0x3d, 0x30]
    expect(contrastRatio(solidRing, paperStart)).toBeGreaterThanOrEqual(3)

    // Invalid/default card (no data-tone): topline「設定を確認」must not use bare #6f9b8d accent.
    // Vertical bar override does not reach .launcher-template-card-topline > span.
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-card\[data-invalid="true"\] \.launcher-template-card-topline > span \{ color: #6b3029; \}/,
    )
    expect(globalsStyleSheet).toMatch(
      /\.launcher-template-card \{[\s\S]*?--template-accent: #6f9b8d;/,
    )
    const invalidToplineInk = [0x6b, 0x30, 0x29]
    const defaultAccentLegacy = [0x6f, 0x9b, 0x8d]
    // Effective card gradient ends (normal invalid card; not selected-tint)
    expect(contrastRatio(invalidToplineInk, paperStart)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(invalidToplineInk, paperEnd)).toBeGreaterThanOrEqual(4.5)
    // Regression: old default accent fails AA on the same composite backgrounds
    expect(contrastRatio(defaultAccentLegacy, paperStart)).toBeLessThan(4.5)
    expect(contrastRatio(defaultAccentLegacy, paperEnd)).toBeLessThan(4.5)
    expect(contrastRatio(defaultAccentLegacy, paperStart)).toBeCloseTo(3.065, 2)
    expect(contrastRatio(defaultAccentLegacy, paperEnd)).toBeCloseTo(2.609, 2)
  })

  it('keeps template shared muted denser on dark shell; readonly note denser on both themes', () => {
    // count + empty p share one dark-only rule (empty is last, no trailing comma)
    expect(launcherStyleSheet).toMatch(
      /\.launcher-shell:not\(\[data-theme="light"\]\) \.launcher-template-wizard \.launcher-count,[\s\S]*?\.launcher-template-wizard \.launcher-empty p\s*\{[\s\S]*?color:\s*#4a534e/,
    )
    // count/empty remain dark-only; readonly note is theme-common
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-checklist \.launcher-readonly-note p\s*\{[\s\S]*?color:\s*#4a534e/,
    )
    expect(launcherStyleSheet).not.toMatch(
      /\.launcher-shell:not\(\[data-theme="light"\]\) \.launcher-template-checklist \.launcher-readonly-note p/,
    )

    const paper = [0xff, 0xfa, 0xf0]
    const lightPaper = [0xff, 0xfc, 0xf5]
    const readonlyTintOnPaper = parseCssColor('rgba(206, 169, 121, 0.12)', paper)
    const readonlyTintOnLight = parseCssColor('rgba(206, 169, 121, 0.12)', lightPaper)
    const dense = [0x4a, 0x53, 0x4e]
    const legacyMuted = [0x66, 0x73, 0x6f]
    expect(contrastRatio(dense, paper)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(dense, lightPaper)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(dense, readonlyTintOnPaper)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(dense, readonlyTintOnLight)).toBeGreaterThanOrEqual(4.5)
    // Legacy globals muted fails slightly on explicit hinoki tint (~4.48:1 light)
    expect(contrastRatio(legacyMuted, readonlyTintOnPaper)).toBeLessThan(4.5)
    expect(contrastRatio(legacyMuted, readonlyTintOnLight)).toBeLessThan(4.5)
  })

  it('keeps wizard step soft-disable CSS for aria-disabled (not only :disabled)', () => {
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-wizard-steps button:disabled,\s*\.launcher-template-wizard-steps button\[aria-disabled="true"\]/,
    )
    expect(launcherStyleSheet).toMatch(
      /\.launcher-template-wizard-steps button:not\(:disabled\):not\(\[aria-disabled="true"\]\):hover/,
    )
  })
})

function readCssCustomProp(css, propName, theme) {
  const block = theme === 'light'
    ? css.match(
      new RegExp(
        `\\.launcher-shell\\[data-theme="light"\\] \\.launcher-expression-shelf \\{([\\s\\S]*?)\\n\\}`,
      ),
    )
    : css.match(/\.launcher-expression-shelf \{([\s\S]*?)\n\}/)
  if (!block) throw new Error(`missing shelf block for theme=${theme}`)
  const match = block[1].match(new RegExp(`${propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*([^;]+);`))
  if (!match) throw new Error(`missing ${propName} for theme=${theme}`)
  return match[1].trim()
}

function parseCssColor(value, blendOnto) {
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = Number.parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgba = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i)
  if (!rgba) throw new Error(`unsupported color: ${value}`)
  const rgb = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])]
  const alpha = rgba[4] === undefined ? 1 : Number(rgba[4])
  if (alpha >= 1) return rgb
  return rgb.map((channel, index) => Math.round(channel * alpha + blendOnto[index] * (1 - alpha)))
}

function relativeLuminance([r, g, b]) {
  const channel = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrastRatio(fg, bg) {
  const L1 = relativeLuminance(fg)
  const L2 = relativeLuminance(bg)
  const lighter = Math.max(L1, L2)
  const darker = Math.min(L1, L2)
  return (lighter + 0.05) / (darker + 0.05)
}
