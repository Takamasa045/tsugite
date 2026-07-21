import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'

import { App } from './app/App'
import { LauncherApp } from './app/LauncherApp'
import { workflowSamples } from './data'
import { resolveViewerSamples } from './lib/embedded-workflow'
import './styles/globals.css'
import './styles/launcher-yakisugi.css'
import './styles/generation-canvas.css'

const root = document.getElementById('root')
const launcherMode = document.querySelector('meta[name="tsugite-launcher"]') !== null
const embeddedWorkflowText = document.getElementById('tsugite-workflow-data')?.textContent ?? null
const samples = resolveViewerSamples(embeddedWorkflowText, workflowSamples)

if (!root) throw new Error('Root element was not found')

createRoot(root).render(
  <StrictMode>
    {launcherMode ? <LauncherApp /> : <App samples={samples} />}
  </StrictMode>,
)
