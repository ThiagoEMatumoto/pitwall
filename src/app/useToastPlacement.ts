import { useEffect, useState } from 'react'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'
import { useFeaturePanelStore } from '@/features/session-canvas/feature-panel-store'
import { useMotherDockStore } from '@/features/session-canvas/mother-dock'
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

// Modal grande do terminal do mapa (lift): a pilha não pode entrar nela.
function isLiftOpen(): boolean {
  return document.querySelector('[data-peek-lift]') !== null
}

function readFeaturePanelBox(): PeekBox | null {
  const el = document.querySelector<HTMLElement>('[data-feature-panel]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width === 0 ? null : { left: r.left, top: r.top, width: r.width, height: r.height }
}

// Painel da feature sobre o mapa: mede quando abre/troca, no resize e quando o
// dock da Equipe/Conversas muda de largura (o painel encosta nele: right =
// dockOverlay, sem evento de resize). Fora do mapa o painel não está na tela,
// mesmo com o store ainda "aberto".
const PANEL_SETTLE_MS = 300

function useFeaturePanelBox(onMap: boolean, dockWidth: number): PeekBox | null {
  const openId = useFeaturePanelStore((s) => s.openFeatureId)
  const on = onMap && !!openId
  const [box, setBox] = useState<PeekBox | null>(null)
  useEffect(() => {
    if (!on) {
      setBox(null)
      return
    }
    const measure = () => setBox(readFeaturePanelBox())
    const raf = requestAnimationFrame(measure)
    // A largura do dock anima: mede de novo quando assenta.
    const late = setTimeout(measure, PANEL_SETTLE_MS)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(late)
      window.removeEventListener('resize', measure)
    }
  }, [on, openId, dockWidth])
  return on ? box : null
}

function readMinimapBox(): PeekBox | null {
  const el = document.querySelector<HTMLElement>('[data-testid="session-map"] .react-flow__minimap')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.height === 0 ? null : { left: r.left, top: r.top, width: r.width, height: r.height }
}

// O minimapa monta junto com o ReactFlow (frame seguinte ao mapa aparecer) e não
// muda de tamanho sozinho: mede ao entrar no mapa, um pouco depois e no resize.
function useMinimapBox(): PeekBox | null {
  const mapVisible = useProjectsViewStore((s) => s.view === 'map')
  const area = useAppStore((s) => s.area)
  const on = mapVisible && area === 'projects'
  const [box, setBox] = useState<PeekBox | null>(null)
  useEffect(() => {
    if (!on) {
      setBox(null)
      return
    }
    const measure = () => setBox(readMinimapBox())
    const raf = requestAnimationFrame(measure)
    const late = setTimeout(measure, 400)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(late)
      window.removeEventListener('resize', measure)
    }
  }, [on])
  return on ? box : null
}

// Tamanho da janela, vivo em qualquer vista. Medido só junto do mapa/peek, ficava
// velho depois de maximizar fora deles e empurrava a pilha de toasts para fora da
// tela ("Desfazer" inalcançável).
function useWindowSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const measure = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  return size
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

// No mapa, a pilha não cobre o cartão da mãe (composer, "Espiar filhas") nem a
// coluna da mãe fixada. O cartão anda com o pan/zoom sem evento nenhum: relê a
// cada meio segundo, mas só enquanto há toast à vista (sem toast a posição da
// pilha não importa e o AppShell não re-renderiza a cada pan).
const MAP_OBSTACLE_POLL_MS = 500
const MAP_OBSTACLE_SELECTOR = '[data-variant="mother"], [data-testid="mother-dock"]'

// Mapa estreito (painel da mãe ou da feature aberto): todo cartão de sessão é
// obstáculo — a pilha cobria a filha que o usuário acabara de enquadrar.
const MAP_CARD_SELECTOR = '[data-testid="session-map"] .react-flow__node-session'
const MAP_BAR_SELECTOR = '[data-testid="map-top-bar"]'

interface Clip {
  left: number
  top: number
  right: number
  bottom: number
}

// Recorta no que está à vista: o cartão meio fora da tela (ou do mapa) só ocupa
// o pedaço visível.
function clippedBoxes(selector: string, clip: Clip): PeekBox[] {
  return [...document.querySelectorAll<HTMLElement>(selector)].flatMap((el) => {
    const r = el.getBoundingClientRect()
    const left = Math.max(clip.left, r.left)
    const top = Math.max(clip.top, r.top)
    const width = Math.min(clip.right, r.left + r.width) - left
    const height = Math.min(clip.bottom, r.top + r.height) - top
    return width <= 0 || height <= 0 ? [] : [{ left, top, width, height }]
  })
}

function readMapObstacles(narrow: boolean): PeekBox[] {
  const win = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  const boxes = clippedBoxes(MAP_OBSTACLE_SELECTOR, win)
  if (!narrow) return boxes
  const map = document.querySelector('[data-testid="session-map"]')?.getBoundingClientRect()
  const clip = map
    ? { left: map.left, top: map.top, right: map.left + map.width, bottom: map.top + map.height }
    : win
  return [...boxes, ...clippedBoxes(MAP_CARD_SELECTOR, clip)]
}

function readMapBar(): PeekBox | null {
  const r = document.querySelector<HTMLElement>(MAP_BAR_SELECTOR)?.getBoundingClientRect()
  return r && r.width > 0 && r.height > 0
    ? { left: r.left, top: r.top, width: r.width, height: r.height }
    : null
}

interface MapObstacles {
  boxes: PeekBox[]
  bar: PeekBox | null
}

const NO_OBSTACLES: MapObstacles = { boxes: [], bar: null }

function useMapObstacles(onMap: boolean, narrow: boolean): MapObstacles {
  const toastCount = useToastStore((s) => s.toasts.length)
  const [state, setState] = useState<MapObstacles>(NO_OBSTACLES)
  useEffect(() => {
    if (!onMap) {
      setState(NO_OBSTACLES)
      return
    }
    const measure = () => {
      // Avisos do main (IPC) não passam pelo toast-store: o card na pilha conta.
      const showing = toastCount > 0 || document.querySelector('[data-testid="toast-card"]')
      const boxes = showing ? readMapObstacles(narrow) : []
      const bar = showing && narrow ? readMapBar() : null
      setState((prev) =>
        sameBoxes(prev.boxes, boxes) && sameBoxes(prev.bar ? [prev.bar] : [], bar ? [bar] : [])
          ? prev
          : { boxes, bar },
      )
    }
    const raf = requestAnimationFrame(measure)
    const timer = setInterval(measure, MAP_OBSTACLE_POLL_MS)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(timer)
      window.removeEventListener('resize', measure)
    }
  }, [onMap, narrow, toastCount])
  return onMap ? state : NO_OBSTACLES
}

export function useToastPlacement(dockWidth: number): ToastPlacement {
  const minimap = useMinimapBox()
  const viewport = useWindowSize()
  const composers = useComposerBoxes()
  const mapView = useProjectsViewStore((s) => s.view === 'map')
  const inProjects = useAppStore((s) => s.area === 'projects')
  const onMap = mapView && inProjects
  const featurePanel = useFeaturePanelBox(onMap, dockWidth)
  const motherPanel = useMotherDockStore((s) => s.shownId !== null)
  const narrowMap = onMap && (motherPanel || !!featurePanel)
  const mapObstacles = useMapObstacles(onMap, narrowMap)
  const peekId = useCrewDockStore((s) => s.peekTarget?.id ?? null)
  const [peek, setPeek] = useState<PeekBox | null>(null)
  const [lift, setLift] = useState(false)

  useEffect(() => {
    if (!peekId) {
      setPeek(null)
      setLift(false)
      return
    }
    // O painel monta no mesmo commit que o peekId muda: mede no frame seguinte.
    const measure = () => {
      setPeek(readPeekBox())
      setLift(isLiftOpen())
    }
    // A modal também muda de tamanho sem a janela mudar (alça, duplo clique,
    // "Tamanho padrão"): observa a caixa dela.
    let ro: ResizeObserver | null = null
    const raf = requestAnimationFrame(() => {
      measure()
      const el = document.querySelector('[data-peek-mode]')
      if (el && typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(measure)
        ro.observe(el)
      }
    })
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [peekId])

  return toastStackPlacement({
    dockWidth,
    peek: peekId ? peek : null,
    viewportWidth: viewport.width,
    minimap,
    obstacles: [...composers, ...mapObstacles.boxes],
    viewportHeight: viewport.height,
    lift: !!peekId && lift,
    onMap,
    rightPanel: featurePanel,
    narrowMap,
    mapBar: mapObstacles.bar,
  })
}
