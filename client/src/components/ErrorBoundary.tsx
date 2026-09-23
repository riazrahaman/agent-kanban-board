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
          <div className="m-6 border border-fail bg-fail-bg p-4 font-mono text-xs text-fail">
            <p className="font-semibold uppercase tracking-wider">Rendering Error</p>
            <p className="mt-1 break-words opacity-90 [overflow-wrap:anywhere]">
              {this.state.error.message}
            </p>
          </div>
        )
      }
     return this.props.children
  }
}
