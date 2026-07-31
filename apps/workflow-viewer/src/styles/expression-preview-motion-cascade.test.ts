import { describe, expect, it } from 'vitest'

async function readRepoFile(relativeFromViewerRoot: string): Promise<string> {
  // vitest only — dynamic import keeps typecheck free of @types/node.
  const nodeFs = 'node:fs'
  const nodePath = 'node:path'
  const fs = await import(/* @vite-ignore */ nodeFs) as {
    readFileSync: (path: string, encoding: string) => string
  }
  const path = await import(/* @vite-ignore */ nodePath) as {
    resolve: (...parts: string[]) => string
  }
  const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.()
  if (!cwd) throw new Error('process.cwd is unavailable')
  return fs.readFileSync(path.resolve(cwd, relativeFromViewerRoot), 'utf8')
}

function extractMediaBlockContaining(css: string, needle: string | RegExp): string {
  const marker = '@media (prefers-reduced-motion: reduce)'
  let from = 0
  while (from < css.length) {
    const start = css.indexOf(marker, from)
    if (start < 0) break
    let i = css.indexOf('{', start)
    if (i < 0) break
    let depth = 0
    for (; i < css.length; i += 1) {
      const ch = css[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          const block = css.slice(start, i + 1)
          if (typeof needle === 'string' ? block.includes(needle) : needle.test(block)) {
            return block
          }
          from = i + 1
          break
        }
      }
    }
    if (i >= css.length) break
  }
  throw new Error(`prefers-reduced-motion block containing ${String(needle)} not found`)
}

describe('expression preview reduced-motion CSS cascade', () => {
  it('globals blanket-zeroes animation duration/iteration under reduced motion', async () => {
    const globalsCss = await readRepoFile('src/styles/globals.css')
    const block = extractMediaBlockContaining(globalsCss, 'animation-duration: 0.01ms')
    expect(block).toMatch(/\*\s*,\s*\*::before\s*,\s*\*::after/)
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/)
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/)
  })

  it('expression-shelf restores duration and infinite only while data-playing=true', async () => {
    const expressionCss = await readRepoFile('src/styles/expression-shelf.css')
    const block = extractMediaBlockContaining(
      expressionCss,
      'animation-duration: var(--expr-preview-duration)',
    )
    expect(block).toMatch(
      /\.launcher-expression-preview-stage\[data-playing="true"\][\s\S]*animation-duration:\s*var\(--expr-preview-duration\)\s*!important/,
    )
    expect(block).toMatch(
      /\.launcher-expression-preview-stage\[data-playing="true"\][\s\S]*animation-iteration-count:\s*infinite\s*!important/,
    )
    expect(block).toMatch(
      /\.launcher-expression-preview-stage:not\(\[data-playing="true"\]\)[\s\S]*animation:\s*none\s*!important/,
    )
    // Must not blanket-disable all expression motion under reduced motion.
    expect(block).not.toMatch(
      /\.launcher-expression-preview-stage\s*\{[^}]*animation:\s*none\s*!important/,
    )
  })

  it('main loads globals → launcher → expression-shelf so restore rules win the cascade', async () => {
    const mainTsx = await readRepoFile('src/main.tsx')
    const globalsIdx = mainTsx.indexOf("./styles/globals.css")
    const launcherIdx = mainTsx.indexOf("./styles/launcher-yakisugi.css")
    const expressionIdx = mainTsx.indexOf("./styles/expression-shelf.css")
    expect(globalsIdx).toBeGreaterThanOrEqual(0)
    expect(launcherIdx).toBeGreaterThan(globalsIdx)
    expect(expressionIdx).toBeGreaterThan(launcherIdx)
  })

  it('applies dual focus indicator to all light-theme expression shelf controls', async () => {
    const expressionCss = await readRepoFile('src/styles/expression-shelf.css')
    // Shelf-wide (includes freeform export, cards, intent, search, primary/secondary)
    expect(expressionCss).toMatch(
      /\.launcher-shell\[data-theme="light"\]\s+\.launcher-expression-shelf button:focus-visible/,
    )
    expect(expressionCss).toMatch(
      /\.launcher-shell\[data-theme="light"\]\s+\.launcher-expression-shelf select:focus-visible/,
    )
    expect(expressionCss).toMatch(
      /\.launcher-shell\[data-theme="light"\]\s+\.launcher-expression-shelf input:focus-visible/,
    )
    expect(expressionCss).toMatch(
      /\.launcher-shell\[data-theme="light"\]\s+\.launcher-expression-shelf textarea:focus-visible/,
    )
    const focusCluster = expressionCss.match(
      /\.launcher-shell\[data-theme="light"\]\s+\.launcher-expression-shelf button:focus-visible[\s\S]*?\{[^}]+\}/,
    )
    const block = focusCluster?.[0] ?? ''
    // Dual indicator: white separator + dark outer ring (≥3:1 on white and red buttons)
    expect(block).toMatch(/outline:\s*2px\s+solid\s+#ffffff/)
    expect(block).toMatch(/box-shadow:\s*0\s+0\s+0\s+5px\s+#1f1a16/)
    // Must not rely on globals #d18d39 for expression shelf light focus
    expect(block).not.toMatch(/#d18d39/)
  })

  it('keeps dark-theme expression shelf focus ring (does not blank it)', async () => {
    const expressionCss = await readRepoFile('src/styles/expression-shelf.css')
    expect(expressionCss).toMatch(
      /\.launcher-expression-shelf button:focus-visible[\s\S]*?outline:\s*3px\s+solid\s+var\(--launcher-mokume\)/,
    )
  })

  it('keeps expression shelf rules out of launcher-yakisugi.css', async () => {
    const launcherCss = await readRepoFile('src/styles/launcher-yakisugi.css')
    expect(launcherCss).not.toMatch(/\.launcher-expression-shelf\s*\{/)
    expect(launcherCss).not.toMatch(/\.launcher-expression-preview-stage/)
  })
})
