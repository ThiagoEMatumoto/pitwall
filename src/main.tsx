import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { loadKeyboardLayoutLabels } from './lib/keybindings'
import './index.css'

// Warm-up das fontes bundladas já no boot do renderer. JetBrains Mono destrava
// o gate de open do Terminal; Schibsted Grotesk é a fonte de UI (evita reflow
// da interface quando a família da marca termina de carregar).
void document.fonts.load('16px "JetBrains Mono"')
void document.fonts.load('400 16px "Schibsted Grotesk"')
void document.fonts.load('600 16px "Schibsted Grotesk"')
void document.fonts.load('700 16px "Schibsted Grotesk"')
// Rótulos dos atalhos no layout do teclado (ABNT2: Ctrl+' em vez de Ctrl+`).
void loadKeyboardLayoutLabels()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
