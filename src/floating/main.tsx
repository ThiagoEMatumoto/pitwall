import React from 'react'
import ReactDOM from 'react-dom/client'
import '../index.css'
import { loadAndApplyTheme } from '@/app/useTheme'
import { FloatingApp } from './FloatingApp'

// Mesmo tema da janela principal (pref `theme`); o CSS já traz o default Vácuo
// pro primeiro paint, então a falha aqui só deixa o default.
void loadAndApplyTheme().catch((err) => console.warn('[floating] tema não carregou', err))
void document.fonts.load('400 13px "Schibsted Grotesk"')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FloatingApp />
  </React.StrictMode>,
)
