import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setupFaro } from './faro'
import './index.css'
import App from './App.tsx'

setupFaro()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
