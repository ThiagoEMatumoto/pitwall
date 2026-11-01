import { useLayoutEffect, useState, type RefObject } from 'react'
import { CHAT_MIN_WIDTH, PANEL_MIN_WIDTH } from './artifactPanelStore'

// O painel lembrado por sessão vale para todo ChatView dela, inclusive os de
// coluna estreita (dock da mãe, Room, peek): ali ele esmagaria a conversa.
export function useSidePanelFits(ref: RefObject<HTMLElement | null>): boolean {
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setFits(el.clientWidth >= PANEL_MIN_WIDTH + CHAT_MIN_WIDTH)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return fits
}
