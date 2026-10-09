import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useCardViewStore } from '@/features/session-canvas/card-view-store'
import { switcherInUse } from '@/features/session-canvas/FeatureSwitcher'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'
import { isTypingTarget } from '@/features/session-canvas/typing-target'
import { ensureSessionGraph, useSessionGraph } from '@/features/sessions/session-graph-store'
import { sendToApi } from '@/lib/ipc'
import { useAppStore } from '@/store/appStore'
import { useAttentionListStore } from '@/store/attentionStore'
import { useFeaturesStore } from '@/store/featuresStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { countAttentionSubjects, humanQueue } from '../../../shared/attention/selectors'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'
import { allMothers, childIdsByMother, needYouFor, orderTiles, pinKey } from './all-mothers-model'
import { useFeatureRoomStore } from './feature-room-store'
import { GlobalAttentionStrip } from './GlobalAttentionStrip'
import { useMotherPins } from './mother-pins-store'
import { MotherTile } from './MotherTile'
import { COMPACT, ROOM_FOCUS, useNow } from './room-ui'
import { StartMotherCard, focusMotherComposerWhenReady } from './StartMotherCard'

// Teto de tiles com chat:watch-tail ao mesmo tempo; o resto fica pausado.
export const MAX_LIVE_TILES = 8
const EMPTY_SET: ReadonlySet<string> = new Set()

// Tiles visíveis na grade (IntersectionObserver no scroller). Sem o observer (o
// ambiente não tem), todos contam como visíveis e o teto de 8 continua valendo.
function useVisibleTiles(rootRef: React.RefObject<HTMLElement | null>, ids: string[]) {
  // Com observer, ninguém é vivo antes do 1º callback: assinar e soltar logo em
  // seguida custaria um watcher no main por tile fora da tela.
  const [visible, setVisible] = useState<ReadonlySet<string> | null>(() =>
    typeof IntersectionObserver === 'undefined' ? null : new Set(),
  )
  const key = ids.join(',')
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const seen = new Set<string>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.tile
          if (!id) continue
          if (e.isIntersecting) seen.add(id)
          else seen.delete(id)
        }
        setVisible(new Set(seen))
      },
      { root, rootMargin: '120px 0px', threshold: 0 },
    )
    root.querySelectorAll<HTMLElement>('[data-tile]').forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [rootRef, key])
  return visible
}

function GlobalStartMother({ onStarted }: { onStarted: () => void }) {
  const features = useFeaturesStore((s) => s.features)
  const options = useMemo(
    () => features.filter((f) => f.archivedAt == null && f.status !== 'done'),
    [features],
  )
  const [featureId, setFeatureId] = useState<string | null>(null)
  useEffect(() => {
    const store = useFeaturesStore.getState()
    if (store.features.length === 0 && !store.loading) void store.load()
  }, [])
  const chosen = options.find((f) => f.id === featureId) ?? options[0] ?? null
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-[12.5px]">
        Feature
        <select
          data-testid="all-mothers-start-feature"
          value={chosen?.id ?? ''}
          onChange={(e) => setFeatureId(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13px] text-[var(--color-text)]"
        >
          {options.map((f) => (
            <option key={f.id} value={f.id}>
              {stripUnsafeDisplay(f.title)}
            </option>
          ))}
        </select>
      </label>
      {chosen ? (
        <StartMotherCard
          key={chosen.id}
          featureId={chosen.id}
          featureTitle={stripUnsafeDisplay(chosen.title)}
          heading={false}
          onStarted={onStarted}
        />
      ) : (
        <p className="m-0 text-[12.5px] text-[var(--color-text-dim)]">
          Nenhuma feature aberta. Crie uma feature para iniciar a mãe nela.
        </p>
      )}
    </div>
  )
}

// Nível 1 da Room: um tile vivo por mãe em uso, de todas as features. Todos os
// números saem do MESMO needYou (humanQueue, calculado uma vez aqui).
export function AllMothers() {
  const graph = useSessionGraph()
  const liveSessions = useAppStore((s) => s.liveSessions)
  const attention = useAttentionListStore((s) => s.items)
  const pins = useMotherPins((s) => s.order)
  const now = useNow()
  const [startOpen, setStartOpen] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const frozenRef = useRef<string[] | null>(null)
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  useEffect(ensureSessionGraph, [])
  useEffect(() => {
    const store = useHandoffsStore.getState()
    store.startUpdatedWatch()
    if (store.handoffs.length === 0 && !store.loading) void store.load()
  }, [])
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    if (active?.closest('.xterm')) active.blur()
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const inUse = useMemo(() => switcherInUse(graph, liveSessions), [graph, liveSessions])
  const needYou = useMemo(() => humanQueue(attention), [attention])
  const mothers = useMemo(() => allMothers(graph.nodes, graph.edges, inUse), [graph, inUse])
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

  // O aviso de menu/rascunho do CardPromptBar (screen-tail), só dos tiles vivos.
  // O mapa, único outro assinante, não está montado com a Room na tela.
  useEffect(() => {
    const ids = liveKey ? liveKey.split(',') : []
    sendToApi
      .subscribeTail(ids)
      .catch((err) => console.error('[room] falha ao assinar a saída das mães:', err))
  }, [liveKey])
  useEffect(() => {
    const off = sendToApi.onTail((u) => useCardViewStore.getState().setTail(u))
    return () => {
      off()
      void sendToApi.subscribeTail([]).catch(() => undefined)
    }
  }, [])

  // Poda dos pins: só com o nó fora do grafo ou encerrado (não por sair do inUse).
  useEffect(() => {
    const alive = new Set(graph.nodes.filter((n) => n.status !== 'ended').map(pinKey))
    useMotherPins.getState().prune(alive)
  }, [graph])

  const featureTitleOf = useCallback(
    (featureId: string | null) => {
      if (!featureId) return null
      const lane = graph.lanes.find((l) => l.kind === 'feature' && l.featureId === featureId)
      return lane?.name ?? null
    },
    [graph],
  )
  const featureCount = new Set(mothers.flatMap((m) => (m.featureId ? [m.featureId] : []))).size

  const openTile = useCallback((node: SessionGraphNode) => {
    if (!node.featureId) {
      useCrewDockStore.getState().openSessionPeek(node.sessionId, 'chat')
      return
    }
    const room = useFeatureRoomStore.getState()
    room.selectMother(node.featureId, node.sessionId)
    room.openRoom(node.featureId)
    focusMotherComposerWhenReady(undefined, node.sessionId)
  }, [])
  const pinTile = useCallback((node: SessionGraphNode) => {
    useMotherPins.getState().toggle(pinKey(node))
  }, [])
  const openRoom = useCallback((featureId: string) => {
    useFeatureRoomStore.getState().openRoom(featureId)
  }, [])

  const seeMap = () => {
    useAppStore.getState().setArea('projects')
    const view = useProjectsViewStore.getState()
    view.setView('map')
    view.setScopeMode('all')
  }

  const tileEl = (i: number) =>
    gridRef.current?.querySelector<HTMLElement>(`[data-tile-index="${i}"]`) ?? null
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) return
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return
    if (/^[1-9]$/.test(e.key)) {
      const el = tileEl(Number(e.key) - 1)
      if (el) {
        e.preventDefault()
        el.focus()
      }
      return
    }
    if (e.key === '/') {
      const tile =
        (e.target as Element).closest<HTMLElement>('[data-tile]') ?? tileEl(0) ?? undefined
      const input = tile?.querySelector<HTMLTextAreaElement>('[data-tile-composer] textarea')
      if (input) {
        e.preventDefault()
        input.focus()
      }
    }
  }

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
  return (
    <main
      ref={rootRef}
      tabIndex={-1}
      data-testid="all-mothers"
      aria-label="Todas as mães"
      onKeyDown={onKeyDown}
      className={`flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-bg)] text-[14px] text-[var(--color-text)] outline-none ${ROOM_FOCUS}`}
    >
      <header className="flex items-center gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <h1 className="m-0 text-[15px] font-semibold">Todas as mães</h1>
          <span
            data-testid="all-mothers-summary"
            className="text-[12.5px] text-[var(--color-text-dim)]"
          >
            {mothers.length} {mothers.length === 1 ? 'mãe' : 'mães'} · {featureCount}{' '}
            {featureCount === 1 ? 'feature' : 'features'}
          </span>
        </div>
        <span
          data-testid="all-mothers-badge"
          aria-label={`${badge} precisa de você`}
          className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11.5px] font-bold tabular-nums"
          style={
            badge > 0
              ? { background: 'var(--color-danger)', color: 'var(--color-bg)' }
              : { background: 'var(--color-surface-2)', color: 'var(--color-text-dim)' }
          }
        >
          {badge}
        </span>
        <Button
          variant="ghost"
          className={COMPACT}
          onClick={seeMap}
          data-testid="all-mothers-see-map"
        >
          Ver no mapa
        </Button>
        <Button
          variant="ghost"
          className={COMPACT}
          onClick={() => setStartOpen(true)}
          aria-haspopup="dialog"
          data-testid="all-mothers-start"
        >
          ＋ Iniciar sessão-mãe
        </Button>
      </header>
      {mothers.length === 0 ? (
        <div
          data-testid="all-mothers-empty"
          role="region"
          aria-label="Sem sessões-mãe"
          className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[13.5px] text-[var(--color-text-dim)]"
        >
          <p className="m-0 max-w-[480px]">
            Nenhuma mãe ativa. A mãe é com quem você conversa: ela planeja, abre filhas e só te
            chama quando precisar.
          </p>
          <Button
            variant="primary"
            onClick={() => setStartOpen(true)}
            data-testid="all-mothers-empty-start"
          >
            Iniciar sessão-mãe
          </Button>
        </div>
      ) : (
        <>
          <GlobalAttentionStrip
            needYou={needYou}
            graph={graph}
            featureTitleOf={featureTitleOf}
            now={now}
            onOpenRoom={openRoom}
          />
          <div
            ref={gridRef}
            role="list"
            aria-label="Sessões-mãe"
            data-testid="all-mothers-grid"
            onFocus={onFocusIn}
            onBlur={onFocusOut}
            className="grid min-h-0 flex-1 auto-rows-[minmax(250px,1fr)] grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2.5 overflow-y-auto overflow-x-hidden px-4 pb-4 pt-3"
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
                />
              )
            })}
          </div>
        </>
      )}
      <Dialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        title="Nova sessão-mãe"
        widthClassName="w-[36rem]"
      >
        <GlobalStartMother onStarted={() => setStartOpen(false)} />
      </Dialog>
    </main>
  )
}
