import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

// Without an error boundary, any render throw in a single card (e.g. an unmapped
// priority) propagates and unmounts the whole React tree, leaving a blank #root.
// The boundary catches render errors, shows a visible message, and stays alive so
// the rest of the board keeps rendering.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
     return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
     console.error('[render]', error, info.componentStack)
  }

  render() {
     if (this.state.error) {
       return (
          <div className="m-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            <p className="font-semibold">Something failed to render.</p>
            <p className="mt-1 font-mono text-xs opacity-80">{this.state.error.message}</p>
           </div>
        )
      }
     return this.props.children
  }
}
