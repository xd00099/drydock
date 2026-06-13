import ReactDOM from 'react-dom/client'
import App from './App'

// no <StrictMode>: it double-fires effects in dev, which would spawn every PTY twice
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
