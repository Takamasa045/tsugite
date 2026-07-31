import { vi } from 'vitest'

import type { ExpressionSelection } from './expressionLibraryModel'

export const catalogResponse = {
  ok: true as const,
  schemaVersion: 1 as const,
  source: 'hyperframes' as const,
  advisoryOnly: true as const,
  capabilityVerified: false as const,
  summary: {
    total: 3,
    returned: 3,
    omitted: 0,
    byType: { block: 1, component: 2 },
  },
  items: [
    {
      id: 'data-chart',
      type: 'component' as const,
      title: 'Data Chart',
      description: 'Animated chart',
      tags: ['data', 'chart'],
    },
    {
      id: 'typewriter',
      type: 'component' as const,
      title: 'Typewriter',
      description: 'Text effect',
      tags: ['text', 'caption'],
    },
    {
      id: 'shader-mesh',
      type: 'block' as const,
      title: 'Shader Mesh',
      description: '3D mesh',
      tags: ['3d', 'shader'],
    },
  ],
  warnings: [] as string[],
}

export function buildLargeCatalog(count: number) {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${String(index + 1).padStart(3, '0')}`,
    type: (index % 2 === 0 ? 'component' : 'block') as 'component' | 'block',
    title: `Catalog Item ${index + 1}`,
    description: `Sample description ${index + 1}`,
    tags: index % 3 === 0
      ? ['data', 'chart']
      : index % 3 === 1
        ? ['text', 'caption']
        : ['3d', 'shader'],
  }))
  return {
    ...catalogResponse,
    summary: {
      total: count,
      returned: count,
      omitted: 0,
      byType: { block: Math.floor(count / 2), component: Math.ceil(count / 2) },
    },
    items,
  }
}

export const presentationPresets = [
  {
    backend: 'remotion',
    backendLabel: 'Remotion',
    id: 'article-dialogue-16x9',
    label: '横型・会話で解説',
    description: '記事を会話で伝える',
    aspectRatio: '16:9' as const,
  },
  {
    backend: 'remotion',
    backendLabel: 'Remotion',
    id: 'miraichi-lastcall-9x16',
    label: '縦型・締切／申込案内',
    description: '縦型案内',
    aspectRatio: '9:16' as const,
  },
  {
    backend: 'hyperframes',
    backendLabel: 'HyperFrames',
    id: 'article-explainer-16x9',
    label: '横型・資料付き解説',
    description: '資料付き',
    aspectRatio: '16:9' as const,
  },
]

export function createFetcher(catalog: unknown = catalogResponse) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/reference-catalogs/hyperframes')) {
      return {
        ok: true,
        json: async () => catalog,
      } as Response
    }
    return {
      ok: false,
      json: async () => ({ ok: false }),
    } as Response
  })
}

export const sampleSelection: ExpressionSelection = {
  key: 'presentation-preset::remotion::article-dialogue-16x9',
  provider: 'remotion',
  nativeId: 'article-dialogue-16x9',
  title: '横型・会話で解説',
  role: 'full-composition',
  capability: 'declared-executable-candidate',
  previewFidelity: 'composition-storyboard',
  reason: '解説向き',
  source: 'presentation-preset',
}

export const defaultShelfProps = {
  presentationPresetLoadState: 'ready' as const,
  presentationPresets,
  selectionMode: 'unset' as const,
  selections: [] as ExpressionSelection[],
  token: 'session-token',
}
