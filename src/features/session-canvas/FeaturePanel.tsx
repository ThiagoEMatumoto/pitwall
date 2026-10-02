import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { create } from 'zustand'
import { Crown, Info, Pin, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'
import { FeaturePulse } from '@/features/features/FeaturePulse'
import { FeatureSessions } from '@/features/features/FeatureSessions'
import { LivenessChip, livenessReason } from '@/features/features/LivenessChip'
import { LIVENESS_META, STATUS_META } from '@/features/features/status'
import type { FeatureStatus } from '../../../shared/types/ipc'
import { useLoopSnapshot } from '@/features/features/useLoopSnapshot'
import { featuresApi, projectsApi } from '@/lib/ipc'
import {
  BUSINESS_RULES_SECTION,
  FIXED_NOTES_SECTION,
  getSection,
  type FeatureSection,
} from '../../../shared/feature-sections'
import type { Feature, Project, Repo } from '../../../shared/types/ipc'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { useFeaturePanelStore, type FeaturePanelTab } from './feature-panel-store'
import {
  clipAtWord,
  featureCrew,
  featureReminders,
  sessionStatusCounts,
  type CrewRowState,
} from './feature-state-summary'
import { reminderDisplay, remindersChipPx, remindersChipText } from './card-display'

const AUTOSAVE_MS = 600
// Quantas notas fixadas o card da feature resume.
const CARD_REMINDERS = 2

// ---- Doc da feature no renderer ----
// Cache por id com UMA assinatura de 'feature:updated': o painel e os lembretes
// de cada card leem daqui, sem um IPC por render.

interface FeatureDocState {
  docs: Record<string, Feature | undefined>
  fetch: (featureId: string) => void
  put: (feature: Feature) => void
}

const useFeatureDocStore = create<FeatureDocState>((set) => ({
  docs: {},
  fetch: (featureId) => {
    void featuresApi.get(featureId).then((f) => {
      if (f) set((s) => ({ docs: { ...s.docs, [f.id]: f } }))
    })
  },
  put: (feature) => set((s) => ({ docs: { ...s.docs, [feature.id]: feature } })),
}))

let watching = false
function watchUpdates(): void {
  if (watching) return
  watching = true
  featuresApi.onUpdated((payload) => {
    const id = (payload as { id?: string }).id
    // Só as features que alguém já está mostrando; o payload pode vir sem corpo
    // (arquivar, backfill), então relê do main.
    if (id && useFeatureDocStore.getState().docs[id]) useFeatureDocStore.getState().fetch(id)
  })
}

function useFeatureDoc(featureId: string | null): Feature | null {
  const doc = useFeatureDocStore((s) => (featureId ? s.docs[featureId] : undefined))
  useEffect(() => {
    if (!featureId) return
    watchUpdates()
    useFeatureDocStore.getState().fetch(featureId)
  }, [featureId])
  return doc ?? null
}

// ---- Lembretes no card da feature ----

/**
 * Os 2 primeiros lembretes (notas fixadas, depois regras) na 3ª linha do card da
 * feature, abaixo do pulso. Tom neutro: o laranja é só do status — com a mesma
 * cor, os lembretes competiam com ele. O resto vira "+N regras", que abre a aba
 * Notas & regras.
 */
// Cabe nos 280px do chip na fonte do cabeçalho.
const CHIP_CHARS = 40

// `zoom` decide onde os lembretes moram (reminderDisplay): na própria linha ou
// num chip na linha do título. O cabeçalho monta os dois lugares; só um desenha.
export function FeatureCardReminders({
  featureId,
  zoom,
  placement,
  headerPx = 13,
}: {
  featureId: string
  zoom: number
  placement: 'line' | 'chip'
  // Fonte do cabeçalho do frame (px do fluxo): o teto da contra-escala do chip.
  headerPx?: number
}) {
  const feature = useFeatureDoc(featureId)
  const open = useFeaturePanelStore((s) => s.open)
  const all = useMemo(() => featureReminders(feature?.body ?? ''), [feature?.body])
  if (reminderDisplay(zoom, all.length) !== placement) return null
  if (placement === 'chip') {
    const chipPx = remindersChipPx(zoom, headerPx)
    return (
      <span
        role="button"
        tabIndex={-1}
        data-testid="feature-card-reminders-chip"
        title={all.map((n) => `• ${n}`).join('\n')}
        onClick={(e) => {
          e.stopPropagation()
          open(featureId, 'notes')
        }}
        // Na cor de aviso, como os lembretes na linha: cinza sobre borda cinza sumia.
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-[color-mix(in_srgb,var(--color-warning)_45%,transparent)] px-1.5 font-normal text-[var(--color-warning)] hover:brightness-125"
        style={{ fontSize: chipPx }}
      >
        <Icon as={Pin} size={Math.round(chipPx * 0.9)} className="shrink-0" />
        {remindersChipText(all.length)}
      </span>
    )
  }
  const shown = all.slice(0, CARD_REMINDERS)
  const more = all.length - shown.length
  return (
    <span data-testid="feature-card-reminders" className="flex min-w-0 items-center gap-1.5 pb-1">
      {shown.map((n, i) => (
        <span
          key={i}
          data-testid="feature-card-reminder"
          title={n}
          className="inline-flex min-w-0 max-w-[340px] items-center gap-1 rounded border border-[var(--color-border)] px-1.5 text-[0.75em] text-[var(--color-text-dim)]"
        >
          <Icon as={Pin} size={10} className="shrink-0 text-[var(--color-warning)]" />
          <span className="min-w-0 truncate">{clipAtWord(n, CHIP_CHARS)}</span>
        </span>
      ))}
      {more > 0 && (
        <span
          role="button"
          tabIndex={-1}
          data-testid="feature-card-reminders-more"
          title="Ver todas em Notas & regras"
          onClick={(e) => {
            e.stopPropagation()
            open(featureId, 'notes')
          }}
          className="shrink-0 cursor-pointer text-[0.75em] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          +{more} {more === 1 ? 'regra' : 'regras'}
        </span>
      )}
    </span>
  )
}

// ---- Editor de seção (autosave) ----

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

function SectionEditor({
  featureId,
  section,
  value,
  placeholder,
  testId,
}: {
  featureId: string
  section: FeatureSection
  value: string
  placeholder: string
  testId: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [state, setState] = useState<SaveState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)
  const put = useFeatureDocStore((s) => s.put)

  // Fora da edição o texto acompanha o disco (síntese, MCP, outra janela) —
  // menos com save em voo ou que falhou: aí o disco ainda é o texto antigo e o
  // rascunho é a única cópia do que a pessoa digitou.
  useEffect(() => {
    if (!editing && state !== 'saving' && state !== 'error') setDraft(value)
  }, [value, editing, state])

  function save(markdown: string) {
    pending.current = null
    setState('saving')
    featuresApi
      .updateSection({ featureId, section, markdown })
      .then((f) => {
        put(f)
        setState('saved')
      })
      .catch(() => {
        // Fica pendente: o próximo blur (ou fechar o painel) tenta de novo.
        pending.current ??= markdown
        setState('error')
      })
  }

  function flush() {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (pending.current !== null) save(pending.current)
  }

  // Fechar o painel no meio da digitação não perde o texto.
  useEffect(() => () => flush(), []) // eslint-disable-line react-hooks/exhaustive-deps

  function change(next: string) {
    setDraft(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, AUTOSAVE_MS)
  }

  const status =
    state === 'saving'
      ? 'salvando…'
      : state === 'saved'
        ? 'salvo'
        : state === 'error'
          ? 'não deu para salvar — o texto continua aqui'
          : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      {editing ? (
        <textarea
          autoFocus
          data-testid={`${testId}-input`}
          aria-label={section}
          value={draft}
          onChange={(e) => change(e.target.value)}
          onBlur={() => {
            flush()
            setEditing(false)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
          }}
          placeholder={placeholder}
          className="min-h-48 w-full flex-1 resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
      ) : (
        <button
          type="button"
          data-testid={`${testId}-view`}
          onClick={() => setEditing(true)}
          title="Clique para editar"
          className="min-h-24 w-full rounded-md border border-transparent px-3 py-2 text-left text-sm text-[var(--color-text)] transition hover:border-[var(--color-border)]"
        >
          {draft.trim() ? (
            <MarkdownViewer content={draft} />
          ) : (
            <span className="whitespace-pre-line italic text-[var(--color-text-dim)]">{placeholder}</span>
          )}
        </button>
      )}
      <span
        data-testid={`${testId}-status`}
        data-state={state}
        className="h-4 text-[10px]"
        style={{ color: state === 'error' ? 'var(--color-danger)' : 'var(--color-text-dim)' }}
      >
        {status}
      </span>
    </div>
  )
}

// ---- Abas ----

// "Estado atual" abre por padrão: é a pergunta de quem chega no painel ("onde
// esta frente está?"); notas e regras são de quem vai escrever.
// 4 abas cabem nos 380px sem rolar (6 transbordavam e cortavam "Sessões"). O
// pulso mora no Estado; regras e notas fixadas, juntas.
const TABS: { id: FeaturePanelTab; label: string }[] = [
  { id: 'state', label: 'Estado' },
  { id: 'notes', label: 'Notas & regras' },
  { id: 'decisions', label: 'Decisões' },
  { id: 'sessions', label: 'Sessões' },
]
type TabId = FeaturePanelTab
const STATE_RULES = 3

function Decisions({
  feature,
  ledger,
}: {
  feature: Feature
  ledger: {
    entryId: string
    kind: string | null
    title: string
    body: string | null
    createdAt: number
  }[]
}) {
  const fromDoc = getSection(feature.body ?? '', 'Decisões')
  const entries = ledger.filter((e) => e.kind === 'decision')
  if (!fromDoc && entries.length === 0) {
    return (
      <EmptyHint
        title="Nenhuma decisão registrada ainda."
        body="As sessões registram decisões no ledger da feature (feature_ledger_append com kind decision) e a síntese as junta aqui. Ex.: «Estorno parcial fica fora do MVP»."
      />
    )
  }
  return (
    <div className="flex flex-col gap-3 text-sm text-[var(--color-text)]">
      {fromDoc && <MarkdownViewer content={fromDoc} />}
      {entries.length > 0 && (
        <ol
          data-testid="feature-panel-decision-ledger"
          className="flex flex-col gap-2 border-l border-[var(--color-border)] pl-3"
        >
          {entries.map((e) => (
            <li key={e.entryId} className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] tabular-nums text-[var(--color-text-dim)]">
                {new Date(e.createdAt).toLocaleDateString('pt-BR')}
              </span>
              <span className="font-medium">{e.title}</span>
              {e.body && <span className="text-xs text-[var(--color-text-dim)]">{e.body}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function EmptyHint({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div data-testid="feature-panel-empty" className="flex flex-col gap-1.5 px-1 text-sm">
      <p className="text-[var(--color-text)]">{title}</p>
      <p className="text-xs leading-relaxed text-[var(--color-text-dim)]">{body}</p>
      {action}
    </div>
  )
}

type LedgerRow = { entryId: string; kind: string | null; title: string; createdAt: number }

// Vitalidade do loop como ponto ao lado de PULSO (o chip disputava com o status).
function LivenessDot(props: React.ComponentProps<typeof LivenessChip>) {
  const meta = LIVENESS_META[props.liveness]
  return (
    <span
      data-testid="liveness-chip"
      data-liveness={props.liveness}
      title={livenessReason(props.liveness, props.lastActivityAt, props.issues, Date.now())}
      className="ml-1 inline-flex items-center gap-1 normal-case tracking-normal"
      style={{ color: meta.color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  )
}

function Stat({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-base font-semibold tabular-nums" style={{ color: n ? color : 'var(--color-text-dim)' }}>
        {n}
      </span>
      <span className="text-xs text-[var(--color-text-dim)]">{label}</span>
    </span>
  )
}

// O que o painel pode fazer com uma sessão da frente (vem dos comandos do mapa).
export interface SessionActions {
  open: (node: SessionGraphNode) => void
  passBaton: (node: SessionGraphNode) => void
  canPassBaton: (node: SessionGraphNode) => boolean
}

const CREW_STATE: Record<CrewRowState, { label: string; color: string }> = {
  needsYou: { label: 'precisa de você', color: 'var(--color-danger)' },
  working: { label: 'trabalhando', color: 'var(--color-info)' },
  idle: { label: 'parada', color: 'var(--color-text-dim)' },
}

const linkButton =
  'shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-accent)] transition hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-40'

// Quem lidera a frente (com o bastão) e a lista compacta das sessões dela.
function CrewSummary({
  sessions,
  featureId,
  actions,
}: {
  sessions: SessionGraphNode[]
  featureId: string
  actions?: SessionActions
}) {
  const crew = featureCrew(sessions, featureId)
  if (crew.rows.length === 0) return null
  const mother = crew.mother
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {mother && (
        <div
          data-testid="feature-panel-mother"
          className="flex min-w-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs"
        >
          <span className="shrink-0 text-[var(--color-text-dim)]">Mãe:</span>
          <span className="min-w-0 truncate font-medium" title={mother.title}>
            {mother.title}
          </span>
          <Icon as={Crown} size={11} className="shrink-0 text-[var(--color-accent)]" />
          <span className="shrink-0 text-[var(--color-text-dim)]">
            · {crew.childCount} {crew.childCount === 1 ? 'filha' : 'filhas'}
          </span>
          <span className="flex-1" />
          {actions && (
            <>
              <button
                type="button"
                data-testid="feature-panel-mother-open"
                onClick={() => actions.open(mother)}
                title="Abrir a conversa da mãe sobre o mapa"
                className={linkButton}
              >
                Abrir
              </button>
              <button
                type="button"
                data-testid="feature-panel-mother-baton"
                disabled={!actions.canPassBaton(mother)}
                onClick={() => actions.passBaton(mother)}
                title={
                  actions.canPassBaton(mother)
                    ? 'Subir a sucessora da mãe com o briefing destilado'
                    : 'Só uma sessão Claude viva pode passar o bastão'
                }
                className={linkButton}
              >
                Passar o bastão
              </button>
            </>
          )}
        </div>
      )}
      <ul data-testid="feature-panel-crew" className="flex flex-col">
        {crew.rows.map(({ node, state, isChild }) => (
          <li key={node.sessionId}>
            <button
              type="button"
              disabled={!actions}
              onClick={() => actions?.open(node)}
              title={actions ? `Abrir ${node.title}` : node.title}
              className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs transition hover:bg-[var(--color-surface-2)] disabled:hover:bg-transparent"
              style={isChild ? { paddingLeft: 16 } : undefined}
            >
              {isChild && (
                <span aria-hidden className="shrink-0 text-[var(--color-text-dim)]">
                  ↳
                </span>
              )}
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: CREW_STATE[state].color }}
              />
              <span className="min-w-0 truncate">{node.title}</span>
              {node.isMother && <Icon as={Crown} size={10} className="shrink-0 text-[var(--color-accent)]" />}
              <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-dim)]">
                {CREW_STATE[state].label}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Aba "Estado": o resumo da frente (pulso, sessões por estado, as regras que
// valem, a última mudança) e, abaixo, a seção escrita pela síntese e o pulso
// editável. Como a seção é gerada fica no (i), não no corpo.
function CurrentState({
  feature,
  sessions,
  ledger,
  pulseSlot,
  liveness = null,
  onGo,
  actions,
}: {
  feature: Feature
  sessions: SessionGraphNode[]
  ledger: LedgerRow[]
  pulseSlot: React.ReactNode
  liveness?: React.ReactNode
  onGo: (tab: TabId) => void
  actions?: SessionActions
}) {
  const body = feature.body ?? ''
  const state = getSection(body, 'Estado atual')
  const counts = sessionStatusCounts(sessions, feature.id)
  const rules = featureReminders(body)
  const last = [...ledger].sort((a, b) => b.createdAt - a.createdAt)[0]
  return (
    <div data-testid="feature-panel-state" className="flex flex-col gap-4 text-sm text-[var(--color-text)]">
      <section className="flex flex-col gap-1.5">
        <h3 className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]">
          Sessões
        </h3>
        <div data-testid="feature-panel-state-counts" className="flex gap-4">
          <Stat n={counts.needsYou} label="precisam de você" color="var(--color-danger)" />
          <Stat n={counts.working} label="trabalhando" color="var(--color-info)" />
          <Stat n={counts.idle} label="paradas" color="var(--color-text)" />
        </div>
        <CrewSummary sessions={sessions} featureId={feature.id} actions={actions} />
      </section>
      {rules.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]">Regras fixadas</h3>
          <ul data-testid="feature-panel-state-rules" className="flex flex-col gap-1">
            {rules.slice(0, STATE_RULES).map((r, i) => (
              <li key={i} title={r} className="flex min-w-0 items-start gap-1.5 text-xs">
                <Icon as={Pin} size={10} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
                <span className="line-clamp-2">{r}</span>
              </li>
            ))}
          </ul>
          {rules.length > STATE_RULES && (
            <button
              type="button"
              onClick={() => onGo('notes')}
              className="self-start text-xs text-[var(--color-text-dim)] hover:text-[var(--color-accent)]"
            >
              +{rules.length - STATE_RULES} em Notas & regras
            </button>
          )}
        </section>
      )}
      {last && (
        <section className="flex flex-col gap-0.5">
          <h3 className="text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]">Última mudança</h3>
          <p data-testid="feature-panel-state-ledger" className="text-xs">
            <span className="font-mono text-[10px] tabular-nums text-[var(--color-text-dim)]">
              {new Date(last.createdAt).toLocaleDateString('pt-BR')}
            </span>{' '}
            {last.title}
          </p>
        </section>
      )}
      {state.trim() && (
        <section className="flex flex-col gap-1">
          <h3
            className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]"
            title="Escrita pela síntese da feature a partir das sessões ligadas a ela: o que já funciona, o que falta e onde parou."
          >
            Estado atual <Icon as={Info} size={10} />
          </h3>
          <MarkdownViewer content={state} />
        </section>
      )}
      <section className="flex flex-col gap-1">
        <h3
          className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]"
          title="Como a frente está agora, em uma frase. As sessões atualizam; você também pode."
        >
          Pulso <Icon as={Info} size={10} />
          {liveness}
        </h3>
        {pulseSlot}
      </section>
    </div>
  )
}

function SessionsTab({ featureId }: { featureId: string }) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    let alive = true
    void projectsApi.list().then(async (ps) => {
      const lists = await Promise.all(ps.map((p) => projectsApi.listRepos(p.id)))
      if (!alive) return
      setProjects(ps)
      setRepos(lists.flat())
    })
    return () => {
      alive = false
    }
  }, [])
  const reposById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos])
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  return <FeatureSessions featureId={featureId} reposById={reposById} projectsById={projectsById} />
}

// ---- Painel ----

// Camadas que, abertas sobre o mapa, são donas do Esc antes do painel.
const PANEL_ESC_OWNERS = [
  '[data-peek-lift]',
  '[data-modal-overlay]',
  '[aria-modal="true"]',
  '[role="menu"]',
].join(', ')

// A barra do topo do mapa encolhe por esta largura quando o painel abre.
export const FEATURE_PANEL_W = 380

/** Painel lateral da feature sobre o mapa (dashboard da frente). Não navega. */
// `rightInset`: largura da Equipe/Conversas aberta sobre o mapa (a mesma que a
// MapTopBar desvia) — sem isto o dock, portado depois no DOM, cobre o painel.
export function FeaturePanel({
  rightInset = 0,
  sessions = [],
  actions,
}: {
  rightInset?: number
  sessions?: SessionGraphNode[]
  actions?: SessionActions
}) {
  const featureId = useFeaturePanelStore((s) => s.openFeatureId)
  const close = useFeaturePanelStore((s) => s.close)
  const tab = useFeaturePanelStore((s) => s.tab)
  const setTab = useFeaturePanelStore((s) => s.setTab)
  const feature = useFeatureDoc(featureId)
  const loop = useLoopSnapshot(featureId)

  useEffect(() => {
    if (!featureId) return
    const onKey = (e: KeyboardEvent) => {
      // Com outra camada por cima (modal do terminal, Dialog, quick look, menu
      // de contexto), o Esc é dela. Checa o DOM e não o defaultPrevented: o
      // listener do painel foi registrado antes do do Dialog e roda primeiro, e o
      // menu fecha na captura sem marcar o evento.
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector(PANEL_ESC_OWNERS)) return
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [featureId, close])

  if (!featureId) return null
  const body = feature?.body ?? ''
  // Tecla solta (Delete, setas, letras) não chega aos atalhos do mapa por trás.
  // Esc (fecha o painel) e acordes com modificador (atalhos globais da janela)
  // seguem para o window.
  const shieldMap = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return
    e.stopPropagation()
  }

  return (
    <aside
      data-testid="feature-panel"
      data-feature-panel={featureId}
      aria-label={feature ? `Painel da feature ${feature.title}` : 'Painel da feature'}
      onKeyDown={shieldMap}
      onWheel={(e) => e.stopPropagation()}
      style={{ right: rightInset, width: FEATURE_PANEL_W }}
      className="nowheel nodrag absolute right-0 top-0 bottom-0 z-30 flex max-w-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
    >
      <header className="flex items-start gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]">
            Feature
          </div>
          <h2
            data-testid="feature-panel-title"
            className="truncate text-base font-semibold text-[var(--color-text)]"
          >
            {feature?.title ?? 'Carregando…'}
          </h2>
          {/* O MESMO status do card da feature no mapa; a vitalidade do loop
              (vivo/quieto/…) mora no Pulso, que é o que ela mede. */}
          {feature && STATUS_META[feature.status as FeatureStatus] && (
            <span
              data-testid="feature-panel-status"
              className="mt-1 inline-flex rounded-full border px-1.5 text-[11px] font-medium"
              style={{
                borderColor: STATUS_META[feature.status as FeatureStatus].color,
                color: STATUS_META[feature.status as FeatureStatus].color,
              }}
            >
              {STATUS_META[feature.status as FeatureStatus].label}
            </span>
          )}
        </div>
        <button
          type="button"
          data-testid="feature-panel-close"
          onClick={close}
          title="Fechar painel (Esc)"
          aria-label="Fechar painel"
          className="shrink-0 rounded p-1 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={X} size={14} />
        </button>
      </header>

      <nav
        role="tablist"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-border)] px-2 [scrollbar-width:none]"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`feature-panel-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`shrink-0 border-b-2 px-2 py-2 text-xs transition ${
              tab === t.id
                ? 'border-[var(--color-accent)] text-[var(--color-text)]'
                : 'border-transparent text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
        {!feature ? null : tab === 'state' ? (
          <CurrentState
            feature={feature}
            sessions={sessions}
            ledger={loop.snapshot?.ledger ?? []}
            onGo={setTab}
            actions={actions}
            liveness={
              loop.snapshot ? (
                <LivenessDot
                  liveness={loop.snapshot.liveness}
                  lastActivityAt={loop.snapshot.lastActivityAt}
                  issues={loop.snapshot.issues}
                />
              ) : null
            }
            pulseSlot={
              <FeaturePulse
                featureId={feature.id}
                pulse={loop.snapshot?.pulse ?? null}
                loading={loop.loading}
                onSaved={() => void loop.reload()}
              />
            }
          />
        ) : tab === 'notes' ? (
          <div className="flex flex-col gap-3">
          <h3 className="text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]">Notas fixadas</h3>
          <SectionEditor
            key={`${feature.id}-notes`}
            featureId={feature.id}
            section={FIXED_NOTES_SECTION}
            value={getSection(body, FIXED_NOTES_SECTION)}
            placeholder={'Lembretes desta frente: o que não pode ser esquecido ao voltar a ela. Separe notas com uma linha ---; as 2 primeiras aparecem no card.\n\nEx.: "Estorno só via API nova — a antiga duplica o lançamento."'}
            testId="feature-panel-notes"
          />
          <h3 className="text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]">Regras de negócio</h3>
          <SectionEditor
            key={`${feature.id}-rules`}
            featureId={feature.id}
            section={BUSINESS_RULES_SECTION}
            value={getSection(body, BUSINESS_RULES_SECTION)}
            placeholder={'Regras que toda sessão desta feature deve respeitar; elas entram no prompt das sessões novas. Uma por linha.\n\nEx.: "- Valores sempre em centavos (inteiro)."'}
            testId="feature-panel-rules"
          />
          </div>
        ) : tab === 'decisions' ? (
          <Decisions feature={feature} ledger={loop.snapshot?.ledger ?? []} />
        ) : (
          <SessionsTab featureId={feature.id} />
        )}
      </div>
    </aside>
  )
}
