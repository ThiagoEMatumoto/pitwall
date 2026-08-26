import type { PanelTier } from './use-panel-tier'

// Regra ÚNICA de densidade dos controles da barra do composer, idêntica nos seis
// (Modelo, Esforço, Permissão, Voz, Resumir, Resumo auto):
//   wide   → rótulo completo + caret;
//   mid    → rótulo curto, sem caret;
//   narrow → só o ícone — e aí o valor PRECISA migrar pro title/aria-label, senão
//            o controle fica mudo pra quem usa leitor de tela.
export function pillDensity(tier: PanelTier) {
  return {
    pad: tier === 'wide' ? 'px-2' : 'px-1.5',
    showCaret: tier === 'wide',
    showLabel: tier !== 'narrow',
  }
}
