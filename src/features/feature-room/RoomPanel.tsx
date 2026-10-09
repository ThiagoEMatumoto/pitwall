import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PointerEvent,
} from 'react'
import { Maximize2, PanelRightClose, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useCardViewStore } from '@/features/session-canvas/card-view-store'
import { switcherInUse } from '@/features/session-canvas/FeatureSwitcher'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'
import { ensureSessionGraph, useSessionGraph } from '@/features/sessions/session-graph-store'
import { sendToApi } from '@/lib/ipc'
import { useAppStore } from '@/store/appStore'
import { useAttentionListStore } from '@/store/attentionStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { countAttentionSubjects, humanQueue } from '../../../shared/attention/selectors'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'
import { allMothers, childIdsByMother, needYouFor, orderTiles, pinKey } from './all-mothers-model'
import { MAX_LIVE_TILES, useVisibleTiles } from './AllMothers'
import { useFeatureRoomStore } from './feature-room-store'
import { focusMotherPane } from './focus-mother-pane'
import { GlobalAttentionStrip } from './GlobalAttentionStrip'
import { useMotherPins } from './mother-pins-store'
import { MotherTile } from './MotherTile'
import { roomMothers } from './room-model'
import { clampRoomPanelWidth, useRoomPanelStore } from './room-panel-store'
import { useNow } from './room-ui'

const EMPTY_SET: ReadonlySet<string> = new Set()

// O cabo de redimensionar fica na borda esquerda: arrastar para a esquerda alarga.
// A largura do arrasto fica local; só o pointerup persiste (como o CrewDock).
function useResizeHandle() {
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const drag = useRef<{ x: number; w: number } | null>(null)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const w = useRoomPanelStore.getState().width
    drag.current = { x: e.clientX, w }
    setDragWidth(w)
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    setDragWidth(clampRoomPanelWidth(drag.current.w + (drag.current.x - e.clientX)))
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const final = clampRoomPanelWidth(drag.current.w + (drag.current.x - e.clientX))
    drag.current = null
    setDragWidth(null)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    useRoomPanelStore.getState().setWidth(final)
  }
  return { dragWidth, handlers: { onPointerDown, onPointerMove, onPointerUp } }
}

// Um painel à direita por vez: abrir o Crew Dock (clique, Ctrl+J) recolhe a Room,
// e a Room aberta deixa o dock na trilha. Assim a fila não aparece em dobro.
function useExclusiveWithCrewDock() {
  const dockCollapsed = useCrewDockStore((s) => s.collapsed)
  const prev = useRef(dockCollapsed)
  useEffect(() => {
    useCrewDockStore.getState().collapse()
  }, [])
  useEffect(() => {
    if (prev.current && !dockCollapsed) useRoomPanelStore.getState().setOpen(false)
    prev.current = dockCollapsed
  }, [dockCollapsed])
}

// A Room como painel lateral da visão de projeto: a fila "precisa de você" e as
// mães (sessões raiz em uso), com cauda, composer e aprovação no próprio tile.
// Clicar numa mãe foca a pane dela no dockview. Os números saem do MESMO needYou
// (humanQueue, uma vez aqui), como no AllMothers.
export function RoomPanel() {
  const graph = useSessionGraph()
  const liveSessions = useAppStore((s) => s.liveSessions)
  const attention = useAttentionListStore((s) => s.items)
  const pins = useMotherPins((s) => s.order)
  const storedWidth = useRoomPanelStore((s) => s.width)
  const featureFilter = useRoomPanelStore((s) => s.featureFilter)
  const focus = useRoomPanelStore((s) => s.focus)
  const mapVisible = useProjectsViewStore((s) => s.view === 'map')
  const now = useNow()
  const gridRef = useRef<HTMLDivElement>(null)
  const frozenRef = useRef<string[] | null>(null)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const resize = useResizeHandle()
  const width = resize.dragWidth ?? storedWidth
  useExclusiveWithCrewDock()

  useEffect(ensureSessionGraph, [])
  useEffect(() => {
    const store = useHandoffsStore.getState()
    store.startUpdatedWatch()
    if (store.handoffs.length === 0 && !store.loading) void store.load()
  }, [])

  const inUse = useMemo(() => switcherInUse(graph, liveSessions), [graph, liveSessions])
  const needYou = useMemo(() => humanQueue(attention), [attention])
  const everyMother = useMemo(() => allMothers(graph.nodes, inUse), [graph, inUse])
  const mothers = useMemo(
    () => (featureFilter ? everyMother.filter((m) => m.featureId === featureFilter) : everyMother),
    [everyMother, featureFilter],
  )
  const kids = useMemo(() => childIdsByMother(graph.edges, inUse), [graph, inUse])
  const needOf = useCallback(
    (m: SessionGraphNode) => needYouFor(needYou, m, (id) => kids.get(id) ?? EMPTY_SET),
    [needYou, kids],
  )
  const needById = useMemo(
    () => new Map(mothers.map((m) => [m.sessionId, needOf(m)])),
    [mothers, needOf],
  )
  const ordered = orderTiles(
    mothers,
    (id) => needById.get(id)?.length ?? 0,
    pins,
    frozenRef.current,
  )
  const orderedIds = ordered.map((m) => m.sessionId)
  const visible = useVisibleTiles(gridRef, orderedIds)
  const liveIds = useMemo(
    () =>
      new Set(
        orderedIds.filter((id) => visible === null || visible.has(id)).slice(0, MAX_LIVE_TILES),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderedIds.join(','), visible],
  )
  const liveKey = [...liveIds].join(',')

  // O screen-tail (aviso de menu/rascunho do CardPromptBar) é uma assinatura
  // única no main: com o mapa na tela, ela é do mapa e o painel não disputa.
  useEffect(() => {
    if (mapVisible) return
    const ids = liveKey ? liveKey.split(',') : []
    sendToApi
      .subscribeTail(ids)
      .catch((err) => console.error('[room-panel] falha ao assinar a saída das mães:', err))
    const off = sendToApi.onTail((u) => useCardViewStore.getState().setTail(u))
    return () => {
      off()
      void sendToApi.subscribeTail([]).catch(() => undefined)
    }
  }, [liveKey, mapVisible])

  // Pedido de foco de fora (IconRail, Ctrl+`): a mãe pedida, senão a mãe
  // principal da feature (roomMothers: a que tem filhas primeiro).
  useEffect(() => {
    if (!focus) return
    const target = focus.motherId
      ? (everyMother.find((m) => m.sessionId === focus.motherId) ?? null)
      : focus.featureId
        ? (roomMothers(graph.nodes, inUse, focus.featureId)[0] ?? null)
        : null
    if (!target && graph.nodes.length === 0) return // grafo ainda não chegou
    useRoomPanelStore.getState().consumeFocus(focus.seq)
    if (!target) return
    focusMotherPane(target)
    requestAnimationFrame(() => {
      gridRef.current
        ?.querySelector<HTMLElement>(`[data-tile="${CSS.escape(target.sessionId)}"]`)
        ?.scrollIntoView?.({ block: 'nearest' })
    })
  }, [focus, everyMother, graph, inUse])

  const featureTitleOf = useCallback(
    (featureId: string | null) => {
      if (!featureId) return null
      const lane = graph.lanes.find((l) => l.kind === 'feature' && l.featureId === featureId)
      return lane?.name ?? null
    },
    [graph],
  )

  const openTile = useCallback((node: SessionGraphNode) => {
    focusMotherPane(node)
  }, [])
  const pinTile = useCallback((node: SessionGraphNode) => {
    useMotherPins.getState().toggle(pinKey(node))
  }, [])
  const showFeature = useCallback((featureId: string) => {
    useRoomPanelStore.getState().show({ featureId })
  }, [])

  // A ordem congela enquanto um composer de tile tem foco ou rascunho.
  const onFocusIn = (e: React.FocusEvent) => {
    if ((e.target as Element).closest('[data-tile-composer]') && !frozenRef.current)
      frozenRef.current = orderedIds
  }
  const onFocusOut = (e: React.FocusEvent) => {
    if (!(e.target as Element).closest('[data-tile-composer]')) return
    const next = e.relatedTarget as Element | null
    if (next?.closest('[data-tile-composer]')) return
    const drafts = [
      ...(gridRef.current?.querySelectorAll<HTMLTextAreaElement>('[data-tile-composer] textarea') ??
        []),
    ]
    if (drafts.some((t) => t.value.trim() !== '')) return
    frozenRef.current = null
    rerender()
  }

  const badge = countAttentionSubjects(needYou)
  const filterTitle = featureFilter ? featureTitleOf(featureFilter) : null
  return (
    <aside
      data-testid="room-panel"
      aria-label="Room: mães e o que precisa de você"
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-bg)] text-[14px] text-[var(--color-text)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionar o painel da Room"
        data-testid="room-panel-resize"
        {...resize.handlers}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-[var(--color-accent)]/40"
      />
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <h2 className="m-0 text-[13.5px] font-semibold">Room</h2>
        <span data-testid="room-panel-summary" className="text-[12px] text-[var(--color-text-dim)]">
          {mothers.length} {mothers.length === 1 ? 'mãe' : 'mães'}
        </span>
        <span
          data-testid="room-panel-badge"
          aria-label={`${badge} precisa de você`}
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums"
          style={
            badge > 0
              ? { background: 'var(--color-danger)', color: 'var(--color-bg)' }
              : { background: 'var(--color-surface-2)', color: 'var(--color-text-dim)' }
          }
        >
          {badge}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="room-panel-fullscreen"
          title="Abrir a Room em tela cheia"
          aria-label="Abrir a Room em tela cheia"
          onClick={() => useFeatureRoomStore.getState().openAllMothers()}
          className="rounded-md p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={Maximize2} size={14} />
        </button>
        <button
          type="button"
          data-testid="room-panel-collapse"
          title="Recolher o painel da Room (Ctrl+Shift+L)"
          aria-label="Recolher o painel da Room"
          onClick={() => useRoomPanelStore.getState().setOpen(false)}
          className="rounded-md p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={PanelRightClose} size={15} />
        </button>
      </header>
      {featureFilter && (
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate" data-testid="room-panel-filter">
            Feature: {filterTitle ? stripUnsafeDisplay(filterTitle) : 'sem título'}
          </span>
          <button
            type="button"
            data-testid="room-panel-filter-clear"
            aria-label="Ver todas as mães"
            title="Ver todas as mães"
            onClick={() => useRoomPanelStore.getState().setFeatureFilter(null)}
            className="rounded p-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            <Icon as={X} size={13} />
          </button>
        </div>
      )}
      <GlobalAttentionStrip
        needYou={needYou}
        graph={graph}
        featureTitleOf={featureTitleOf}
        now={now}
        onOpenRoom={showFeature}
        variant="panel"
      />
      {mothers.length === 0 ? (
        <p
          data-testid="room-panel-empty"
          className="m-0 p-4 text-[12.5px] text-[var(--color-text-dim)]"
        >
          Nenhuma mãe ativa{featureFilter ? ' nesta feature' : ''}. Toda sessão que você abre é uma
          mãe.
        </p>
      ) : (
        <div
          ref={gridRef}
          role="list"
          aria-label="Sessões-mãe"
          data-testid="room-panel-list"
          onFocus={onFocusIn}
          onBlur={onFocusOut}
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden p-2.5"
        >
          {ordered.map((m, i) => {
            const items = needById.get(m.sessionId) ?? []
            const own = items.filter((it) => it.sessionId === m.sessionId)
            const menu = own.find((it) => it.kind === 'session_menu')
            return (
              <MotherTile
                key={m.sessionId}
                node={m}
                index={i}
                featureTitle={featureTitleOf(m.featureId ?? null)}
                ownNeed={countAttentionSubjects(own)}
                kidsNeed={countAttentionSubjects(items) - countAttentionSubjects(own)}
                ownMenuWhy={menu ? menu.whyNow : null}
                live={liveIds.has(m.sessionId)}
                pinned={pins.includes(pinKey(m))}
                now={now}
                onOpen={openTile}
                onPin={pinTile}
                variant="panel"
              />
            )
          })}
        </div>
      )}
    </aside>
  )
}
