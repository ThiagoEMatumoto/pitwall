import { useEffect, useState } from 'react'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { toastStackPlacement, type PeekBox, type ToastPlacement } from './toast-placement'

// Caixa de layout do painel do peek (offset*, sem o transform da animação de
// entrada). O backdrop é fixed inset-0, então os offsets já são da janela.
function readPeekBox(): PeekBox | null {
  const el = document.querySelector<HTMLElement>('[data-peek-mode]')
  if (!el || el.offsetHeight === 0) return null
  return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
}

export function useToastPlacement(dockWidth: number): ToastPlacement {
  const peekId = useCrewDockStore((s) => s.peekId)
  const [peek, setPeek] = useState<PeekBox | null>(null)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)

  useEffect(() => {
    if (!peekId) {
      setPeek(null)
      return
    }
    // O painel monta no mesmo commit que o peekId muda: mede no frame seguinte.
    const measure = () => {
      setPeek(readPeekBox())
      setViewportWidth(window.innerWidth)
    }
    const raf = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
    }
  }, [peekId])

  return toastStackPlacement({ dockWidth, peek: peekId ? peek : null, viewportWidth })
}
