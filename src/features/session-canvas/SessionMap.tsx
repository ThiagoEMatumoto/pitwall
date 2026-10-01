import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type Connection,
  type Edge,
  type Node,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Map as MapIcon, Maximize } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { paneShowsLive } from '@/features/handoffs/crew'
import './session-map.css'
import { useAppStore } from '@/store/appStore'
import { useSessionGraph } from '@/features/sessions/session-graph-store'
import { useAttentionQueue, useAttentionStore } from '@/features/session-switcher/useAttentionQueue'
import { useCrewDockStore, peekedSessionId } from '@/features/handoffs/crew-dock-store'
import { useHandoffsStore } from '@/store/handoffsStore'
import { sendToApi } from '@/lib/ipc'
import { useMapSessionIds } from '@/features/session-switcher/useGlobalSessions'
import { NewSessionFlow } from '@/features/sessions/NewSessionFlow'
import { BatonDialog } from '@/features/sessions/BatonDialog'
import { GLOBAL_CANVAS_SCOPE, type CanvasPositionInput } from '../../../shared/types/canvas'
import {
  graphToFlow,
  positionKey,
  repoLaneId,
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
import { DelegateDialog } from './DelegateDialog'
import { SessionCardNode } from './SessionCardNode'
import { LaneGroupNode } from './LaneGroupNode'
import { UserGroupNode } from './UserGroupNode'
import { NoteNode } from './NoteNode'
import { SessionEdge } from './SessionEdge'
import { reuseUnchanged } from './reuse-unchanged'
import { MapFocusContext, focusFor } from './map-focus'
import {
  MIN_READABLE_ZOOM,
  actualSizeViewport,
  boundsOf,
  readableViewport,
  type Insets,
} from './map-fit'
import type { Rect } from './edge-anchor'
import { TERMINAL_MIN_ZOOM, mustLeaveTerminal, terminalOf, viewLineage, viewOf } from './card-view'
import { useCardViewStore } from './card-view-store'
import { sameIdList, tailSubscription, tailText, type TailCandidate } from './card-tail'
import { advanceWorkingClocks, indicatorFor } from './card-indicator'
import { MapLiveContext, useMinuteClock, type MapLive } from './map-live'
import { MapStatusCounters } from './MapStatusCounters'
import { usePendingAsks } from '@/features/handoffs/ConversationsTab'

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

// Abaixo disto o minimapa só cobre cartões: o mapa inteiro já cabe na tela.
const MINIMAP_MIN_CARDS = 20
const INSET_GAP = 8

// O que flutua por cima do mapa, medido no DOM: barra do topo, controles de zoom
// (coluna da esquerda) e minimapa (faixa da base), relativos ao contêiner.
function overlayInsets(container: HTMLElement): Insets {
  const box = container.getBoundingClientRect()
  const rect = (sel: string) => {
    const r = container.querySelector<HTMLElement>(sel)?.getBoundingClientRect()
    return r && r.height > 0 ? r : null
  }
  const bar = rect('[data-testid="map-top-bar"]')
  const controls = rect('.react-flow__controls')
  const minimap = rect('.react-flow__minimap')
  return {
    top: bar ? bar.bottom - box.top + INSET_GAP : 0,
    left: controls ? controls.right - box.left + INSET_GAP : 0,
    bottom: minimap ? box.bottom - minimap.top + INSET_GAP : 0,
  }
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
  const canvas = useCanvasState(scope)
  const savePositions = useCanvasStateStore((s) => s.savePositions)
  const flowApi = useReactFlow<MapNode, MapEdge>()
  const views = useCardViewStore((s) => s.views)
  const terminalSizes = useCardViewStore((s) => s.terminalSizes)
  const terminalId = terminalOf(views)
  const asks = usePendingAsks()

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
      terminalSizes,
      asks,
    }),
    [graph, scope, canvas, inUse, expandedMothers, views, terminalSizes, asks],
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
  const focusRepo = focusNode ? (focusNode.data as SessionCardData).node.repoId : null
  const focus = useMemo(
    () =>
      focusFor(
        focusNode?.id ?? null,
        focusNode ? repoLaneId(focusRepo) : null,
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
      flow.nodes
        .filter((n) => n.type === 'session')
        .map((n) => (n.data as SessionCardData).node),
    [flow.nodes],
  )
  const showMinimap = sessionCount >= MINIMAP_MIN_CARDS && !minimapCollapsed

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
  const visibleBounds = useCallback(() => {
    const top = flowApi
      .getNodes()
      .filter((n) => !n.parentId)
      .map((n) => rectOf(n.id))
    return boundsOf(top.filter((r): r is Rect => r !== null))
  }, [flowApi, rectOf])

  // Enquadramento legível (map-fit.ts): o inicial e o botão de enquadrar. O
  // fitView do xyflow encaixava tudo num zoom ~0.3 em que nada se lia.
  const fitReadable = useCallback(() => {
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
    const priority = boundsOf(
      needsYou
        .map((n) => rectOf(sessionNodeId(n.sessionId)))
        .filter((r): r is Rect => r !== null),
    )
    const viewport = readableViewport({
      visible: visibleBounds(),
      priority,
      view: { w: el.clientWidth, h: el.clientHeight },
      insets: overlayInsets(el),
    })
    if (viewport) void flowApi.setViewport(viewport, { duration: 0 })
  }, [flowApi, rectOf, visibleBounds])

  const actualSize = useCallback(() => {
    const el = containerRef.current
    const viewport = el ? actualSizeViewport(visibleBounds(), overlayInsets(el)) : null
    if (viewport) void flowApi.setViewport(viewport, { duration: reducedMotion() ? 0 : 200 })
  }, [flowApi, visibleBounds])

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

  // Entrou no modo terminal: zoom 1.0 centrado no cartão — o texto do xterm só é
  // nítido sem escala, e o mouse do xterm só acerta a célula sem ela.
  const prevTerminal = useRef<string | null>(null)
  useEffect(() => {
    const entered = terminalId && terminalId !== prevTerminal.current
    prevTerminal.current = terminalId
    if (!entered) return
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => centerOn(terminalId, 1)))
    return () => cancelAnimationFrame(raf)
  }, [terminalId, centerOn])

  // Regra aba × cartão: se a sessão ganhou outro xterm (aba, peek em terminal) ou
  // a PTY morreu, o cartão devolve o terminal e volta a aberto.
  const liveSessions = useAppStore((s) => s.liveSessions)
  const panes = useAppStore((s) => s.panes)
  const peekTarget = useCrewDockStore((s) => s.peekTarget)
  const peekMode = useCrewDockStore((s) => s.peekMode)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  useEffect(() => {
    if (!terminalId) return
    const liveSession = liveSessions.find((x) => x.id === terminalId)
    const hasPane =
      !!liveSession && panes.some((p) => paneShowsLive(p, liveSession))
    const peeked =
      peekedSessionId(peekTarget) ??
      (peekTarget?.kind === 'handoff'
        ? (handoffs.find((h) => h.id === peekTarget.id)?.childSessionId ?? null)
        : null)
    const leave = mustLeaveTerminal({
      live: !!liveSession && liveSession.status !== 'ended',
      hasPane,
      peekedInTerminal: peekMode === 'terminal' && peeked === terminalId,
      zoom: TERMINAL_MIN_ZOOM,
    })
    if (leave) useCardViewStore.getState().leaveTerminal(terminalId)
  }, [terminalId, liveSessions, panes, peekTarget, peekMode, handoffs])

  // Sessão nova criada com o mapa na frente (sem aba): entra em terminal no
  // próprio cartão quando a PTY e o nó existirem — antes disso o efeito acima a
  // devolveria a 'open' por não estar viva.
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

  // Afastar o zoom (gesto do usuário — o setCenter de entrada não tem evento)
  // devolve o terminal: abaixo de ~0.85 ele não se lê nem se clica.
  const onMove = useCallback(
    (event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      if (!event || viewport.zoom >= TERMINAL_MIN_ZOOM) return
      const current = terminalOf(useCardViewStore.getState().views)
      if (current) useCardViewStore.getState().leaveTerminal(current)
    },
    [],
  )

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
  const fitKey = scope
  useEffect(() => {
    if (!nodesInitialized || nodes.length === 0 || fittedKey.current === fitKey) return
    // Trocar o escopo muda o flow num render e os nós do estado no seguinte (o
    // setNodes do efeito acima): sem esperar, o fit enquadrava o conjunto anterior.
    if (!sameIds(nodes, flow.nodes)) return
    fittedKey.current = fitKey
    // Terminal salvo aberto no cartão: o enquadramento é ele, em 1.0.
    const restored = terminalOf(useCardViewStore.getState().views)
    if (restored && nodes.some((n) => n.id === sessionNodeId(restored))) {
      requestAnimationFrame(() => centerOn(restored, 1))
      return
    }
    // O minimapa entra/sai junto com o conjunto: mede os insets no frame seguinte.
    requestAnimationFrame(fitReadable)
  }, [nodesInitialized, nodes, flow.nodes, fitKey, fitReadable, centerOn])

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
      leaveTerminal: (sessionId) => {
        useCardViewStore.getState().leaveTerminal(sessionId)
        // O foco estava no xterm que acabou de desmontar: volta pro mapa (teclas).
        containerRef.current?.focus({ preventScroll: true })
      },
      resizeTerminal: (sessionId, size) =>
        useCardViewStore.getState().setTerminalSize(sessionId, size),
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
          hit?.id ?? (node.parentId?.startsWith('g:') ? repoLaneId(session.repoId) : node.parentId)
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
            // Esc fora do xterm do cartão devolve o terminal; dentro, é da TUI.
            if (e.key === 'Escape' && terminalId) {
              const inTerminal = (e.target as HTMLElement).closest?.('[data-card-terminal]')
              if (inTerminal) return
              e.preventDefault()
              actions.leaveTerminal(terminalId)
              return
            }
            if (e.repeat || isTyping(e.target)) return
            const selectedSession = selectedCard
              ? (selectedCard.data as SessionCardData).node
              : null
            // Enter com o cartão selecionado: "Interagir".
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
              // Cartão aberto já é a vista: o clique só seleciona (Enter → Interagir).
              // Recolhido, o clique espia a conversa como antes.
              if (n.type !== 'session') return
              const card = n.data as SessionCardData
              if (card.view === 'collapsed') cmd.clickCard(card.node)
            }}
            onNodeDoubleClick={(_e, n) => {
              if (n.type === 'session') cmd.doubleClickCard((n.data as SessionCardData).node)
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
            onMove={onMove}
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
                onClick={fitReadable}
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
            scopeMode={scope === GLOBAL_CANVAS_SCOPE ? 'all' : 'project'}
            hasProject={!!activeProjectId}
            onScope={setScopeMode}
            hiddenEdges={hiddenEdges}
            onNewSession={() => cmd.openNewSession(null)}
            onNote={() => cmd.createNote(null)}
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
