import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ExternalLink, GitBranch, Play } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu } from '@/components/ui/Menu'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'
import { featuresApi, shellApi } from '@/lib/ipc'
import { matchCombo, resolveCombo } from '@/lib/keybindings'
import { useKeybindingsStore } from '@/lib/keybindings-store'
import { useAppStore } from '@/store/appStore'
import { useFeaturesStore } from '@/store/featuresStore'
import { SpawnSessionDialog } from '@/features/sessions/SpawnSessionDialog'
import type { Feature, Project, Repo } from '../../../shared/types/ipc'
import { readDuplicateSuspect, withOkrIssue } from './feature-issues'
import { dismissDuplicate } from './feature-pin-api'
import { FeatureIssues } from './FeatureIssues'
import { StatusBadge } from './FeatureList'
import { FeatureObjectiveField } from './FeatureObjectiveField'
import { FeatureObjectiveLinksSection } from './FeatureObjectiveLinksSection'
import { FeaturePulse } from './FeaturePulse'
import { FeatureSessions } from './FeatureSessions'
import { FeatureTasksSection } from './FeatureTasksSection'
import { LivenessChip } from './LivenessChip'
import { useLoopSnapshot } from './useLoopSnapshot'
import { useObjectiveLookups } from './useObjectiveLookups'

interface Props {
  feature: Feature | null
  loading: boolean
  reposById: Map<string, Repo>
  projectsById: Map<string, Project>
  /** Fecha o dossiê e devolve o usuário à view de onde ele veio. */
  onBack: () => void
}

function fmtDate(ts: number | null): string | null {
  if (!ts) return null
  return new Date(ts).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

// Separa o corpo num bloco "History" (heading `## History` até o próximo H2/fim)
// pra renderizar como timeline, e o restante como markdown corrido.
function splitHistory(body: string): { main: string; history: string | null } {
  const re = /^##\s+history\s*$/im
  const m = re.exec(body)
  if (!m) return { main: body, history: null }
  const start = m.index
  const after = body.slice(start + m[0].length)
  const nextH2 = /^##\s+/m.exec(after)
  const end = nextH2 ? start + m[0].length + nextH2.index : body.length
  const history = body.slice(start + m[0].length, end).trim()
  const main = (body.slice(0, start) + body.slice(end)).trim()
  return { main, history: history || null }
}

function historyEntries(history: string): string[] {
  // Itens de lista (- / *) viram entradas da timeline; senão, parágrafos.
  const lines = history.split('\n')
  const items = lines
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
  if (items.length > 0) return items
  return history
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
}

export function FeatureDoc({ feature, loading, reposById, projectsById, onBack }: Props) {
  const split = useMemo(
    () => (feature?.body ? splitHistory(feature.body) : { main: '', history: null }),
    [feature?.body],
  )
  // Lookup compartilhado pelas seções de Tarefas e Objetivos (uma busca só).
  const { objectives, krTitles, krObjectiveId } = useObjectiveLookups()
  // Antes do early return abaixo: hook não pode ficar atrás de condicional.
  const loop = useLoopSnapshot(feature?.id ?? null)

  const openSession = useAppStore((s) => s.openSession)
  const setArea = useAppStore((s) => s.setArea)
  const overrides = useKeybindingsStore((s) => s.overrides)
  // Repo escolhido pra sessão (null = diálogo fechado).
  const [workRepo, setWorkRepo] = useState<Repo | null>(null)
  const [pickingRepo, setPickingRepo] = useState(false)
  // Feature sem repo vinculado: o botão não pode ficar mudo, então explica.
  const [noRepoNote, setNoRepoNote] = useState(false)
  // Sinais que a faixa de issues dispara pra abrir o editor certo. Contador em
  // vez de boolean: dois cliques seguidos no mesmo botão precisam reabrir.
  const [pulseSignal, setPulseSignal] = useState(0)
  const [objectiveSignal, setObjectiveSignal] = useState(0)
  const [linkSignal, setLinkSignal] = useState(0)

  // Repos da feature já resolvidos pra objeto Repo (o spawn precisa do repo
  // inteiro, não só do id do vínculo).
  const linkedRepos = useMemo(() => {
    if (!feature) return []
    return feature.repos
      .map((l) => reposById.get(l.repoId))
      .filter((r): r is Repo => r !== undefined)
  }, [feature, reposById])

  function startWork() {
    setNoRepoNote(false)
    if (linkedRepos.length === 0) {
      setNoRepoNote(true)
      return
    }
    // Um repo: não pergunta. Vários: o usuário escolhe onde a sessão nasce.
    if (linkedRepos.length === 1) {
      setWorkRepo(linkedRepos[0])
      return
    }
    setPickingRepo(true)
  }

  // Atalho "trabalhar na feature em foco": o dossiê montado É o foco, então o
  // listener vive aqui em vez de virar mais um evento global no AppShell.
  useEffect(() => {
    if (!feature) return
    function onKey(e: KeyboardEvent) {
      if (!matchCombo(e, resolveCombo('feature.work', overrides))) return
      e.preventDefault()
      startWork()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!feature) {
    // Sem botão aqui o usuário fica preso: um get que falha zera o selectedDoc
    // mas mantém o selectedId, e a área continua mostrando o dossiê vazio.
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 text-sm text-[var(--color-text-dim)]">
        <p>{loading ? 'Carregando…' : 'Selecione uma feature para ver os detalhes.'}</p>
        <button
          type="button"
          onClick={onBack}
          data-testid="feature-back-button"
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text)] transition hover:bg-[var(--color-surface-2)]"
        >
          <Icon as={ArrowLeft} size={13} />
          Voltar
        </button>
      </div>
    )
  }

  // A faixa só existe com snapshot: sem ele não dá pra saber o que está
  // errado, e sintetizar "sem OKR" sozinho daria um veredito pela metade.
  const issues = loop.snapshot
    ? withOkrIssue(loop.snapshot.issues, feature.objectiveLinkCount)
    : []
  const suspect = readDuplicateSuspect(loop.snapshot)

  const featureId = feature.id
  async function archiveThis() {
    await featuresApi.archive(featureId)
    void useFeaturesStore.getState().select(null)
    await useFeaturesStore.getState().refresh()
  }

  // "Não é duplicata": o aviso some e o dossiê continua aberto (o veredito é
  // sobre o palpite, não sobre a feature).
  async function dismissDuplicateHere() {
    await dismissDuplicate(featureId)
    await loop.reload()
    await useFeaturesStore.getState().refresh()
  }

  const created = fmtDate(feature.createdAt)
  const updated = fmtDate(feature.updatedAt)
  const completed = fmtDate(feature.completedAt)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-[var(--color-border)] px-6 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <button
              type="button"
              onClick={onBack}
              title="Voltar para a lista"
              data-testid="feature-back-button"
              className="mt-0.5 shrink-0 rounded-md p-1 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
            >
              <Icon as={ArrowLeft} size={15} />
            </button>
            <h1 className="text-lg font-semibold text-[var(--color-text)]">{feature.title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Menu
              open={pickingRepo}
              onClose={() => setPickingRepo(false)}
              items={linkedRepos.map((r) => ({
                label: r.label,
                onClick: () => setWorkRepo(r),
              }))}
            >
              <button
                type="button"
                onClick={startWork}
                data-testid="feature-work-button"
                className="flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition"
                style={{
                  borderColor: 'color-mix(in srgb, var(--color-accent) 45%, transparent)',
                  color: 'var(--color-accent)',
                  background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                }}
                title="Abrir uma sessão do Claude Code já vinculada a esta feature"
              >
                <Icon as={Play} size={13} />
                Trabalhar nesta feature
              </button>
            </Menu>
            <button
              type="button"
              onClick={() => void shellApi.openPath(feature.docPath)}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text)] transition hover:bg-[var(--color-surface-2)]"
              title={feature.docPath}
            >
              <Icon as={ExternalLink} size={13} />
              Abrir no editor
            </button>
          </div>
        </div>

        {noRepoNote && (
          <p
            data-testid="feature-work-no-repo"
            className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-text-dim)]"
          >
            Esta feature não tem repo vinculado — a sessão precisa de um repo pra saber onde rodar.
            Vincule um repo à feature (na aba do projeto) e tente de novo.
          </p>
        )}

        {/* Higiene primeiro: o que está errado nesta feature, com o gesto que
            resolve. Some por completo quando não há issue. */}
        <FeatureIssues
          issues={issues}
          suspect={suspect}
          onEditPulse={() => setPulseSignal((n) => n + 1)}
          onEditObjective={() => setObjectiveSignal((n) => n + 1)}
          onLinkOkr={() => setLinkSignal((n) => n + 1)}
          onOpenCandidate={(id) => void useFeaturesStore.getState().select(id)}
          onArchive={() => void archiveThis()}
          onDismissDuplicate={() => void dismissDuplicateHere()}
        />

        {/* O pulso vem logo abaixo do título: é a frase que responde "como a
            frente vai agora" antes de qualquer metadado. */}
        <FeaturePulse
          featureId={feature.id}
          pulse={loop.snapshot?.pulse ?? null}
          loading={loop.loading}
          focusSignal={pulseSignal}
          onSaved={() => void loop.reload()}
        />

        {/* "Resumo" = texto livre opcional (feature.objective no banco) — nome
            trocado só na UI pra não colidir com o vínculo real de OKR abaixo. */}
        <FeatureObjectiveField
          featureId={feature.id}
          objective={feature.objective}
          editSignal={objectiveSignal}
          onSaved={() => void useFeaturesStore.getState().select(feature.id)}
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Liveness primeiro (derivado do que aconteceu de fato); o status
              manual fica em peso menor — é intenção declarada, não evidência. */}
          {loop.snapshot && (
            <LivenessChip
              liveness={loop.snapshot.liveness}
              lastActivityAt={loop.snapshot.lastActivityAt}
              issues={loop.snapshot.issues}
            />
          )}
          <span className="opacity-70">
            <StatusBadge status={feature.status} />
          </span>
          {feature.repos.map((link) => (
            <span
              key={link.repoId}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-dim)]"
              title={link.branch ? `branch: ${link.branch}` : undefined}
            >
              <Icon as={GitBranch} size={10} />
              {reposById.get(link.repoId)?.label ?? link.repoId}
              {link.branch && <span className="opacity-60">· {link.branch}</span>}
            </span>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--color-text-dim)]">
          {created && <span className="font-mono tabular-nums">criada: {created}</span>}
          {updated && <span className="font-mono tabular-nums">atualizada: {updated}</span>}
          {completed && <span className="font-mono tabular-nums">concluída: {completed}</span>}
          <span>synth: {feature.synthMode}</span>
          {feature.model && <span>modelo: {feature.model}</span>}
        </div>

        {/* Vínculo real de OKR sobe pro header (Onda 2) — era o último bloco
            do doc, fora de vista; agora fica junto do StatusBadge. */}
        <FeatureObjectiveLinksSection
          featureId={feature.id}
          objectives={objectives}
          krTitles={krTitles}
          krToObjectiveId={krObjectiveId}
          openSignal={linkSignal}
        />
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading && !feature.body ? (
          <p className="text-sm text-[var(--color-text-dim)]">Carregando documento…</p>
        ) : (
          <>
            <article className="max-w-none text-sm leading-relaxed text-[var(--color-text)]">
              <MarkdownViewer content={split.main} />
            </article>

            {split.history && (
              <section className="mt-8">
                <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">History</h2>
                <ol className="flex flex-col gap-3 border-l border-[var(--color-border)] pl-4">
                  {historyEntries(split.history).map((entry, i) => (
                    <li key={i} className="relative text-xs text-[var(--color-text-dim)]">
                      <span
                        className="absolute -left-[21px] top-1 h-2 w-2 rounded-full"
                        style={{ background: 'var(--color-accent)' }}
                      />
                      <MarkdownViewer content={entry} />
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}

        <FeatureTasksSection featureId={feature.id} objectives={objectives} krTitles={krTitles} />

        <FeatureSessions
          featureId={feature.id}
          reposById={reposById}
          projectsById={projectsById}
        />
      </div>

      {workRepo && (
        <SpawnSessionDialog
          open
          onClose={() => setWorkRepo(null)}
          repo={workRepo}
          initialFeatureId={feature.id}
          onConfirm={(name, featureId, model, effort, permission, advisorModel, initialCommand) => {
            const project = projectsById.get(workRepo.projectId)
            void openSession(
              workRepo,
              project?.name ?? null,
              project?.icon ?? null,
              project?.color ?? null,
              undefined,
              featureId,
              name,
              initialCommand,
              model,
              effort,
              undefined,
              permission,
              advisorModel,
            )
            setWorkRepo(null)
            // Features e terminais são áreas exclusivas: trabalhar troca de tela.
            setArea('projects')
          }}
        />
      )}
    </div>
  )
}
