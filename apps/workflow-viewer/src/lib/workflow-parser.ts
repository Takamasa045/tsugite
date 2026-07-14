import type { WorkflowValidationResult } from '../types/workflow'
import { validateWorkflowData } from './workflow-validator'

export { validateWorkflowData } from './workflow-validator'

export function parseWorkflowJson(json: string): WorkflowValidationResult {
  try {
    return validateWorkflowData(JSON.parse(json) as unknown)
  } catch (error) {
    return {
      success: false,
      errors: [
        {
          code: 'invalid_json',
          message: error instanceof Error ? error.message : 'JSON could not be parsed',
          path: '$',
        },
      ],
    }
  }
}
