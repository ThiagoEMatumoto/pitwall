import { useEffect, useRef, useState } from 'react'

// Tier discreto de largura do painel — dirige tanto CSS (esconder texto) quanto
// troca de JSX (ícone-only vs label) no header e no rodapé do composer. Thresholds
// calibrados visualmente: >420px cabe tudo; 220-420px perde labels secundários;
// <220px só cabe ícone+status+ações essenciais.
export type PanelTier = 'wide' | 'mid' | 'narrow'

export type PanelTierThresholds = { wideMin: number; narrowMax: number }

// Defaults calibrados pro SessionHeader. Barras com mais controle que o header
// (o composer) passam os próprios limites em vez de herdar estes.
const DEFAULT_THRESHOLDS: PanelTierThresholds = { wideMin: 420, narrowMax: 220 }

export function panelTierFor(
  width: number,
  thresholds: PanelTierThresholds = DEFAULT_THRESHOLDS,
): PanelTier {
  if (width > thresholds.wideMin) return 'wide'
  if (width > thresholds.narrowMax) return 'mid'
  return 'narrow'
}

// Mede a largura REAL do elemento (painel dockview, não a janela) via
// ResizeObserver — mesmo padrão já usado em Terminal.tsx pro FitAddon do xterm.
// Cada painel dockview tem sua própria largura ao dividir a janela em splits, e
// só a largura real do elemento reflete isso corretamente.
export function usePanelTier<T extends HTMLElement>(thresholds?: PanelTierThresholds) {
  const ref = useRef<T>(null)
  const [tier, setTier] = useState<PanelTier>('wide')
  // Fica undefined até a primeira medição: quem consome a largura precisa
  // distinguir "ainda não medi" de "medi e deu pequeno".
  const [width, setWidth] = useState<number | undefined>(undefined)
  const { wideMin, narrowMax } = thresholds ?? DEFAULT_THRESHOLDS

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? el.getBoundingClientRect().width
      setWidth(measured)
      setTier(panelTierFor(measured, { wideMin, narrowMax }))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [wideMin, narrowMax])

  return { ref, tier, width }
}
