import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { create } from 'zustand'
import { X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'
import { FeaturePulse } from '@/features/features/FeaturePulse'
import { FeatureSessions } from '@/features/features/FeatureSessions'
import { LivenessChip } from '@/features/features/LivenessChip'
import { useLoopSnapshot } from '@/features/features/useLoopSnapshot'
import { featuresApi, projectsApi } from '@/lib/ipc'
import {
  BUSINESS_RULES_SECTION,
  FIXED_NOTES_SECTION,
  getSection,
  splitFixedNotes,
  type FeatureSection,
} from '../../../shared/feature-sections'
import type { Feature, Project, Repo } from '../../../shared/types/ipc'
import { useFeaturePanelStore } from './feature-panel-store'

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
 * As 2 primeiras notas fixadas no header do card da feature. O header tem altura
 * fixa no layout (FEATURE_HEADER): cada lembrete é um chip de 1 linha ao lado do
 * pulso, com o texto inteiro no title.
 */
export function FeatureCardReminders({ featureId }: { featureId: string }) {
  const feature = useFeatureDoc(featureId)
  const notes = useMemo(
    () =>
      splitFixedNotes(getSection(feature?.body ?? '', FIXED_NOTES_SECTION)).slice(
        0,
        CARD_REMINDERS,
      ),
    [feature?.body],
  )
  if (notes.length === 0) return null
  return (
    <span data-testid="feature-card-reminders" className="flex min-w-0 max-w-[60%] shrink gap-1">
      {notes.map((n, i) => (
        <span
          key={i}
          data-testid="feature-card-reminder"
          title={n}
          className="min-w-0 truncate rounded border-l-2 border-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] px-1.5 text-[0.8em] text-[var(--color-text)]"
        >
          {n.replace(/\s+/g, ' ')}
        </span>
      ))}
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
            <span className="italic text-[var(--color-text-dim)]">{placeholder}</span>
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

const TABS = [
  { id: 'notes', label: 'Notas fixadas' },
  { id: 'rules', label: 'Regras de negócio' },
  { id: 'decisions', label: 'Decisões' },
  { id: 'pulse', label: 'Pulso' },
  { id: 'sessions', label: 'Sessões' },
] as const
type TabId = (typeof TABS)[number]['id']

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
      <p className="px-1 text-sm italic text-[var(--color-text-dim)]">
        Nenhuma decisão registrada ainda.
      </p>
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

/** Painel lateral da feature sobre o mapa (dashboard da frente). Não navega. */
// `rightInset`: largura da Equipe/Conversas aberta sobre o mapa (a mesma que a
// MapTopBar desvia) — sem isto o dock, portado depois no DOM, cobre o painel.
export function FeaturePanel({ rightInset = 0 }: { rightInset?: number }) {
  const featureId = useFeaturePanelStore((s) => s.openFeatureId)
  const close = useFeaturePanelStore((s) => s.close)
  const feature = useFeatureDoc(featureId)
  const loop = useLoopSnapshot(featureId)
  const [tab, setTab] = useState<TabId>('notes')

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
      style={{ right: rightInset }}
      className="nowheel nodrag absolute right-0 top-0 bottom-0 z-30 flex w-[420px] max-w-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
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
          {loop.snapshot && (
            <div className="mt-1">
              <LivenessChip
                liveness={loop.snapshot.liveness}
                lastActivityAt={loop.snapshot.lastActivityAt}
                issues={loop.snapshot.issues}
              />
            </div>
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
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-border)] px-2"
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
        {!feature ? null : tab === 'notes' ? (
          <SectionEditor
            key={`${feature.id}-notes`}
            featureId={feature.id}
            section={FIXED_NOTES_SECTION}
            value={getSection(body, FIXED_NOTES_SECTION)}
            placeholder="Lembretes desta frente. Separe notas com uma linha ---; as 2 primeiras aparecem no card."
            testId="feature-panel-notes"
          />
        ) : tab === 'rules' ? (
          <SectionEditor
            key={`${feature.id}-rules`}
            featureId={feature.id}
            section={BUSINESS_RULES_SECTION}
            value={getSection(body, BUSINESS_RULES_SECTION)}
            placeholder="Regras que toda sessão desta feature deve respeitar. Elas entram no prompt das sessões novas."
            testId="feature-panel-rules"
          />
        ) : tab === 'decisions' ? (
          <Decisions feature={feature} ledger={loop.snapshot?.ledger ?? []} />
        ) : tab === 'pulse' ? (
          <FeaturePulse
            featureId={feature.id}
            pulse={loop.snapshot?.pulse ?? null}
            loading={loop.loading}
            onSaved={() => void loop.reload()}
          />
        ) : (
          <SessionsTab featureId={feature.id} />
        )}
      </div>
    </aside>
  )
}
