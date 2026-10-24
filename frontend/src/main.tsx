import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/index.css'
import './index.css'
import App from './App.tsx'
import { rememberShareFromUrl } from './share'
import { applyTheme, savedTheme } from './theme'

applyTheme(savedTheme())
rememberShareFromUrl()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
