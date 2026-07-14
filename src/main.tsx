import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import { initTheme } from './theme'
import './index.css'

// Theme attribute must be set before the first paint — a light-theme user
// must not flash dark chrome on launch.
initTheme()

// no <StrictMode>: it double-fires effects in dev, which would spawn every PTY twice
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
