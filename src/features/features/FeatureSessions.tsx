import { useEffect, useState } from 'react'
import { RotateCcw, SquareTerminal } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { sessionsApi } from '@/lib/ipc'
import { relativeTime } from '@/lib/time'
import { useAppStore } from '@/store/appStore'
import { orderWithMothers, sessionMoment, type FeatureSessionEntry } from './feature-sessions-api'
import type { FeatureSessionSummary, Project, Repo } from '../../../shared/types/ipc'

interface Props {
  featureId: string
  reposById: Map<string, Repo>
  projectsById: Map<string, Project>
}

// As sessões que trabalharam nesta feature, mais recente primeiro. Cada linha
// tem UMA ação: viva → focar (vai pra ela), morta → retomar (um clique, sem
// re-perguntar nada). É o outro lado do "Trabalhar nesta feature": o dossiê
// deixa de ser um beco sem saída.
export function FeatureSessions({ featureId, reposById, projectsById }: Props) {
  const [sessions, setSessions] = useState<FeatureSessionSummary[]>([])
  // Falha do IPC é estado próprio: dizer "nenhuma sessão" quando não deu pra
  // perguntar seria mentira.
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)

  const liveSessions = useAppStore((s) => s.liveSessions)
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const resumeSession = useAppStore((s) => s.resumeSession)
  const setArea = useAppStore((s) => s.setArea)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void sessionsApi
      .listByFeature(featureId)
      .then((list) => {
        if (!alive) return
        setFailed(false)
        setSessions([...list].sort((a, b) => sessionMoment(b) - sessionMoment(a)))
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setFailed(true)
        setSessions([])
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [featureId])

  function go(s: FeatureSessionSummary) {
    // Viva: a entrada do snapshot global carrega repo/projeto resolvidos, e o
    // focusOrOpenSession já re-attacha à PTY (sem subir um segundo claude).
    const live = s.ccSessionId
      ? liveSessions.find((l) => l.ccSessionId === s.ccSessionId)
      : undefined
    if (live) {
      void focusOrOpenSession(live)
      return
    }
    if (!s.ccSessionId) return
    const repo = (s.repoId ? reposById.get(s.repoId) : undefined) ?? null
    const project = repo ? projectsById.get(repo.projectId) : undefined
    void resumeSession(
      repo,
      project?.name ?? null,
      project?.icon ?? null,
      project?.color ?? null,
      s.ccSessionId,
    )
    // resumeSession só cria a pane; a troca de tela é do caller.
    setArea('projects')
  }

  if (loading) return null

  return (
    <section className="mt-8" data-testid="feature-sessions">
      <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Sessões</h2>
      {failed ? (
        <p className="text-xs text-[var(--color-text-dim)]">
          Não foi possível listar as sessões desta feature.
        </p>
      ) : sessions.length === 0 ? (
        <p className="text-xs text-[var(--color-text-dim)]">
          Nenhuma sessão trabalhou nesta feature ainda — use “Trabalhar nesta feature” para abrir a
          primeira.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {orderWithMothers(sessions).map((entry) => (
            <SessionRow
              key={entry.session.id}
              entry={entry}
              repoLabel={repoLabelOf(entry.session.repoId, reposById, projectsById)}
              onGo={() => go(entry.session)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

// Repo da sessão com o projeto: a feature junta repos de projetos diferentes.
function repoLabelOf(
  repoId: string | null,
  reposById: Map<string, Repo>,
  projectsById: Map<string, Project>,
): string | null {
  const repo = repoId ? reposById.get(repoId) : undefined
  if (!repo) return null
  const project = projectsById.get(repo.projectId)
  return project ? `${project.name} / ${repo.label}` : repo.label
}

function SessionRow({
  entry,
  repoLabel,
  onGo,
}: {
  entry: FeatureSessionEntry
  repoLabel: string | null
  onGo: () => void
}) {
  const { session, depth, childCount, motherTitle } = entry
  const alive = session.isLive
  // Sem cc_session_id não há transcript no disco: retomar é impossível e o botão
  // diz por quê em vez de sumir (ou pior, não fazer nada).
  const blocked = !alive && !session.ccSessionId
  return (
    <li
      data-testid="feature-session-row"
      data-depth={depth}
      className={`flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 ${depth ? 'ml-6' : ''}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 truncate text-xs text-[var(--color-text)]">
          {depth === 1 && <span className="text-[var(--color-text-dim)]">↳</span>}
          <span className="truncate">{session.title ?? 'sessão sem título'}</span>
          {childCount > 0 && (
            <span className="shrink-0 rounded-full border border-[var(--color-accent)] px-1.5 text-[10px] text-[var(--color-accent)]">
              mãe · {childCount} {childCount === 1 ? 'filha' : 'filhas'}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[10px] text-[var(--color-text-dim)]">
          {repoLabel && <span className="mr-1.5 font-mono">{repoLabel} ·</span>}
          {motherTitle && <span className="mr-1.5">filha de {motherTitle} ·</span>}
          {relativeTime(sessionMoment(session))}
          {alive && <span className="ml-1.5 text-[var(--color-success)]">· viva</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={onGo}
        disabled={blocked}
        data-testid="feature-session-action"
        data-action={alive ? 'focus' : 'resume'}
        title={
          blocked
            ? 'Sessão sem transcript no disco — não dá pra retomar'
            : alive
              ? 'Ir para esta sessão (ela continua rodando)'
              : 'Retomar esta sessão com o histórico dela'
        }
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text)] transition hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon as={alive ? SquareTerminal : RotateCcw} size={13} />
        {alive ? 'focar' : 'retomar'}
      </button>
    </li>
  )
}
