import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Crown, MonitorCheck, Users } from 'lucide-react'
import { motherBadgeText } from '@/features/session-canvas/mother-badge'
import { Icon } from '@/components/ui/Icon'
import { Checkbox } from '@/components/ui/Checkbox'
import { ShortcutHints } from '@/components/ui/ShortcutHints'
import { OVERLAY_HINTS, type ShortcutHint } from '@/components/ui/shortcut-hints'
import { openPaneKeys } from '@/features/handoffs/crew'
import { renderProjectIcon } from '@/components/ui/projectIcon'
import { SessionFeatureChip } from '@/features/sessions/SessionFeatureChip'
import { useSessionGraph } from '@/features/sessions/session-graph-store'
import { relativeTime } from '@/lib/time'
import { useAppStore } from '@/store/appStore'
import { matchesSession } from './session-search'
import { statusView, type LiveStatus } from './status-view'
import {
  listsCrew,
  crewOnlyLabel,
  useCrewOnlyCount,
  useEndedSessions,
  useVisibleLiveSessions,
  orderByFeature,
  showRowStatus,
  withCrewSessions,
} from './useGlobalSessions'
import type { LiveSessionInfo } from '../../../shared/types/ipc'

const SWITCHER_HINTS: ShortcutHint[] = [
  ...OVERLAY_HINTS.slice(0, 2),
  { keys: ['☐'], label: 'multi-seleção pra grade' },
  ...OVERLAY_HINTS.slice(2),
]

interface Props {
  open: boolean
  onClose: () => void
}

interface GroupDef {
  id: string
  label: string
  statuses: LiveStatus[]
  accent: boolean
}

// Ordem de exibição: o acionável primeiro.
const GROUPS: GroupDef[] = [
  { id: 'waiting', label: 'Aguardando input', statuses: ['waiting'], accent: true },
  { id: 'working', label: 'Trabalhando', statuses: ['working', 'starting'], accent: false },
  { id: 'idle', label: 'Ociosas', statuses: ['idle'], accent: false },
]

// Sessões avulsas (repo null) ficam num grupo próprio, fora dos grupos por status.
const STANDALONE_GROUP: GroupDef = {
  id: 'standalone',
  label: 'Avulsas',
  statuses: [],
  accent: false,
}

export function SessionSwitcher({ open, onClose }: Props) {
  const panes = useAppStore((s) => s.panes)
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const openSessionsInGrid = useAppStore((s) => s.openSessionsInGrid)
  const resumeSession = useAppStore((s) => s.resumeSession)

  // Filhas de handoffs ativos ficam fora do seletor (hook compartilhado com o palette).
  const visibleSessions = useVisibleLiveSessions()
  const allLive = useAppStore((s) => s.liveSessions)
  const crewCount = useCrewOnlyCount()
  const crewLabel = crewOnlyLabel(crewCount)
  // "+N na equipe" é um toggle: ligado, as filhas do dock entram na lista,
  // marcadas — senão as sessões da mesma feature ficavam escondidas atrás dele.
  const [showCrew, setShowCrew] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // A filha herda a feature da mãe no grafo; o índice reverso do chip não a tem.
  const graph = useSessionGraph()
  // Mãe -> nº de filhas: a coroa do mapa, das abas e da modal também na linha.
  const motherOf = useMemo(
    () =>
      new Map(graph.nodes.filter((n) => n.isMother).map((n) => [n.sessionId, n.childCount ?? 0])),
    [graph],
  )
  const featureOf = useMemo(
    () => new Map(graph.nodes.map((n) => [n.sessionId, n.featureId ?? null])),
    [graph],
  )
  // Filha → mãe (fio de handoff do grafo): a filha vem logo abaixo da mãe, com "↳".
  const motherOfChild = useMemo(
    () =>
      new Map(
        graph.edges.flatMap((e) => (e.kind === 'handoff' ? [[e.to, e.from] as const] : [])),
      ),
    [graph],
  )
  const [query, setQuery] = useState('')
  const crewListed = listsCrew(showCrew, query)
  const { items: liveSessions, crewIds } = useMemo(
    () => withCrewSessions(allLive, visibleSessions, crewListed),
    [allLive, visibleSessions, crewListed],
  )
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Aba: sessões vivas (default) ou histórico de encerradas (retomáveis).
  const [tab, setTab] = useState<'active' | 'ended'>('active')
  // null = ainda carregando (fetch sob demanda ao entrar na aba).
  const endedSessions = useEndedSessions(open && tab === 'ended')
  // Tick pra reavaliar os tempos relativos sem novos broadcasts.
  const [, setNow] = useState(() => Date.now())
  // Índice ativo da navegação por teclado (↑↓ + Enter), sobre a lista achatada
  // na ordem visual (mesmo padrão do CommandPalette).
  const [activeIdx, setActiveIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(new Set())
    setTab('active')
    setActiveIdx(0)
    setShowCrew(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [open])

  // Chaves (ccSessionId da lista viva) das sessões exibidas no split ("na tela").
  const onScreen = useMemo(() => openPaneKeys(panes), [panes])

  const filtered = useMemo(
    () => liveSessions.filter((s) => matchesSession(query, s)),
    [liveSessions, query],
  )

  const grouped = useMemo(() => {
    const withRepo = filtered.filter((s) => s.repo !== null)
    const standalone = filtered.filter((s) => s.repo === null)
    return [
      ...GROUPS.map((g) => ({
        def: g,
        ...orderByFeature(
          withRepo.filter((s) => g.statuses.includes(s.status)),
          featureOf,
          motherOfChild,
        ),
      })),
      { def: STANDALONE_GROUP, items: standalone, childOf: new Map<string, string>() },
    ].filter((g) => g.items.length > 0)
  }, [filtered, featureOf, motherOfChild])

  const selectedItems = useMemo(
    () => liveSessions.filter((s) => selected.has(s.ccSessionId)),
    [liveSessions, selected],
  )

  function toggleSelected(ccSessionId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(ccSessionId)) next.delete(ccSessionId)
      else next.add(ccSessionId)
      return next
    })
  }

  // Busca também na aba de encerradas (mesmos campos).
  const filteredEnded = useMemo(
    () => (endedSessions ?? []).filter((s) => matchesSession(query, s)),
    [endedSessions, query],
  )

  // Lista achatada na ordem visual da aba corrente — alvo da navegação ↑↓.
  const flatItems = useMemo(
    () => (tab === 'ended' ? filteredEnded : grouped.flatMap((g) => g.items)),
    [tab, filteredEnded, grouped],
  )
  const idxByCc = useMemo(() => new Map(flatItems.map((it, i) => [it.ccSessionId, i])), [flatItems])

  useEffect(() => {
    setActiveIdx(0)
  }, [query, tab])

  // Lista encolheu (broadcast ao vivo): mantém o índice dentro dos limites.
  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, flatItems.length - 1)))
  }, [flatItems.length])

  // Mantém o item ativo visível ao navegar por teclado.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  function openOne(item: LiveSessionInfo) {
    void focusOrOpenSession(item)
    onClose()
  }

  // Encerrada com transcript → retomar via fluxo de resume existente (todas as
  // entradas de listEndedGlobal são retomáveis por construção).
  function openEnded(item: LiveSessionInfo) {
    void resumeSession(
      item.repo,
      item.projectName,
      item.projectIcon,
      item.projectColor,
      item.ccSessionId,
    )
    onClose()
  }

  function openGrid() {
    if (selectedItems.length === 0) return
    void openSessionsInGrid(selectedItems)
    onClose()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, flatItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[activeIdx] ?? flatItems[0]
      if (tab === 'ended') {
        if (item) openEnded(item)
      } else if (selectedItems.length > 0) openGrid()
      else if (item) openOne(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  return (
    <div
      data-modal-overlay
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[70vh] w-[40rem] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
        <div className="border-b border-[var(--color-border)] px-3">
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Buscar sessões por título ou projeto…"
            className="w-full bg-transparent py-3 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
          />
        </div>

        <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-3 py-2">
          {(
            [
              { id: 'active', label: 'Ativas' },
              { id: 'ended', label: 'Encerradas' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-md px-2 py-1 text-xs transition ${
                tab === t.id
                  ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {tab === 'ended' ? (
            <>
              {endedSessions === null && (
                <div className="px-4 py-10 text-center text-xs text-[var(--color-text-dim)]">
                  carregando…
                </div>
              )}
              {endedSessions !== null && filteredEnded.length === 0 && (
                <div className="px-4 py-10 text-center text-xs text-[var(--color-text-dim)]">
                  {endedSessions.length === 0
                    ? 'Nenhuma sessão encerrada com transcript.'
                    : 'Nenhum resultado.'}
                </div>
              )}
              <ul className="flex flex-col gap-px">
                {filteredEnded.map((item) => (
                  <SessionRow
                    key={item.ccSessionId}
                    item={item}
                    accent={false}
                    selected={false}
                    selectable={false}
                    onScreen={false}
                    dataIdx={idxByCc.get(item.ccSessionId) ?? -1}
                    keyboardActive={idxByCc.get(item.ccSessionId) === activeIdx}
                    onToggle={() => {}}
                    onOpen={() => openEnded(item)}
                  />
                ))}
              </ul>
            </>
          ) : (
            <>
              {grouped.length === 0 && (
                <div className="px-4 py-10 text-center text-xs text-[var(--color-text-dim)]">
                  {liveSessions.length === 0 ? 'Nenhuma sessão viva.' : 'Nenhum resultado.'}
                </div>
              )}

              {grouped.map(({ def, items, childOf }) => (
                <div key={def.id} className="mb-4">
                  <div className="mb-1 flex items-center gap-2 px-2">
                    <span
                      className={`text-[10px] font-medium uppercase tracking-wide ${
                        def.accent ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-dim)]'
                      }`}
                    >
                      {def.label}
                    </span>
                    <span
                      data-testid={`switcher-count-${def.id}`}
                      className="text-[10px] text-[var(--color-text-dim)] opacity-70"
                    >
                      {/* As linhas que estão no grupo: o chip ao lado diz quantas filhas ficam fora. */}
                      {items.length}
                    </span>
                    {def.id === 'working' && crewLabel && (
                      <button
                        type="button"
                        data-testid="switcher-crew-count"
                        aria-pressed={showCrew}
                        onClick={() => {
                          setShowCrew((v) => !v)
                          // O foco volta à busca: é nela que ↑↓, Enter e Esc funcionam.
                          inputRef.current?.focus()
                        }}
                        // Rótulo fixo (é a contagem); o estado do toggle é o preenchimento e o
                        // check. Trocar o texto ("Equipe na lista") o fazia ora contador, ora botão.
                        title="Mostrar/ocultar sessões da equipe na lista"
                        className={`flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] transition ${
                          showCrew
                            ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                            : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
                        }`}
                      >
                        <Icon as={showCrew ? Check : Users} size={10} />
                        {crewLabel}
                      </button>
                    )}
                  </div>
                  <ul className="flex flex-col gap-px">
                    {items.map((item) => (
                      <SessionRow
                        key={item.ccSessionId}
                        item={item}
                        accent={def.accent}
                        showStatus={showRowStatus(item.status, def.statuses)}
                        selected={selected.has(item.ccSessionId)}
                        onScreen={onScreen.has(item.ccSessionId)}
                        crew={crewIds.has(item.id)}
                        featureId={featureOf.get(item.id) ?? null}
                        motherOf={motherOf.get(item.id) ?? null}
                        nested={childOf.has(item.id)}
                        dataIdx={idxByCc.get(item.ccSessionId) ?? -1}
                        keyboardActive={idxByCc.get(item.ccSessionId) === activeIdx}
                        onToggle={() => toggleSelected(item.ccSessionId)}
                        onOpen={() => openOne(item)}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </div>

        {selectedItems.length > 0 ? (
          <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
            <span className="text-xs text-[var(--color-text-dim)]">
              {selectedItems.length} selecionada{selectedItems.length === 1 ? '' : 's'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="rounded-md px-2 py-1 text-xs text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              >
                Limpar
              </button>
              <button
                type="button"
                onClick={openGrid}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-black transition hover:opacity-90"
              >
                Abrir {selectedItems.length} em paralelo
              </button>
            </div>
          </div>
        ) : (
          <div className="border-t border-[var(--color-border)] px-3 py-2">
            <ShortcutHints hints={SWITCHER_HINTS} />
          </div>
        )}
      </div>
    </div>
  )
}

interface RowProps {
  item: LiveSessionInfo
  accent: boolean
  // Status diferente do grupo (sob "Trabalhando", só quem está "iniciando").
  showStatus?: boolean
  selected: boolean
  // Encerradas não entram na multi-seleção de grade (o re-attach exige PTY viva).
  selectable?: boolean
  onScreen: boolean
  // Filha de handoff que só está na Equipe (entrou pelo toggle "+N na equipe").
  crew?: boolean
  featureId?: string | null
  // Mãe: quantas filhas ela lidera (null = não é mãe).
  motherOf?: number | null
  // Filha posta logo abaixo da mãe (ordem por feature): recuo + "↳".
  nested?: boolean
  // Posição na lista achatada (âncora do scrollIntoView) + destaque do teclado.
  dataIdx: number
  keyboardActive: boolean
  onToggle: () => void
  onOpen: () => void
}

function SessionRow({
  item,
  accent,
  showStatus = true,
  selected,
  selectable = true,
  onScreen,
  crew = false,
  featureId = null,
  motherOf = null,
  nested = false,
  dataIdx,
  keyboardActive,
  onToggle,
  onOpen,
}: RowProps) {
  const view = statusView(item.status)
  const name = item.title ?? item.name ?? item.repo?.label ?? 'Avulsa'
  const preview = item.lastText?.replace(/\s+/g, ' ').trim()

  return (
    <li
      data-idx={dataIdx}
      className={`group flex items-center gap-3 rounded-md border-l-2 px-2 py-2 transition ${
        accent
          ? 'bg-[var(--color-warning)]/5 hover:bg-[var(--color-warning)]/10'
          : 'border-transparent hover:bg-[var(--color-surface-2)]/60'
      } ${keyboardActive ? 'ring-1 ring-inset ring-[var(--color-accent)]' : ''}`}
      style={{
        ...(accent ? { borderLeftColor: 'var(--color-warning)' } : {}),
        ...(nested ? { marginLeft: 20 } : {}),
      }}
      data-nested={nested || undefined}
    >
      {selectable && (
        <Checkbox
          checked={selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          title="Selecionar para abrir em paralelo"
        />
      )}

      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          {nested && (
            <span
              data-testid="switcher-row-nested"
              aria-hidden
              className="shrink-0 text-sm text-[var(--color-text-dim)]"
              title="Filha da sessão acima"
            >
              ↳
            </span>
          )}
          <span className="truncate text-sm text-[var(--color-text)]">{name}</span>
          {motherOf !== null && (
            <span
              data-testid="switcher-row-mother"
              className="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--color-accent)] px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-[var(--color-bg)]"
              title={`Mãe: lidera ${motherOf} ${motherOf === 1 ? 'filha' : 'filhas'} de handoff`}
            >
              <Icon as={Crown} size={10} />
              {motherBadgeText(motherOf)}
            </span>
          )}
          {crew && (
            <span
              data-testid="switcher-row-crew"
              className="flex shrink-0 items-center gap-0.5 rounded bg-[var(--color-surface-2)] px-1 py-0.5 text-[9px] text-[var(--color-text-dim)]"
              title="Filha de handoff: fica na Equipe (Ctrl+J)"
            >
              <Icon as={Users} size={10} />
              equipe
            </span>
          )}
          {onScreen && (
            <span
              className="flex shrink-0 items-center gap-0.5 rounded bg-[var(--color-surface-2)] px-1 py-0.5 text-[9px] text-[var(--color-text-dim)]"
              title="Já exibida no split"
            >
              <Icon as={MonitorCheck} size={10} />
              na tela
            </span>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-2 text-[10px] text-[var(--color-text-dim)]">
          <span className="flex shrink-0 items-center gap-1">
            {/* Projeto uma vez só: ícone na cor dele + nome (o ponto colorido
                ao lado do ícone repetia a mesma informação). */}
            <span className="shrink-0" style={{ color: item.projectColor ?? undefined }}>
              {renderProjectIcon(item.projectIcon)}
            </span>
            <span className="max-w-32 truncate">
              {item.projectName || (item.repo?.label ?? 'Avulsa')}
            </span>
          </span>
          {showStatus && (
            <span
              data-testid="switcher-row-status"
              className={`flex shrink-0 items-center gap-1 ${view.className}`}
            >
              <Icon as={view.icon} size={11} className={view.spin ? 'animate-spin' : undefined} />
              {view.label}
            </span>
          )}
          <span className="shrink-0">{relativeTime(item.lastActivityAt)}</span>
          {item.tokens && <span className="shrink-0">{item.tokens.output} tok</span>}
          <SessionFeatureChip sessionId={item.id} featureId={featureId} density="chip" />
        </div>

        {preview && (
          <div className="truncate text-[11px] text-[var(--color-text-dim)] opacity-80">
            {preview}
          </div>
        )}
      </button>
    </li>
  )
}
