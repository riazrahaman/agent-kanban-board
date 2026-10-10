import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installPinchZoomGuard } from './lib/pinchZoomGuard'
import './index.css'

// v3.2.3 (GH #103 follow-up): belt-and-braces pinch/double-tap zoom guard —
// see pinchZoomGuard.ts for why the viewport meta tag alone does not stop
// this on a real iPhone. Installed once at startup, outside React: it is a
// document-level concern, not component state, and never needs to be
// re-installed or torn down for the lifetime of the page.
installPinchZoomGuard()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
