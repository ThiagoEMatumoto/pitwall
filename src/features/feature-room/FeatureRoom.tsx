import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import {
  openFeatureSwitcher,
  showFeatureOnMap,
  switcherInUse,
} from '@/features/session-canvas/FeatureSwitcher'
import { DelegateDialog, type DelegateTarget } from '@/features/session-canvas/DelegateDialog'
import { featureLaneId } from '@/features/session-canvas/graph-to-flow'
import { ensureSessionGraph, useSessionGraph } from '@/features/sessions/session-graph-store'
import { useAppStore } from '@/store/appStore'
import { useAttentionListStore } from '@/store/attentionStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import type { RoomTimelineEvent } from '../../../shared/types/feature-room'
import { AttentionQueue } from './AttentionQueue'
import { useFeatureRoomStore } from './feature-room-store'
import type { QueueSubject } from './QueueItem'
import { buildRoomView, type RoomQueueRow, type RoomSessionRow } from './room-model'
import { COMPACT, ROOM_FOCUS } from './room-ui'
import { Button } from '@/components/ui/Button'
import { RoomHeader } from './RoomHeader'
import { RoomHealth } from './RoomHealth'
import { RoomSessions } from './RoomSessions'
import { RoomTimeline } from './RoomTimeline'
import { useFeatureRoom } from './useFeatureRoom'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'

const CLOCK_MS = 30_000

// J/K são da Room só fora de campos de texto e sem modificador (Ctrl+J/K têm dono).
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => window.clearInterval(t)
  }, [])
  return now
}

// A Room de uma feature: fila de "precisa de você" (recorte da projeção única),
// sessões por repo e a linha do tempo dos handoffs. Aberta pelo Ctrl+`.
export function FeatureRoom() {
  const featureId = useFeatureRoomStore((s) => s.featureId)
  const timelineFilter = useFeatureRoomStore((s) => s.timelineFilter)
  const openId = useFeatureRoomStore((s) => s.openId)
  const { snapshot, failed, retry } = useFeatureRoom(featureId)
  const graph = useSessionGraph()
  const liveSessions = useAppStore((s) => s.liveSessions)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const attention = useAttentionListStore((s) => s.items)
  const now = useNow()
  const [delegate, setDelegate] = useState<DelegateTarget | null>(null)
  const rootRef = useRef<HTMLElement>(null)
  const openHeadRef = useRef<HTMLDivElement>(null)
  const focusOpenHead = useRef(false)

  useEffect(ensureSessionGraph, [])
  useEffect(() => {
    const store = useHandoffsStore.getState()
    store.startUpdatedWatch()
    if (store.handoffs.length === 0 && !store.loading) void store.load()
  }, [])
  // Chegou pelo Ctrl+` com o foco no xterm: J/K precisam de um dono na Room.
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    if (active?.closest('.xterm')) active.blur()
    rootRef.current?.focus({ preventScroll: true })
  }, [featureId])

  const inUse = useMemo(() => switcherInUse(graph, liveSessions), [graph, liveSessions])
  const view = useMemo(
    () =>
      featureId
        ? buildRoomView({
            featureId,
            graph,
            handoffs,
            live: liveSessions,
            attention,
            inUse,
            timeline: snapshot?.timeline ?? [],
            timelineFilter,
          })
        : null,
    [featureId, graph, handoffs, liveSessions, attention, inUse, snapshot, timelineFilter],
  )

  const rows = useMemo(
    () =>
      view ? [...(view.mother ? [view.mother] : []), ...view.repos.flatMap((r) => r.rows)] : [],
    [view],
  )
  const byHandoff = useMemo(
    () => new Map(rows.flatMap((r) => (r.handoffId ? [[r.handoffId, r] as const] : []))),
    [rows],
  )
  const bySession = useMemo(
    () => new Map(rows.flatMap((r) => (r.sessionId ? [[r.sessionId, r] as const] : []))),
    [rows],
  )
  const subjectOf = useCallback(
    (row: RoomQueueRow): QueueSubject => {
      const item = row.head
      const handoff = item.handoffId
        ? (handoffs.find((h) => h.id === item.handoffId) ?? null)
        : null
      const live = item.sessionId
        ? (liveSessions.find((s) => s.id === item.sessionId) ?? null)
        : null
      const r =
        (item.handoffId && byHandoff.get(item.handoffId)) ||
        (item.sessionId && bySession.get(item.sessionId)) ||
        null
      return {
        who: r?.title ?? stripUnsafeDisplay(handoff?.task ?? live?.title ?? live?.name ?? 'Sessão'),
        repo: r?.repoLabel ?? handoff?.targetRepoLabel ?? '',
        handoff,
        live,
      }
    },
    [handoffs, liveSessions, byHandoff, bySession],
  )
  const queue = view?.queue ?? []
  const openKey = queue.some((r) => r.subjectKey === openId)
    ? openId
    : (queue[0]?.subjectKey ?? null)

  useEffect(() => {
    if (!focusOpenHead.current) return
    focusOpenHead.current = false
    openHeadRef.current?.focus()
  }, [openKey])

  const step = useCallback(
    (dir: 1 | -1) => {
      if (queue.length === 0) return
      const i = Math.max(
        0,
        queue.findIndex((r) => r.subjectKey === openKey),
      )
      const next = Math.min(queue.length - 1, Math.max(0, i + dir))
      focusOpenHead.current = true
      useFeatureRoomStore.getState().setOpen(queue[next].subjectKey)
      if (queue[next].subjectKey === openKey) openHeadRef.current?.focus()
    },
    [queue, openKey],
  )

  if (!featureId || snapshot === null) {
    return (
      <main
        data-testid="feature-room"
        className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-[var(--color-text-dim)]"
      >
        <p className="m-0">Esta feature não existe mais ou foi arquivada.</p>
        <Button
          variant="ghost"
          className={COMPACT}
          onClick={openFeatureSwitcher}
          aria-haspopup="dialog"
          data-testid="room-gone-switch"
        >
          Trocar de feature
        </Button>
      </main>
    )
  }
  if (failed) {
    return (
      <main
        data-testid="feature-room"
        role="alert"
        className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-[var(--color-text-dim)]"
      >
        <p className="m-0">Não foi possível carregar a Room.</p>
        <Button variant="ghost" className={COMPACT} onClick={retry} data-testid="room-retry">
          Tentar de novo
        </Button>
      </main>
    )
  }
  if (!view || snapshot === undefined) {
    return (
      <main
        data-testid="feature-room"
        aria-busy
        className="flex flex-1 items-center justify-center text-[13px] text-[var(--color-text-dim)]"
      >
        Carregando a Room…
      </main>
    )
  }

  const lane = graph.lanes.find((l) => l.kind === 'feature' && l.featureId === featureId)
  const motherNode = view.mother
    ? graph.nodes.find((n) => n.sessionId === view.mother!.sessionId)
    : null

  const nameOf = (e: RoomTimelineEvent) =>
    (e.childSessionId && bySession.get(e.childSessionId)?.title) ||
    byHandoff.get(e.handoffId)?.title ||
    e.task
  const filterName = timelineFilter
    ? (bySession.get(timelineFilter)?.title ?? timelineFilter)
    : null

  const seeMap = () =>
    showFeatureOnMap({
      key: featureId,
      featureId,
      laneFlowId: featureLaneId(featureId),
      projectIds:
        lane?.kind === 'feature'
          ? [
              ...new Set(
                [lane.projectId, ...lane.repos.map((r) => r.projectId)].filter(
                  (p): p is string => !!p,
                ),
              ),
            ]
          : [],
    })
  const newChild = () => {
    if (!view.mother?.sessionId) return
    setDelegate({
      motherSessionId: view.mother.sessionId,
      motherTitle: view.mother.title,
      targetRepoId: motherNode?.repoId ?? null,
      targetRepoLabel: motherNode?.repoLabel ?? null,
      pickRepo: true,
    })
  }
  const peek = (row: RoomSessionRow, mode: 'chat' | 'terminal') => {
    const dock = useCrewDockStore.getState()
    if (row.depth > 0 && row.handoffId) dock.openPeek(row.handoffId, mode)
    else if (row.sessionId) dock.openSessionPeek(row.sessionId, mode)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // Eventos de portais (DelegateDialog, menus) borbulham pela árvore React mas não são da Room.
    if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) return
    if (e.key === 'Escape' && isTyping(e.target)) {
      e.preventDefault()
      rootRef.current.focus({ preventScroll: true })
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
    const k = e.key.toLowerCase()
    if (k !== 'j' && k !== 'k') return
    e.preventDefault()
    step(k === 'j' ? 1 : -1)
  }

  return (
    <main
      ref={rootRef}
      tabIndex={-1}
      data-testid="feature-room"
      data-state={view.state}
      aria-label={`Room da feature ${snapshot.feature.title}`}
      onKeyDown={onKeyDown}
      className={`flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-bg)] text-[14px] text-[var(--color-text)] outline-none ${ROOM_FOCUS}`}
    >
      <RoomHeader
        title={snapshot.feature.title}
        chain={snapshot.objectiveChain}
        needsYou={view.needsYou}
        canDelegate={!!view.mother}
        onSeeMap={seeMap}
        onFeatures={openFeatureSwitcher}
        onNewChild={newChild}
      />
      <RoomHealth snapshot={snapshot} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_440px] max-[900px]:grid-cols-1 max-[900px]:overflow-auto">
        <div className="flex min-h-0 flex-col border-r border-[var(--color-border)] max-[900px]:border-r-0">
          <AttentionQueue
            queue={queue}
            state={view.state}
            openKey={openKey}
            subjectOf={subjectOf}
            now={now}
            onOpen={(key) => useFeatureRoomStore.getState().setOpen(key)}
            onStep={step}
            openHeadRef={openHeadRef}
          />
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="max-h-[60%] shrink-0 overflow-auto">
            <RoomSessions
              mother={view.mother}
              repos={view.repos}
              progress={view.progress}
              filter={timelineFilter}
              canDelegate={!!view.mother}
              onFilter={(id) => useFeatureRoomStore.getState().setFilter(id)}
              onPeek={(row) => peek(row, 'chat')}
              onTerminal={(row) => peek(row, 'terminal')}
              onNewChild={newChild}
              onSeeMap={seeMap}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <RoomTimeline
              events={view.timeline}
              filterName={filterName}
              hasSessions={rows.length > 0}
              nameOf={nameOf}
              now={now}
              onClearFilter={() => useFeatureRoomStore.getState().setFilter(null)}
            />
          </div>
        </div>
      </div>
      <DelegateDialog target={delegate} onClose={() => setDelegate(null)} />
    </main>
  )
}
