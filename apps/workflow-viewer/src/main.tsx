import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App'
import { workflowSamples } from './data'
import { resolveViewerSamples } from './lib/embedded-workflow'
import './styles/globals.css'

const root = document.getElementById('root')
const embeddedWorkflowText = document.getElementById('tsugite-workflow-data')?.textContent ?? null
const samples = resolveViewerSamples(embeddedWorkflowText, workflowSamples)

if (!root) throw new Error('Root element was not found')

createRoot(root).render(
  <StrictMode>
    <App samples={samples} />
  </StrictMode>,
)
