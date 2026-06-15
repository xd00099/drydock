import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

// Last-resort guard: a thrown error in any child renders this fallback (with the
// message, so it's diagnosable) instead of unmounting the whole app to a blank
// screen. Reload recovers.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Drydock crashed:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#10141a', color: '#e8edf4', fontFamily: 'system-ui', fontSize: 13, padding: 28, boxSizing: 'border-box', overflow: 'auto' }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Something went wrong.</div>
        <div style={{ color: '#e8907a', whiteSpace: 'pre-wrap', marginBottom: 16, fontFamily: 'Menlo, monospace', fontSize: 12 }}>
          {this.state.error.message}
        </div>
        <button onClick={() => location.reload()} style={{ background: '#1d2530', color: '#e8edf4', border: '1px solid #2c3647', borderRadius: 5, padding: '6px 14px', cursor: 'pointer' }}>
          Reload
        </button>
      </div>
    )
  }
}
