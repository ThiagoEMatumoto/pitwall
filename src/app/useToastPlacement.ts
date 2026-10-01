import { useEffect, useState } from 'react'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'
import { useAppStore } from '@/store/appStore'
import { useToastStore } from '@/features/notifications/toast-store'
import { toastStackPlacement, type PeekBox, type ToastPlacement } from './toast-placement'

// Caixa de layout do painel do peek (offset*, sem o transform da animação de
// entrada). O backdrop é fixed inset-0, então os offsets já são da janela.
function readPeekBox(): PeekBox | null {
  const el = document.querySelector<HTMLElement>('[data-peek-mode]')
  if (!el || el.offsetHeight === 0) return null
  return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
}

function readMinimapBox(): PeekBox | null {
  const el = document.querySelector<HTMLElement>('[data-testid="session-map"] .react-flow__minimap')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.height === 0 ? null : { left: r.left, top: r.top, width: r.width, height: r.height }
}

// O minimapa monta junto com o ReactFlow (frame seguinte ao mapa aparecer) e não
// muda de tamanho sozinho: mede ao entrar no mapa, um pouco depois e no resize.
function useMinimapBox(): { box: PeekBox | null; viewportHeight: number } {
  const mapVisible = useProjectsViewStore((s) => s.view === 'map')
  const area = useAppStore((s) => s.area)
  const on = mapVisible && area === 'projects'
  const [box, setBox] = useState<PeekBox | null>(null)
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)
  useEffect(() => {
    if (!on) {
      setBox(null)
      return
    }
    const measure = () => {
      setBox(readMinimapBox())
      setViewportHeight(window.innerHeight)
    }
    const raf = requestAnimationFrame(measure)
    const late = setTimeout(measure, 400)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(late)
      window.removeEventListener('resize', measure)
    }
  }, [on])
  return { box: on ? box : null, viewportHeight }
}

function readComposerBoxes(): PeekBox[] {
  return [...document.querySelectorAll<HTMLElement>('[data-composer-dock]')].flatMap((el) => {
    const r = el.getBoundingClientRect()
    return r.height === 0 || r.width === 0
      ? []
      : [{ left: r.left, top: r.top, width: r.width, height: r.height }]
  })
}

// Composer dock dos terminais visíveis. O dock muda com a aba ativa, o split e os
// anexos, e os eventos que viram toast chegam por IPC sem passar pelo toast-store:
// uma releitura barata por segundo (só re-renderiza quando a caixa muda).
const COMPOSER_POLL_MS = 1000

function sameBoxes(a: PeekBox[], b: PeekBox[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function useComposerBoxes(): PeekBox[] {
  const inProjects = useAppStore((s) => s.area === 'projects')
  const terminals = useProjectsViewStore((s) => s.view === 'terminals')
  const on = inProjects && terminals
  const toastCount = useToastStore((s) => s.toasts.length)
  const [boxes, setBoxes] = useState<PeekBox[]>([])
  useEffect(() => {
    if (!on) {
      setBoxes([])
      return
    }
    const measure = () => {
      const next = readComposerBoxes()
      setBoxes((prev) => (sameBoxes(prev, next) ? prev : next))
    }
    const raf = requestAnimationFrame(measure)
    const timer = setInterval(measure, COMPOSER_POLL_MS)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(timer)
      window.removeEventListener('resize', measure)
    }
  }, [on, toastCount])
  return on ? boxes : []
}

export function useToastPlacement(dockWidth: number): ToastPlacement {
  const minimap = useMinimapBox()
  const composers = useComposerBoxes()
  const peekId = useCrewDockStore((s) => s.peekTarget?.id ?? null)
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

  return toastStackPlacement({
    dockWidth,
    peek: peekId ? peek : null,
    viewportWidth,
    minimap: minimap.box,
    obstacles: composers,
    viewportHeight: minimap.viewportHeight,
  })
}
