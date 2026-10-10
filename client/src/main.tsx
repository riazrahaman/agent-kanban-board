import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installPinchZoomGuard } from './lib/pinchZoomGuard'
import './index.css'

// v3.2.3 (GH #103 follow-up): belt-and-braces pinch-zoom guard — see
// pinchZoomGuard.ts for why the viewport meta tag alone doesn't stop this on
// a real iPhone. Document-level, so installed once outside React.
installPinchZoomGuard()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
