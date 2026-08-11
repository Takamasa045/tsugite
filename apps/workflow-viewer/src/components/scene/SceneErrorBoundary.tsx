import { Component, type ErrorInfo, type ReactNode } from 'react'

interface SceneErrorBoundaryProps {
  children: ReactNode
  fallback: ReactNode
  onError: (error: unknown, info: ErrorInfo) => void
  resetKey?: unknown
}

interface SceneErrorBoundaryState {
  error: unknown | null
}

/**
 * Error isolation for the renderer only. The caught exception never becomes
 * part of the public viewer projection; the parent maps it to a reason code.
 */
export class SceneErrorBoundary extends Component<
  SceneErrorBoundaryProps,
  SceneErrorBoundaryState
> {
  state: SceneErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): SceneErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.props.onError(error, info)
  }

  componentDidUpdate(previousProps: SceneErrorBoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  render() {
    return this.state.error === null ? this.props.children : this.props.fallback
  }
}
