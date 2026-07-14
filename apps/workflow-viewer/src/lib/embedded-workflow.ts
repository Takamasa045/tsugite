export interface ViewerSampleInput {
  id: string
  label: string
  data: unknown
  initialTime?: number
}

const EMBEDDED_SAMPLE_ID = 'tsugite-embedded-workflow'
const DEFAULT_EMBEDDED_LABEL = 'Tsugite workflow'

function parseEmbeddedWorkflowJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function getEmbeddedWorkflowLabel(data: unknown): string {
  if (typeof data !== 'object' || data === null || !('name' in data)) {
    return DEFAULT_EMBEDDED_LABEL
  }

  return typeof data.name === 'string' ? data.name : DEFAULT_EMBEDDED_LABEL
}

function getEmbeddedWorkflowTime(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null || !('duration' in data)) return undefined
  return typeof data.duration === 'number' && Number.isFinite(data.duration)
    ? Math.max(0, data.duration)
    : undefined
}

export function resolveViewerSamples<T extends ViewerSampleInput>(
  embeddedText: string | null,
  fallbackSamples: T[],
): ViewerSampleInput[] {
  if (embeddedText === null) return fallbackSamples

  const data = parseEmbeddedWorkflowJson(embeddedText)

  return [
    {
      id: EMBEDDED_SAMPLE_ID,
      label: getEmbeddedWorkflowLabel(data),
      data,
      initialTime: getEmbeddedWorkflowTime(data),
    },
  ]
}
