import errorWorkflowJson from './sample-error-workflow.json'
import videoWorkflowJson from './sample-video-workflow.json'
import webWorkflowJson from './sample-web-workflow.json'
import { validateWorkflowData } from '../lib/workflow-validator'
import type { WorkflowData } from '../types/workflow'

export interface WorkflowSample {
  id: string
  label: string
  data: WorkflowData
}

function loadBundledWorkflow(input: unknown): WorkflowData {
  const result = validateWorkflowData(input)
  if (!result.success) {
    throw new Error(`Invalid bundled workflow: ${result.errors.map((error) => error.message).join('; ')}`)
  }
  return result.data
}

export const videoWorkflow = loadBundledWorkflow(videoWorkflowJson)
export const webWorkflow = loadBundledWorkflow(webWorkflowJson)
export const errorWorkflow = loadBundledWorkflow(errorWorkflowJson)

export const workflowSamples: WorkflowSample[] = [
  { id: 'ai-video', label: 'AI動画制作', data: videoWorkflow },
  { id: 'web-app', label: 'Webアプリ開発', data: webWorkflow },
  { id: 'error-recovery', label: 'エラー復旧', data: errorWorkflow },
]
