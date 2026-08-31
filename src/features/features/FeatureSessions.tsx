import { useEffect, useState } from 'react'
import { RotateCcw, SquareTerminal } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { relativeTime } from '@/lib/time'
import { useAppStore } from '@/store/appStore'
import {
  listSessionsByFeature,
  sessionMoment,
  type FeatureSessionInfo,
} from './feature-sessions-api'
import type { Project, Repo } from '../../../shared/types/ipc'

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
  const [sessions, setSessions] = useState<FeatureSessionInfo[]>([])
  // `null` do IPC = este build não sabe listar. Dizer "nenhuma sessão" aqui
  // seria mentira, então o estado é separado do vazio de verdade.
  const [unavailable, setUnavailable] = useState(false)
  const [loading, setLoading] = useState(true)

  const liveSessions = useAppStore((s) => s.liveSessions)
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const resumeSession = useAppStore((s) => s.resumeSession)
  const setArea = useAppStore((s) => s.setArea)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void listSessionsByFeature(featureId)
      .then((list) => {
        if (!alive) return
        setUnavailable(list === null)
        setSessions([...(list ?? [])].sort((a, b) => sessionMoment(b) - sessionMoment(a)))
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setUnavailable(true)
        setSessions([])
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [featureId])

  function go(s: FeatureSessionInfo) {
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
      {unavailable ? (
        <p className="text-xs text-[var(--color-text-dim)]">
          Não foi possível listar as sessões desta feature neste build.
        </p>
      ) : sessions.length === 0 ? (
        <p className="text-xs text-[var(--color-text-dim)]">
          Nenhuma sessão trabalhou nesta feature ainda — use “Trabalhar nesta feature” para abrir a
          primeira.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} onGo={() => go(s)} />
          ))}
        </ul>
      )}
    </section>
  )
}

function SessionRow({ session, onGo }: { session: FeatureSessionInfo; onGo: () => void }) {
  const alive = session.isAlive
  // Sem cc_session_id não há transcript no disco: retomar é impossível e o botão
  // diz por quê em vez de sumir (ou pior, não fazer nada).
  const blocked = !alive && !session.ccSessionId
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-xs text-[var(--color-text)]">
          {session.title ?? 'sessão sem título'}
        </div>
        <div className="mt-0.5 text-[10px] text-[var(--color-text-dim)]">
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
