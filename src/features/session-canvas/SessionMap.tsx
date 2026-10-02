import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Background,
  ControlButton,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Map as MapIcon, Maximize } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import './session-map.css'
import { useAppStore } from '@/store/appStore'
import { useSessionGraph } from '@/features/sessions/session-graph-store'
import { useAttentionQueue, useAttentionStore } from '@/features/session-switcher/useAttentionQueue'
import { sendToApi } from '@/lib/ipc'
import { useMapSessionIds } from '@/features/session-switcher/useGlobalSessions'
import { NewSessionFlow } from '@/features/sessions/NewSessionFlow'
import { BatonDialog } from '@/features/sessions/BatonDialog'
import { GLOBAL_CANVAS_SCOPE, type CanvasPositionInput } from '../../../shared/types/canvas'
import {
  featureLaneId,
  graphToFlow,
  layoutRects,
  homeRepoLaneId,
  lastSeenAt,
  NOTE_H,
  NOTE_W,
  noteNodeId,
  positionKey,
  sessionNodeId,
  type LaneData,
  type MapEdge,
  type MapInput,
  type MapNode,
  type SessionCardData,
} from './graph-to-flow'
import { useCanvasState, useCanvasStateStore } from './canvas-state-store'
import { useProjectsViewStore } from './projects-view-store'
import { useMapCommands } from './useMapCommands'
import { MapActionsContext, type MapActions } from './map-context'
import {
  MapContextMenu,
  MapTopBar,
  SelectionToolbar,
  actionsFor,
  toolbarPositionFor,
} from './MapChrome'
import { FeaturePanel } from './FeaturePanel'
import { DelegateDialog } from './DelegateDialog'
import { SessionCardNode } from './SessionCardNode'
import { LaneGroupNode } from './LaneGroupNode'
import { UserGroupNode } from './UserGroupNode'
import { NoteNode } from './NoteNode'
import { SessionEdge } from './SessionEdge'
import { reuseUnchanged } from './reuse-unchanged'
import { useCardHeightStore } from './card-height-store'
import { MapFocusContext, focusFor } from './map-focus'
import {
  MIN_READABLE_ZOOM,
  OVERVIEW_MIN_CARDS,
  actualSizeViewport,
  boundsOf,
  noteSlot,
  offscreenCards,
  overflowEdges,
  minimapSize,
  PANEL_MIN_ZOOM,
  planFit,
  wrapRowWidth,
  type Insets,
  type OverflowEdges,
} from './map-fit'
import type { Rect } from './edge-anchor'
import { isCompactZoom, MAX_COMPACT_ZOOM } from './card-display'
import { doubleClickOpensTerminal, viewLineage, viewOf } from './card-view'
import { useCardViewStore } from './card-view-store'
import { sameIdList, tailSubscription, tailText, type TailCandidate } from './card-tail'
import { advanceWorkingClocks, indicatorFor } from './card-indicator'
import { MapLiveContext, useMinuteClock, type MapLive } from './map-live'
import { MapStatusCounters } from './MapStatusCounters'
import { usePendingAsks } from '@/features/handoffs/ConversationsTab'
import { useCrewDockWidth } from '@/features/handoffs/CrewDock'
import { RAIL_WIDTH, useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useFeaturePanelStore } from './feature-panel-store'
import { MapFeatureMovePicker } from './MapChrome'

const nodeTypes = {
  session: SessionCardNode,
  lane: LaneGroupNode,
  userGroup: UserGroupNode,
  note: NoteNode,
}
const edgeTypes = { session: SessionEdge }
const defaultEdgeOptions = { markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 } }

const MINIMAP_COLOR: Record<string, string> = {
  session: 'var(--color-accent)',
  note: 'var(--color-warning)',
  userGroup: 'color-mix(in srgb, var(--color-violet) 35%, transparent)',
  lane: 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)',
}

function sameIds(a: { id: string }[], b: { id: string }[]): boolean {
  return a.length === b.length && a.every((n, i) => n.id === b[i].id)
}

// Abaixo disto o mapa inteiro cabe na tela no piso legível e o minimapa só
// cobriria cartões. Com 7+ o enquadrar desce para a visão geral e o minimapa
// diz onde está o resto.
const MINIMAP_MIN_CARDS = OVERVIEW_MIN_CARDS
const INSET_GAP = 8

// O que flutua por cima do mapa, medido no DOM: barra do topo, controles de zoom
// (coluna da esquerda) e minimapa (faixa da base), relativos ao contêiner.
function overlayInsets(container: HTMLElement): Insets & { dock: number } {
  const box = container.getBoundingClientRect()
  const rect = (sel: string) => {
    const r = container.querySelector<HTMLElement>(sel)?.getBoundingClientRect()
    return r && r.height > 0 ? r : null
  }
  const bar = rect('[data-testid="map-top-bar"]')
  const controls = rect('.react-flow__controls')
  const minimap = rect('.react-flow__minimap')
  // Equipe/Conversas aberta flutua sobre a borda direita do mapa (CrewDock).
  const dock = document
    .querySelector<HTMLElement>('[data-testid="crew-dock"][data-overlay]')
    ?.getBoundingClientRect()
  const dockOver = dock && dock.width > 0 && dock.left < box.right ? box.right - dock.left : 0
  // Painel da feature (só um dos dois fica aberto, mas mede ambos).
  const panel = rect('[data-testid="feature-panel"]')
  const panelOver = panel && panel.left < box.right ? box.right - panel.left : 0
  const rightOver = Math.max(dockOver, panelOver)
  return {
    // Quanto do inset direito é do dock (recolhível pelo enquadrar).
    dock: dockOver > panelOver ? dockOver - panelOver : 0,
    right: rightOver ? rightOver + INSET_GAP : 0,
    top: bar ? bar.bottom - box.top + INSET_GAP : 0,
    left: controls ? controls.right - box.left + INSET_GAP : 0,
    bottom: minimap ? box.bottom - minimap.top + INSET_GAP : 0,
  }
}

// Máscara na borda da área livre do lado em que há cartões fora da vista. Neutra
// (para o fundo, sem matiz): roxa, não se distinguia da sombra residual do dock.
const EDGE_FADE = (dir: string) =>
  `linear-gradient(to ${dir}, color-mix(in srgb, var(--color-bg) 85%, transparent), transparent)`
const HINT_STYLE: Record<keyof OverflowEdges, CSSProperties> = {
  top: { top: 0, left: 0, right: 0, height: 28, background: EDGE_FADE('bottom') },
  bottom: { bottom: 0, left: 0, right: 0, height: 28, background: EDGE_FADE('top') },
  left: { top: 0, bottom: 0, left: 0, width: 28, background: EDGE_FADE('right') },
  right: { top: 0, bottom: 0, right: 0, width: 28, background: EDGE_FADE('left') },
}

const SIDE_ARROW = { left: '←', right: '→', top: '↑', bottom: '↓' } as const

function MapOverflowHints({
  containerRef,
  onFit,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  onFit: () => void
}) {
  const transform = useStore((s) => s.transform)
  const nodeLookup = useStore((s) => s.nodeLookup)
  // Os insets vêm do DOM (dock, painel, minimapa). Abrir/recolher o dock não
  // move a câmera: sem re-medir, a sombra e o "N fora da vista" ficavam com o
  // dock que já tinha saído (a faixa roxa no meio do mapa e o contador errado).
  const dockWidth = useCrewDockWidth()
  const panelId = useFeaturePanelStore((s) => s.openFeatureId)
  const [, remeasure] = useState(0)
  useEffect(() => {
    const raf = requestAnimationFrame(() => remeasure((n) => n + 1))
    return () => cancelAnimationFrame(raf)
  }, [dockWidth, panelId])
  useEffect(() => {
    const target = containerRef.current
    if (!target || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => remeasure((n) => n + 1))
    ro.observe(target)
    return () => ro.disconnect()
  }, [containerRef])
  const el = containerRef.current
  if (!el) return null
  const tops: Rect[] = []
  const cards: Rect[] = []
  for (const n of nodeLookup.values()) {
    if (n.hidden) continue
    const w = n.measured.width ?? n.width ?? 0
    const h = n.measured.height ?? n.height ?? 0
    if (!w || !h) continue
    const r = { x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w, h }
    if (!n.parentId) tops.push(r)
    if (n.type === 'session') cards.push(r)
  }
  const insets = overlayInsets(el)
  const edges = overflowEdges(
    boundsOf(tops),
    { x: transform[0], y: transform[1], zoom: transform[2] },
    { w: el.clientWidth, h: el.clientHeight },
    insets,
  )
  const off = offscreenCards(
    cards,
    { x: transform[0], y: transform[1], zoom: transform[2] },
    { w: el.clientWidth, h: el.clientHeight },
    insets,
  )
  const offset: Record<keyof OverflowEdges, CSSProperties> = {
    top: { top: Math.max(0, (insets.top ?? 0) - INSET_GAP) },
    bottom: {},
    left: {},
    right: { right: Math.max(0, (insets.right ?? 0) - INSET_GAP) },
  }
  return (
    <>
      {(Object.keys(HINT_STYLE) as Array<keyof OverflowEdges>)
        .filter((k) => edges[k] && off.sides[k] > 0)
        .map((k) => (
          <div
            key={k}
            data-testid={`map-overflow-${k}`}
            aria-hidden
            className="pointer-events-none absolute z-20"
            style={{ ...HINT_STYLE[k], ...offset[k] }}
          />
        ))}
      {off.count > 0 && (
        <button
          type="button"
          data-testid="map-offscreen-count"
          data-side={off.side}
          onClick={onFit}
          title="Enquadrar tudo"
          className="absolute z-20 -translate-x-1/2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-0.5 text-[11px] text-[var(--color-text-dim)] shadow transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
          style={{
            left: `calc(${insets.left ?? 0}px + (100% - ${(insets.left ?? 0) + (insets.right ?? 0)}px) / 2)`,
            top: (insets.top ?? 0) + 4,
          }}
        >
          {off.count} {off.count === 1 ? 'cartão' : 'cartões'} fora da vista {SIDE_ARROW[off.side ?? 'right']}
        </button>
      )}
    </>
  )
}

// Tecla solta (sem modificador) só vale fora de campo de texto: nota, propósito
// e nome de grupo editam dentro do mapa.
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function SessionMapInner() {
  const scopeMode = useProjectsViewStore((s) => s.scopeMode)
  const setScopeMode = useProjectsViewStore((s) => s.setScopeMode)
  const [expandedMothers, setExpandedMothers] = useState<ReadonlySet<string>>(new Set())
  const [minimapCollapsed, setMinimapCollapsed] = useState(false)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const scope = scopeMode === 'project' && activeProjectId ? activeProjectId : GLOBAL_CANVAS_SCOPE
  const graph = useSessionGraph()
  const inUse = useMapSessionIds()
  // Painel Equipe/Conversas aberto sobre o mapa: a barra do topo não põe a pílula
  // de contadores embaixo dele (o rail segue no layout, fora do mapa).
  const dockOverlay = Math.max(0, useCrewDockWidth() - RAIL_WIDTH)
  const canvas = useCanvasState(scope)
  const savePositions = useCanvasStateStore((s) => s.savePositions)
  const flowApi = useReactFlow<MapNode, MapEdge>()
  const views = useCardViewStore((s) => s.views)
  const asks = usePendingAsks()
  const cardHeights = useCardHeightStore((s) => s.heights)
  // Densidade do zoom (resumo/blocos): a raia reserva a altura que o cartão desenha.
  const compact = useStore((s) => isCompactZoom(s.transform[2]))
  // Largura da área do mapa: os cards quebram em linhas (wrapRowWidth).
  const [mapWidth, setMapWidth] = useState(0)
  const rowWidth = mapWidth > 0 ? wrapRowWidth(mapWidth) : undefined

  // Estado de exibição dos cartões: lido do banco uma vez por escopo.
  useEffect(() => {
    if (canvas) useCardViewStore.getState().hydrate(scope, canvas.views)
  }, [canvas, scope])

  // Linhagem (bastão, ou a mesma conversa numa PTY nova): a sucessora herda o
  // recolhido/aberto. Depois do hydrate — antes dele o store ainda é de outro escopo.
  const hydrated = useCardViewStore((s) => s.scope === scope)
  useEffect(() => {
    if (!hydrated) return
    const lineage = viewLineage(graph.nodes, graph.edges, inUse)
    if (lineage.length) useCardViewStore.getState().inherit(lineage)
  }, [hydrated, graph, inUse])

  const input: MapInput = useMemo(
    () => ({
      graph,
      scope,
      positions: canvas?.positions ?? [],
      notes: canvas?.notes ?? [],
      groups: canvas?.groups ?? [],
      inUse,
      expandedMothers,
      views,
      cardHeights,
      asks,
      rowWidth,
      compact,
    }),
    [graph, scope, canvas, inUse, expandedMothers, views, cardHeights, asks, rowWidth, compact],
  )
  const inputRef = useRef(input)
  inputRef.current = input
  const flow = useMemo(() => graphToFlow(input), [input])
  const cmd = useMapCommands(scope, () => inputRef.current)

  const [nodes, setNodes, onNodesChange] = useNodesState<MapNode>([])
  const dragging = useRef(false)
  // Seleção sobrevive aos pushes do grafo (um por tick de atividade): sem isto, a
  // toolbar contextual sumiria a cada ~300ms com uma sessão trabalhando.
  useEffect(() => {
    if (dragging.current) return
    setNodes((prev) => reuseUnchanged(flow.nodes, prev))
  }, [flow.nodes, setNodes])
  const edgesRef = useRef<MapEdge[]>([])
  const baseEdges = useMemo(() => {
    edgesRef.current = reuseUnchanged(flow.edges, edgesRef.current)
    return edgesRef.current
  }, [flow.edges])

  // Foco: o cartão selecionado esmaece o resto; o hover só revela fios e rótulos.
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const selected = nodes.filter((n) => n.selected)
  const selectedCard = selected.length === 1 && selected[0].type === 'session' ? selected[0] : null
  const focusNode =
    selectedCard ??
    (hoveredId ? nodes.find((n) => n.id === hoveredId && n.type === 'session') : undefined)
  // A lane de repo em que o cartão mora (o mesmo repo pode estar em vários cards).
  const focusRepo = focusNode?.parentId?.startsWith('lane:') ? focusNode.parentId : null
  const focus = useMemo(
    () =>
      focusFor(
        focusNode?.id ?? null,
        focusRepo,
        baseEdges,
        !!selectedCard,
      ),
    [focusNode?.id, focusRepo, baseEdges, selectedCard],
  )
  // Só no foco: feature sempre, repoDep com o mapa cheio, e o leque recolhido de
  // uma mãe com muitas filhas (a pergunta de uma filha aparece sempre).
  const edges = useMemo(
    () =>
      baseEdges.map((e) => {
        const onlyInFocus = e.data?.aggregate || (e.data?.fanned && !e.data.alert)
        return onlyInFocus && !focus.edges.has(e.id) ? { ...e, hidden: true } : e
      }),
    [baseEdges, focus],
  )
  const hiddenEdges = edges.filter((e) => e.hidden).length

  // O mapa cobre o dockview montado: o foco sai do xterm escondido (Ctrl+Shift+G
  // o deixaria recebendo as teclas às cegas).
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setMapWidth(el.clientWidth))
    ro.observe(el)
    setMapWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  useEffect(() => containerRef.current?.focus({ preventScroll: true }), [])

  // Relógios do "trabalhando há" e itens da fila de atenção, por sessão.
  const now = useMinuteClock()
  const clocksRef = useRef<Map<string, number | null>>(new Map())
  const workingSince = useMemo(() => {
    clocksRef.current = advanceWorkingClocks(clocksRef.current, graph.nodes, Date.now())
    return clocksRef.current
  }, [graph.nodes])
  const queue = useAttentionQueue()
  const live: MapLive = useMemo(() => {
    const attention = new Map(
      queue.filter((i) => i.sessionId).map((i) => [i.sessionId!, i] as const),
    )
    return { now, workingSince, attention }
  }, [now, workingSince, queue])

  const sessionCount = flow.nodes.filter((n) => n.type === 'session').length
  const sessionNodes = useMemo(
    () =>
      flow.nodes.filter((n) => n.type === 'session').map((n) => (n.data as SessionCardData).node),
    [flow.nodes],
  )
  const showMinimap = sessionCount >= MINIMAP_MIN_CARDS && !minimapCollapsed
  const contentBounds = useMemo(
    () =>
      boundsOf(
        flow.nodes
          .filter((n) => !n.parentId)
          .map((n) => ({ x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 })),
      ),
    [flow.nodes],
  )

  const rectOf = useCallback(
    (id: string): Rect | null => {
      const n = flowApi.getInternalNode(id)
      if (!n) return null
      const p = n.internals.positionAbsolute
      return {
        x: p.x,
        y: p.y,
        w: n.measured.width ?? n.width ?? 0,
        h: n.measured.height ?? n.height ?? 0,
      }
    },
    [flowApi],
  )
  const topAncestorOf = useCallback(
    (id: string): string => {
      let cur = flowApi.getNode(id)
      while (cur?.parentId) cur = flowApi.getNode(cur.parentId)
      return cur?.id ?? id
    },
    [flowApi],
  )
  const visibleBounds = useCallback(() => {
    const top = flowApi
      .getNodes()
      .filter((n) => !n.parentId)
      .map((n) => rectOf(n.id))
    return boundsOf(top.filter((r): r is Rect => r !== null))
  }, [flowApi, rectOf])

  // Enquadramento legível (map-fit.ts): o inicial e o botão de enquadrar. O
  // fitView do xyflow encaixava tudo num zoom ~0.3 em que nada se lia.
  const fitReadable = useCallback((opts?: { priorityId?: string | null; keepDock?: boolean }) => {
    const el = containerRef.current
    if (!el) return
    const cards = flowApi
      .getNodes()
      .filter((n) => n.type === 'session')
      .map((n) => (n.data as SessionCardData).node)
    // Prioridade: o MESMO tom que o cartão e os contadores mostram (precisa de
    // você). Sem ninguém, nenhuma: puxar pela "mais recente" empurrava as lanes
    // da esquerda (que também trabalhavam) pra fora da tela.
    const live = new Map(useAppStore.getState().liveSessions.map((s) => [s.id, s]))
    const tails = useCardViewStore.getState().tails
    const needsYou = cards.filter((n) => {
      const tail = tails[n.sessionId]
      return (
        indicatorFor(n, live.get(n.sessionId), null, tail ? tailText(tail.lines) : null).tone ===
        'needs-you'
      )
    })
    // Sem ninguém pedindo você: o card da feature da sessão mais recente (a frente
    // é a unidade do mapa); sem feature nenhuma, o card do projeto dela.
    const byRecent = [...cards].sort((a, b) => lastSeenAt(b) - lastSeenAt(a))
    const recent = byRecent.find((n) => n.featureId) ?? byRecent[0]
    const recentCard = recent ? topAncestorOf(sessionNodeId(recent.sessionId)) : null
    // Painel aberto: o card da feature dele (não o da sessão mais recente).
    const focusCard = opts?.priorityId ?? recentCard
    const insets = overlayInsets(el)
    // Planeja sobre o layout de cada densidade (puro), não sobre o DOM: o zoom
    // escolhido decide a densidade, e ela muda o tamanho das raias.
    const planOn = (compact: boolean) => {
      const { rects, tops } = layoutRects(graphToFlow({ ...inputRef.current, compact }).nodes)
      const priority =
        boundsOf(
          needsYou
            .map((n) => rects.get(sessionNodeId(n.sessionId)) ?? null)
            .filter((r): r is Rect => r !== null),
        ) ?? (focusCard ? (rects.get(focusCard) ?? null) : null)
      return planFit({
        visible: boundsOf(tops),
        priority,
        view: { w: el.clientWidth, h: el.clientHeight },
        insets,
        // keepDock: o enquadrar automático de quando o dock abre não pode fechá-lo.
        dockInset: opts?.keepDock ? 0 : insets.dock,
        cardCount: cards.length,
        needsYou: needsYou.length > 0,
        // No resumo não passa do degrau que reabriria os cartões.
        maxZoom: compact ? MAX_COMPACT_ZOOM : undefined,
        priorityFloor: opts?.priorityId ? PANEL_MIN_ZOOM : undefined,
      })
    }
    const full = planOn(false)
    const plan = full && !isCompactZoom(full.viewport.zoom) ? full : (planOn(true) ?? full)
    if (!plan) return
    if (plan.collapseDock) useCrewDockStore.getState().collapse()
    void flowApi.setViewport(plan.viewport, {
      duration: opts?.keepDock && !reducedMotion() ? 200 : 0,
    })
  }, [flowApi, topAncestorOf])

  const actualSize = useCallback(() => {
    const el = containerRef.current
    const viewport = el ? actualSizeViewport(visibleBounds(), overlayInsets(el)) : null
    if (viewport) void flowApi.setViewport(viewport, { duration: reducedMotion() ? 0 : 200 })
  }, [flowApi, visibleBounds])

  // Nota solta do botão "Nota": ao lado da seleção (o card de topo dela) ou, sem
  // seleção, do 1º card de feature.
  const looseNoteSlot = useCallback(() => {
    const all = flowApi.getNodes()
    const sel = all.find((n) => n.selected)
    const anchorId = sel
      ? topAncestorOf(sel.id)
      : (all.find((n) => !n.parentId && n.id.startsWith('lane:f:')) ?? all.find((n) => !n.parentId))?.id
    const anchor = anchorId ? rectOf(anchorId) : null
    if (!anchor) return null
    const obstacles = all
      .filter((n) => !n.parentId)
      .map((n) => rectOf(n.id))
      .filter((r): r is Rect => r !== null)
    return noteSlot(anchor, obstacles, { w: NOTE_W, h: NOTE_H })
  }, [flowApi, rectOf, topAncestorOf])

  // Centraliza um cartão pelo tamanho que o layout deu a ele (o medido pode estar
  // um frame atrasado logo depois de o cartão crescer).
  const centerOn = useCallback(
    (sessionId: string, zoom: number) => {
      const id = sessionNodeId(sessionId)
      const internal = flowApi.getInternalNode(id)
      const node = flowApi.getNode(id)
      if (!internal || !node) return
      const abs = internal.internals.positionAbsolute
      void flowApi.setCenter(abs.x + (node.width ?? 0) / 2, abs.y + (node.height ?? 0) / 2, {
        zoom,
        duration: reducedMotion() ? 0 : 300,
      })
    },
    [flowApi],
  )

  // Nota nova nasce acima das lanes (posição padrão) — muitas vezes fora da tela.
  // Ao entrar em edição, traz para a vista se não estiver nela; visível, não mexe.
  const editingNoteId = cmd.editingNoteId
  const revealedNote = useRef<string | null>(null)
  useEffect(() => {
    if (!editingNoteId || revealedNote.current === editingNoteId) return
    const internal = flowApi.getInternalNode(noteNodeId(editingNoteId))
    const box = containerRef.current?.getBoundingClientRect()
    if (!internal || !box) return
    revealedNote.current = editingNoteId
    const abs = internal.internals.positionAbsolute
    const w = internal.measured.width ?? internal.width ?? 0
    const h = internal.measured.height ?? internal.height ?? 0
    const tl = flowApi.flowToScreenPosition(abs)
    const br = flowApi.flowToScreenPosition({ x: abs.x + w, y: abs.y + h })
    const inView =
      tl.x >= box.left && tl.y >= box.top && br.x <= box.right && br.y <= box.bottom
    if (inView) return
    void flowApi.setCenter(abs.x + w / 2, abs.y + h / 2, {
      zoom: flowApi.getZoom(),
      duration: reducedMotion() ? 0 : 200,
    })
  }, [editingNoteId, nodes, flowApi])

  const liveSessions = useAppStore((s) => s.liveSessions)

  // Sessão nova criada com o mapa na frente (sem aba): abre na modal de terminal
  // quando a PTY e o nó existirem.
  const pendingTerminal = useCardViewStore((s) => s.pendingTerminal)
  const interact = cmd.interact
  useEffect(() => {
    if (!pendingTerminal) return
    const alive = liveSessions.some((x) => x.id === pendingTerminal && x.status !== 'ended')
    const onMap = nodes.some((n) => n.id === sessionNodeId(pendingTerminal))
    if (!alive || !onMap) return
    useCardViewStore.getState().clearPendingTerminal()
    interact(pendingTerminal)
  }, [pendingTerminal, liveSessions, nodes, interact])

  // Saída ao vivo: assina só os cartões ABERTOS e visíveis (o main empurra com
  // throttle e só quando muda). Recalcula ao fim de cada pan/zoom e quando o
  // conjunto de cartões ou o estado deles muda.
  const subscribed = useRef<string[]>([])
  const resubscribe = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const vp = flowApi.getViewport()
    const views = useCardViewStore.getState().views
    const cards: TailCandidate[] = []
    for (const n of flowApi.getNodes()) {
      if (n.type !== 'session') continue
      const internal = flowApi.getInternalNode(n.id)
      if (!internal) continue
      const sessionId = n.id.slice(2)
      const abs = internal.internals.positionAbsolute
      cards.push({
        sessionId,
        view: viewOf(views, sessionId),
        x: abs.x,
        y: abs.y,
        w: n.width ?? 0,
        h: n.height ?? 0,
      })
    }
    const ids = tailSubscription(cards, {
      ...vp,
      width: el.clientWidth,
      height: el.clientHeight,
    })
    if (sameIdList(ids, subscribed.current)) return
    subscribed.current = ids
    sendToApi
      .subscribeTail(ids)
      .catch((err) => console.error('[session-canvas] falha ao assinar a saída ao vivo:', err))
  }, [flowApi])
  useEffect(() => {
    const raf = requestAnimationFrame(resubscribe)
    return () => cancelAnimationFrame(raf)
  }, [nodes, resubscribe])
  useEffect(() => {
    const off = sendToApi.onTail((u) => useCardViewStore.getState().setTail(u))
    return () => {
      off()
      subscribed.current = []
      void sendToApi.subscribeTail([]).catch(() => undefined)
    }
  }, [])

  // Refeito ao trocar o escopo.
  const nodesInitialized = useNodesInitialized()
  const fittedKey = useRef<string | null>(null)
  // Cruzar para 7+ cartões troca o piso (visão geral): reenquadra uma vez.
  const fitKey = `${scope}:${sessionCount >= OVERVIEW_MIN_CARDS ? 'overview' : 'readable'}`
  useEffect(() => {
    if (!nodesInitialized || nodes.length === 0 || fittedKey.current === fitKey) return
    // Trocar o escopo muda o flow num render e os nós do estado no seguinte (o
    // setNodes do efeito acima): sem esperar, o fit enquadrava o conjunto anterior.
    if (!sameIds(nodes, flow.nodes)) return
    fittedKey.current = fitKey
    // O minimapa entra/sai junto com o conjunto: mede os insets no frame seguinte.
    requestAnimationFrame(() => fitReadable())
  }, [nodesInitialized, nodes, flow.nodes, fitKey, fitReadable])

  // Abrir o painel da feature: reenquadra com ele descontado (2 frames: o painel
  // monta e só então tem largura no DOM).
  const panelFeatureId = useFeaturePanelStore((s) => s.openFeatureId)
  useEffect(() => {
    if (!panelFeatureId) return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => fitReadable({ priorityId: featureLaneId(panelFeatureId) }))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [panelFeatureId, fitReadable])

  // Abrir a Equipe/Conversas sobre o mapa: se o dock passa a cobrir um cartão
  // (mais de 30% dele), reenquadra sem fechá-lo. Antes o cartão ficava meio
  // escondido e só o "Enquadrar" manual o trazia de volta.
  const prevDock = useRef(dockOverlay)
  useEffect(() => {
    const opened = dockOverlay > prevDock.current
    prevDock.current = dockOverlay
    const el = containerRef.current
    if (!opened || !el) return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const cards = flowApi
          .getNodes()
          .filter((n) => n.type === 'session' && !n.hidden)
          .map((n) => rectOf(n.id))
          .filter((r): r is Rect => r !== null)
        const { x, y, zoom } = flowApi.getViewport()
        const insets = overlayInsets(el)
        const view = { w: el.clientWidth, h: el.clientHeight }
        const covered = offscreenCards(cards, { x, y, zoom }, view, insets).count
        const before = offscreenCards(cards, { x, y, zoom }, view, {
          ...insets,
          right: Math.max(0, (insets.right ?? 0) - insets.dock),
        }).count
        if (covered > before) fitReadable({ keepDock: true })
      })
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [dockOverlay, flowApi, rectOf, fitReadable])

  const [menu, setMenu] = useState<{ x: number; y: number; flowId: string } | null>(null)
  const groups = canvas?.groups ?? []
  const memberCounts = useMemo(() => {
    const out = new Map<string, number>()
    for (const n of graph.nodes) if (n.groupId) out.set(n.groupId, (out.get(n.groupId) ?? 0) + 1)
    return out
  }, [graph.nodes])

  const actions: MapActions = useMemo(
    () => ({
      editingPurposeId: cmd.editingPurposeId,
      startEditPurpose: cmd.startEditPurpose,
      savePurpose: cmd.savePurpose,
      cancelEdit: cmd.cancelEdit,
      summarizingIds: cmd.summarizingIds,
      summarize: cmd.summarize,
      editingNoteId: cmd.editingNoteId,
      startEditNote: cmd.startEditNote,
      saveNote: cmd.saveNote,
      renamingGroupId: cmd.renamingGroupId,
      startRenameGroup: cmd.startRenameGroup,
      renameGroup: cmd.renameGroup,
      openContextMenu: (e, flowId) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY, flowId })
      },
      peek: cmd.peek,
      newSession: cmd.openNewSession,
      toggleFan: (sessionId) => setExpandedMothers((prev) => toggled(prev, sessionId)),
      toggleView: (sessionId) => useCardViewStore.getState().toggle(sessionId),
      interact: cmd.interact,
      centerOn: (sessionId) => centerOn(sessionId, Math.max(flowApi.getZoom(), MIN_READABLE_ZOOM)),
    }),
    [cmd, centerOn, flowApi],
  )

  // Alt+A com o mapa visível: centraliza o cartão da sessão que pede atenção.
  const flashNonce = useAttentionStore((s) => s.flash?.nonce)
  useEffect(() => {
    const item = useAttentionStore.getState().flash?.item
    if (!flashNonce || !item?.sessionId) return
    centerOn(item.sessionId, Math.max(flowApi.getZoom(), 0.9))
  }, [flashNonce, flowApi, centerOn])

  const absOf = useCallback(
    (id: string) => flowApi.getInternalNode(id)?.internals.positionAbsolute ?? null,
    [flowApi],
  )

  // Soltar um cartão decide o pai: dentro de um grupo do usuário grava o
  // group_id; fora de qualquer grupo volta pra lane do repo dele. A posição é
  // salva RELATIVA ao pai novo, antes da troca de pai chegar pelo grafo.
  const onNodeDragStop = useCallback(
    (_e: MouseEvent | TouchEvent, dragged: MapNode) => {
      dragging.current = false
      const moved = flowApi.getNodes().filter((n) => n.selected || n.id === dragged.id)
      const items: CanvasPositionInput[] = []
      for (const node of moved) {
        const key = positionKey(node.id)
        if (!key) continue
        if (node.type !== 'session') {
          items.push({ ...key, x: node.position.x, y: node.position.y })
          continue
        }
        const session = (node.data as SessionCardData).node
        const abs = absOf(node.id)
        const hit = flowApi
          .getIntersectingNodes(node)
          .find((n) => n.type === 'userGroup' && n.id !== node.id)
        const newParent =
          hit?.id ??
          (node.parentId?.startsWith('g:')
            ? homeRepoLaneId(inputRef.current.graph, session.sessionId)
            : node.parentId)
        const parentAbs = newParent ? absOf(newParent) : null
        if (node.parentId?.startsWith('g:') && !hit && !parentAbs) {
          // A lane do repo não existe (a sessão era a única dele): sai do grupo sem
          // posição, e o layout a põe no próximo slot livre da lane que volta.
          void cmd.moveToGroup(session.sessionId, null)
          continue
        }
        if (abs && parentAbs && newParent !== node.parentId) {
          items.push({
            ...key,
            x: Math.max(0, abs.x - parentAbs.x),
            y: Math.max(30, abs.y - parentAbs.y),
          })
          const groupId = hit ? hit.id.slice(2) : null
          if (groupId !== session.groupId) void cmd.moveToGroup(session.sessionId, groupId)
        } else {
          // Coordenada relativa negativa não faz o contêiner crescer pra trás.
          items.push({ ...key, x: Math.max(0, node.position.x), y: Math.max(30, node.position.y) })
        }
      }
      if (items.length) void savePositions(scope, items)
    },
    [flowApi, absOf, cmd, savePositions, scope],
  )

  const targetRepoOf = useCallback(
    (targetId: string | null): { repoId: string; label: string } | null => {
      const target = targetId ? flowApi.getNode(targetId) : undefined
      if (target?.type === 'lane') {
        const lane = target.data as LaneData
        return lane.level === 'repo' && lane.repoId
          ? { repoId: lane.repoId, label: lane.label }
          : null
      }
      if (target?.type === 'session') {
        const s = (target.data as SessionCardData).node
        return s.repoId ? { repoId: s.repoId, label: s.repoLabel ?? s.repoId } : null
      }
      return null
    },
    [flowApi],
  )

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const source = flowApi.getNode(c.source)
      if (source?.type !== 'session') return false
      const target = targetRepoOf(c.target)
      return !!target && target.repoId !== (source.data as SessionCardData).node.repoId
    },
    [flowApi, targetRepoOf],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (!isValidConnection(c)) return
      const mother = (flowApi.getNode(c.source)!.data as SessionCardData).node
      const target = targetRepoOf(c.target)!
      cmd.delegateTo({
        motherSessionId: mother.sessionId,
        motherTitle: mother.title,
        targetRepoId: target.repoId,
        targetRepoLabel: target.label,
      })
    },
    [flowApi, isValidConnection, targetRepoOf, cmd],
  )

  const selectionActions =
    selected.length === 1 ? actionsFor(selected[0], cmd, groups, memberCounts) : []
  const menuNode = menu ? nodes.find((n) => n.id === menu.flowId) : undefined
  const minimapColor = useCallback(
    (n: Node) => MINIMAP_COLOR[n.type ?? ''] ?? 'var(--color-border)',
    [],
  )

  return (
    <MapActionsContext.Provider value={actions}>
      <MapLiveContext.Provider value={live}>
        <MapFocusContext.Provider value={focus}>
          <div
            ref={containerRef}
            tabIndex={-1}
            className="session-map relative h-full w-full outline-none"
            data-testid="session-map"
            onKeyDown={(e) => {
              if (e.ctrlKey || e.metaKey || e.altKey) return
              if (e.repeat || isTyping(e.target)) return
              const selectedSession = selectedCard
                ? (selectedCard.data as SessionCardData).node
                : null
              // Enter com o cartão selecionado: o terminal na modal.
              if (e.key === 'Enter' && selectedSession && selectedSession.status !== 'ended') {
                e.preventDefault()
                cmd.interact(selectedSession.sessionId)
                return
              }
              // N: nova sessão — no repo do cartão selecionado, se houver. Ctrl+N
              // (session.new) segue global; aqui é só a letra, com o mapa focado.
              if (e.key.toLowerCase() !== 'n') return
              e.preventDefault()
              cmd.openNewSession(selectedSession?.repoId ?? null)
            }}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              defaultEdgeOptions={defaultEdgeOptions}
              onNodesChange={onNodesChange}
              onNodeDragStart={() => {
                dragging.current = true
              }}
              onNodeDragStop={onNodeDragStop}
              onNodeClick={(_e, n) => {
                // Cartão aberto já é a vista: o clique só seleciona (Enter → terminal).
                // Recolhido, o clique espia a conversa como antes.
                if (n.type !== 'session') return
                const card = n.data as SessionCardData
                if (card.view === 'collapsed') cmd.clickCard(card.node)
              }}
              onNodeDoubleClick={(e, n) => {
                if (n.type === 'session' && doubleClickOpensTerminal(e.target)) {
                  cmd.doubleClickCard((n.data as SessionCardData).node)
                }
                // Área vazia da lane = nova sessão ali. Lane de projeto (entre as
                // colunas) não sabe qual repo: abre a lista.
                if (n.type === 'lane') cmd.openNewSession((n.data as LaneData).repoId)
              }}
              zoomOnDoubleClick={false}
              onPaneClick={() => setMenu(null)}
              onNodeMouseEnter={(_e, n) => {
                if (n.type === 'session') setHoveredId(n.id)
              }}
              onNodeMouseLeave={(_e, n) => setHoveredId((h) => (h === n.id ? null : h))}
              onMoveEnd={resubscribe}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              deleteKeyCode={null}
              // Camadas fixas (graph-to-flow): fio nunca sobe acima de cartão.
              zIndexMode="manual"
              minZoom={0.2}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="var(--color-border)" gap={24} />
              <Controls
                position="bottom-left"
                className="!border-[var(--color-border)] !bg-[var(--color-surface)] [&_button]:!border-[var(--color-border)] [&_button]:!bg-[var(--color-surface)] [&_button]:!fill-[var(--color-text-dim)] [&_button]:!text-[var(--color-text-dim)] [&_button:hover]:!bg-[var(--color-surface-2)]"
                showInteractive={false}
                showFitView={false}
              >
                {/* Mesma classe do fitView padrão: o "enquadrar" agora é o legível. */}
                <ControlButton
                  className="react-flow__controls-fitview"
                  onClick={() => fitReadable()}
                  title="Enquadrar (no menor zoom em que dá pra ler)"
                  aria-label="Enquadrar"
                >
                  <Icon as={Maximize} size={12} />
                </ControlButton>
                <ControlButton
                  data-testid="map-zoom-100"
                  onClick={actualSize}
                  title="100% a partir do canto superior esquerdo"
                  aria-label="Zoom 100%"
                  className="!text-[10px] !font-semibold"
                >
                  1:1
                </ControlButton>
                {sessionCount >= MINIMAP_MIN_CARDS && (
                  <ControlButton
                    data-testid="map-minimap-toggle"
                    onClick={() => setMinimapCollapsed((c) => !c)}
                    title={minimapCollapsed ? 'Mostrar o minimapa' : 'Esconder o minimapa'}
                    aria-label={minimapCollapsed ? 'Mostrar o minimapa' : 'Esconder o minimapa'}
                    aria-pressed={!minimapCollapsed}
                  >
                    <Icon as={MapIcon} size={12} />
                  </ControlButton>
                )}
              </Controls>
              {showMinimap && (
                <MiniMap
                  // A Equipe aberta flutua sobre a borda direita: o minimapa desvia dela.
                  style={{
                    ...(dockOverlay ? { right: dockOverlay } : {}),
                    width: minimapSize(contentBounds).w,
                    height: minimapSize(contentBounds).h,
                  }}
                  maskStrokeColor="var(--color-accent)"
                  maskStrokeWidth={1.5}
                  offsetScale={10}
                  className="!border !border-[var(--color-border)] !bg-[var(--color-surface)]"
                  nodeColor={minimapColor}
                  maskColor="color-mix(in srgb, var(--color-bg) 70%, transparent)"
                  pannable
                  zoomable
                />
              )}
              <SelectionToolbar
                nodeId={selected.length === 1 ? selected[0].id : null}
                actions={selectionActions}
                position={toolbarPositionFor(selected.length === 1 ? selected[0] : undefined)}
                onMore={(at) => setMenu({ ...at, flowId: selected[0].id })}
              />
            </ReactFlow>
            <MapTopBar
              rightInset={dockOverlay}
              scopeMode={scope === GLOBAL_CANVAS_SCOPE ? 'all' : 'project'}
              hasProject={!!activeProjectId}
              onScope={setScopeMode}
              hiddenEdges={hiddenEdges}
              onNewSession={() => cmd.openNewSession(null)}
              onNote={() => cmd.createNote(null, looseNoteSlot())}
              onGroup={cmd.createGroup}
              onTidy={() => void cmd.tidy()}
              onOpenAll={() =>
                useCardViewStore.getState().openAll(sessionNodes.map((n) => n.sessionId))
              }
              onCollapseAll={() =>
                useCardViewStore.getState().collapseAll(sessionNodes.map((n) => n.sessionId))
              }
            >
              <MapStatusCounters
                nodes={sessionNodes}
                onCenter={(id) => centerOn(id, Math.max(flowApi.getZoom(), 0.9))}
              />
            </MapTopBar>
            <MapOverflowHints containerRef={containerRef} onFit={() => fitReadable()} />
            <FeaturePanel rightInset={dockOverlay} sessions={graph.nodes} />
            <MapFeatureMovePicker />
            {menu && menuNode && (
              <MapContextMenu
                at={menu}
                actions={actionsFor(menuNode, cmd, groups, memberCounts)}
                onClose={() => setMenu(null)}
              />
            )}
            {sessionCount === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[var(--color-text-dim)]">
                Nenhuma sessão em uso — “Nova sessão” (ou N) abre uma aqui.
              </div>
            )}
            <DelegateDialog target={cmd.delegateTarget} onClose={cmd.closeDelegate} />
            <NewSessionFlow
              open={!!cmd.newSession}
              initialRepoId={cmd.newSession?.repoId ?? null}
              onClose={cmd.closeNewSession}
            />
            {cmd.batonTarget && (
              <BatonDialog
                open
                onClose={cmd.closeBaton}
                sessionId={cmd.batonTarget.sessionId}
                ccSessionId={cmd.batonTarget.ccSessionId}
                repoLabel={cmd.batonTarget.repoLabel}
              />
            )}
          </div>
        </MapFocusContext.Provider>
      </MapLiveContext.Provider>
    </MapActionsContext.Provider>
  )
}

export function SessionMap() {
  return (
    <ReactFlowProvider>
      <SessionMapInner />
    </ReactFlowProvider>
  )
}
