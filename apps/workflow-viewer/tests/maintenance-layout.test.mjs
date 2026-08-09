import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const maintenanceStyleSheet = readFileSync(
  resolve(process.cwd(), 'src/styles/maintenance.css'),
  'utf8',
)

describe('maintenance shelf layout contract', () => {
  it('keeps long project selectors inside the finalize panel', () => {
    expect(maintenanceStyleSheet).toMatch(
      /\.maintenance-panel \{[^}]*min-width:\s*0/,
    )
    expect(maintenanceStyleSheet).toMatch(
      /\.maintenance-field \{[^}]*min-width:\s*0[^}]*max-width:\s*100%/,
    )
    expect(maintenanceStyleSheet).toMatch(
      /\.maintenance-field select \{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*max-width:\s*100%/,
    )
  })
})
