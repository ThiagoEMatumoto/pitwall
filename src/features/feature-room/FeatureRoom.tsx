import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import {
  openFeatureSwitcher,
  showFeatureOnMap,
  switcherInUse,
} from '@/features/session-canvas/FeatureSwitcher'
import { DelegateDialog, type DelegateTarget } from '@/features/session-canvas/DelegateDialog'
import { featureLaneId } from '@/features/session-canvas/graph-to-flow'
import { isTypingTarget } from '@/features/session-canvas/typing-target'
import { Dialog } from '@/components/ui/Dialog'
import { ensureSessionGraph, useSessionGraph } from '@/features/sessions/session-graph-store'
import { useAppStore } from '@/store/appStore'
import { useAttentionListStore } from '@/store/attentionStore'
import { countAttentionSubjects, humanQueue } from '../../../shared/attention/selectors'
import { useHandoffsStore } from '@/store/handoffsStore'
import type { RoomTimelineEvent } from '../../../shared/types/feature-room'
import { AllMothers } from './AllMothers'
import { AttentionQueue } from './AttentionQueue'
import { useFeatureRoomStore } from './feature-room-store'
import type { QueueSubject } from './QueueItem'
import { buildRoomView, type RoomQueueRow, type RoomSessionRow } from './room-model'
import { COMPACT, ROOM_FOCUS, useNow } from './room-ui'
import { Button } from '@/components/ui/Button'
import { RoomHeader } from './RoomHeader'
import { RoomHealth } from './RoomHealth'
import { RoomMotherPane, type MotherMode } from './RoomMotherPane'
import { RoomSessions } from './RoomSessions'
import { RoomTimeline } from './RoomTimeline'
import { StartMotherCard, focusMotherComposer, usePendingMotherProgress } from './StartMotherCard'
import { useFeatureRoom } from './useFeatureRoom'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'

// A Room: nível 'all' (Todas as mães, entrada pela IconRail) ou a sala da feature
// (tile, "Abrir sala" ou o seletor do Ctrl+`). Os passos de "Iniciar sessão-mãe"
// avançam aqui, nos dois níveis: a mãe pode nascer pelo diálogo global.
export function FeatureRoom() {
  const level = useFeatureRoomStore((s) => s.level)
  usePendingMotherProgress()
  return level === 'all' ? <AllMothers /> : <FeatureSala />
}

// A sala de uma feature: fila de "precisa de você" (recorte da projeção única),
// sessões por repo e a linha do tempo dos handoffs.
function FeatureSala() {
  const featureId = useFeatureRoomStore((s) => s.featureId)
  const timelineFilter = useFeatureRoomStore((s) => s.timelineFilter)
  const openId = useFeatureRoomStore((s) => s.openId)
  const { snapshot, failed, retry } = useFeatureRoom(featureId)
  const graph = useSessionGraph()
  const liveSessions = useAppStore((s) => s.liveSessions)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const attention = useAttentionListStore((s) => s.items)
  const now = useNow()
  const selectedMotherId = useFeatureRoomStore((s) =>
    featureId ? (s.selectedMotherId[featureId] ?? null) : null,
  )
  const pendingMother = useFeatureRoomStore((s) =>
    s.pendingMother && s.pendingMother.featureId === featureId ? s.pendingMother : null,
  )
  const [motherMode, setMotherMode] = useState<MotherMode>('chat')
  const [startOpen, setStartOpen] = useState(false)
  const [sideTab, setSideTab] = useState<'children' | 'timeline'>('children')
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
            selectedMotherId,
          })
        : null,
    [
      featureId,
      graph,
      handoffs,
      liveSessions,
      attention,
      inUse,
      snapshot,
      timelineFilter,
      selectedMotherId,
    ],
  )

  // A mãe do centro: a tab escolhida; a recém-criada vale antes de o grafo a
  // enxergar (está viva, mas ainda sem nó).
  const centerId = useMemo(() => {
    if (!view) return null
    if (view.mothers.some((m) => m.sessionId === selectedMotherId)) return selectedMotherId
    const fresh =
      selectedMotherId &&
      liveSessions.some((l) => l.id === selectedMotherId && l.status !== 'ended') &&
      !graph.nodes.some((n) => n.sessionId === selectedMotherId)
    return fresh ? selectedMotherId : (view.mother?.sessionId ?? null)
  }, [view, selectedMotherId, liveSessions, graph])
  useEffect(() => setMotherMode('chat'), [centerId])

  // Ctrl+. alterna Chat⇄Terminal da mãe. Captura: com o foco no xterm a tecla
  // não chega à bolha do React.
  useEffect(() => {
    if (!centerId) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key !== '.') return
      if (document.querySelector('[data-modal-overlay], [aria-modal="true"]')) return
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) setMotherMode((m) => (m === 'chat' ? 'terminal' : 'chat'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [centerId])

  const rows = useMemo(
    () => (view ? [...view.mothers, ...view.repos.flatMap((r) => r.rows)] : []),
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
  // Badge do "← Todas": o needYou (o mesmo humanQueue do nível 1) menos esta feature.
  const elsewhere = useMemo(() => {
    const here = new Set(queue.flatMap((r) => [r.head, ...r.also]))
    return countAttentionSubjects(humanQueue(attention).filter((i) => !here.has(i)))
  }, [queue, attention])
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
  const motherNode = centerId ? graph.nodes.find((n) => n.sessionId === centerId) : null

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
  const centerTab = view.mothers.find((m) => m.sessionId === centerId) ?? null
  const newChild = () => {
    if (!centerTab) return
    setDelegate({
      motherSessionId: centerTab.sessionId,
      motherTitle: centerTab.title,
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
    // Esc: o diálogo é portal (não chega aqui); depois o peek, depois Todas as mães.
    // No composer da mãe, vazio volta e com texto só tira o foco (protege o rascunho). Do
    // xterm (modo terminal) o Esc é da TUI: só devolve o foco à sala.
    // defaultPrevented: quem recebeu o Esc já o tratou.
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      const t = e.target
      if (isTypingTarget(t)) {
        const emptyComposer =
          t instanceof HTMLTextAreaElement &&
          !t.closest('.xterm') &&
          !!t.closest('[data-testid="room-mother"]') &&
          t.value.trim() === ''
        if (emptyComposer) useFeatureRoomStore.getState().openAllMothers()
        else rootRef.current.focus({ preventScroll: true })
        return
      }
      const dock = useCrewDockStore.getState()
      if (dock.peekTarget) dock.closePeek()
      else useFeatureRoomStore.getState().openAllMothers()
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target) || e.defaultPrevented) return
    if (e.key === '/' && centerId) {
      if (focusMotherComposer()) e.preventDefault()
      return
    }
    // 1-9: a opção do card de permissão da mãe, pelo mesmo clique (guardado)
    // do ChatView. Sem card na tela, a tecla não faz nada.
    if (/^[1-9]$/.test(e.key) && centerId) {
      const option = rootRef.current.querySelector<HTMLButtonElement>(
        `[data-testid="room-mother"] [data-permission-option="${e.key}"]`,
      )
      if (option) {
        e.preventDefault()
        option.click()
      }
      return
    }
    const k = e.key.toLowerCase()
    if (k !== 'j' && k !== 'k') return
    e.preventDefault()
    step(k === 'j' ? 1 : -1)
  }

  const showCard = !!pendingMother || !centerId
  const startMother = () => {
    if (centerId) setStartOpen(true)
    else
      rootRef.current
        ?.querySelector<HTMLTextAreaElement>('[data-testid="start-mother-purpose"]')
        ?.focus()
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
        backBadge={elsewhere}
        onBack={() => useFeatureRoomStore.getState().openAllMothers()}
        title={snapshot.feature.title}
        chain={snapshot.objectiveChain}
        needsYou={view.needsYou}
        canDelegate={!!centerTab}
        onSeeMap={seeMap}
        onFeatures={openFeatureSwitcher}
        onNewChild={newChild}
        onStartMother={startMother}
      />
      <RoomHealth snapshot={snapshot} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] max-[900px]:grid-cols-1 max-[900px]:overflow-auto">
        <div className="relative flex min-h-0 flex-col border-r border-[var(--color-border)] max-[900px]:min-h-[520px] max-[900px]:border-r-0">
          {centerId && (
            <RoomMotherPane
              mothers={view.mothers}
              motherId={centerId}
              mode={motherMode}
              onToggleMode={() => setMotherMode((m) => (m === 'chat' ? 'terminal' : 'chat'))}
              onSelect={(id) => useFeatureRoomStore.getState().selectMother(featureId, id)}
              onPeek={(id) => useCrewDockStore.getState().openSessionPeek(id, 'chat')}
            />
          )}
          {showCard && (
            <div
              className={`flex justify-center overflow-auto p-6 ${
                centerId
                  ? 'absolute inset-0 z-10 items-center bg-[var(--color-bg)]/90'
                  : 'flex-1 items-center'
              }`}
            >
              <StartMotherCard featureId={featureId} featureTitle={snapshot.feature.title} />
            </div>
          )}
        </div>
        <aside className="flex min-h-0 flex-col" aria-label="Fila e filhas">
          <div className="max-h-[55%] shrink-0 overflow-auto border-b border-[var(--color-border)]">
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
          <div role="tablist" aria-label="Lateral da Room" className="flex gap-1 px-4 pt-2">
            {(
              [
                ['children', 'Filhas'],
                ['timeline', 'Linha do tempo'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={sideTab === id}
                data-testid={`room-side-${id}`}
                onClick={() => setSideTab(id)}
                className={`rounded-md px-2 py-1 text-[12px] ${
                  sideTab === id
                    ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                    : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {sideTab === 'children' ? (
              <RoomSessions
                hasMother={!!centerId}
                repos={view.repos}
                progress={view.progress}
                filter={timelineFilter}
                onFilter={(id) => useFeatureRoomStore.getState().setFilter(id)}
                onPeek={(row) => peek(row, 'chat')}
                onSeeMap={seeMap}
              />
            ) : (
              <RoomTimeline
                events={view.timeline}
                filterName={filterName}
                hasSessions={rows.length > 0}
                nameOf={nameOf}
                now={now}
                onClearFilter={() => useFeatureRoomStore.getState().setFilter(null)}
              />
            )}
          </div>
        </aside>
      </div>
      <Dialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        title="Nova sessão-mãe"
        widthClassName="w-[36rem]"
      >
        <StartMotherCard
          featureId={featureId}
          featureTitle={snapshot.feature.title}
          heading={false}
          onStarted={() => setStartOpen(false)}
        />
      </Dialog>
      <DelegateDialog target={delegate} onClose={() => setDelegate(null)} />
    </main>
  )
}
