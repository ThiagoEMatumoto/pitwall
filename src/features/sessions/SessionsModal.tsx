import { useEffect, useMemo, useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { sessionsApi } from '@/lib/ipc'
import { relativeTime } from '@/lib/time'
import { useAppStore } from '@/store/appStore'
import { SessionFeatureChip } from './SessionFeatureChip'
import { SpawnSessionDialog } from './SpawnSessionDialog'
import type { Repo, SessionSummary } from '../../../shared/types/ipc'

interface Props {
  repo: Repo
  projectName: string
  projectIcon: string | null
  projectColor: string | null
  open: boolean
  onClose: () => void
}

type StatusFilter = 'all' | 'live' | 'ended'

const STATUS_DOT: Record<SessionSummary['status'], string> = {
  working: 'bg-[var(--color-success)]',
  waiting: 'bg-[var(--color-warning)]',
  idle: 'bg-[var(--color-accent)]',
  ended: 'bg-[var(--color-text-dim)]',
}

const STATUS_LABEL: Record<SessionSummary['status'], string> = {
  working: 'trabalhando',
  waiting: 'aguardando',
  idle: 'ocioso',
  ended: 'encerrada',
}

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'live', label: 'Ao vivo' },
  { id: 'ended', label: 'Encerradas' },
]

// Substring match case/acento-insensível (mesmo helper do switcher/palette).
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  if (!query) return true
  const q = normalize(query)
  return fields.some((f) => f && normalize(f).includes(q))
}

export function SessionsModal({
  repo,
  projectName,
  projectIcon,
  projectColor,
  open,
  onClose,
}: Props) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [spawnOpen, setSpawnOpen] = useState(false)
  const openSession = useAppStore((s) => s.openSession)
  const resumeSession = useAppStore((s) => s.resumeSession)

  useEffect(() => {
    if (!open) return
    setSessions(null)
    setQuery('')
    setFilter('all')
    void sessionsApi.listByRepo(repo.id).then(setSessions)
  }, [open, repo.id])

  const filtered = useMemo(() => {
    if (!sessions) return null
    const q = query.trim()
    // Busca cobre name + título persistido + label do repo — muitas sessões
    // antigas não têm name e ficavam inencontráveis.
    return sessions.filter((s) => {
      if (filter === 'live' && !s.isLive) return false
      if (filter === 'ended' && s.isLive) return false
      return matchesQuery(q, s.name, s.title, repo.label)
    })
  }, [sessions, query, filter, repo.label])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Sessões · ${repo.label}`}
    >
      <div className="mb-3 flex items-center gap-2">
        <Input
          placeholder="Buscar por nome…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button variant="primary" className="shrink-0" onClick={() => setSpawnOpen(true)}>
          + Nova
        </Button>
      </div>

      <SpawnSessionDialog
        open={spawnOpen}
        onClose={() => setSpawnOpen(false)}
        repo={repo}
        onConfirm={(name, featureId, model, effort, permission, advisorModel, initialCommand) => {
          void openSession(
            repo,
            projectName,
            projectIcon,
            projectColor,
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
          setSpawnOpen(false)
          onClose()
        }}
      />

      <div className="mb-3 flex items-center gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`rounded-md px-2 py-1 text-xs transition ${
              filter === f.id
                ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
                : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text)]'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="max-h-[24rem] overflow-y-auto">
        {filtered === null && (
          <div className="py-8 text-center text-xs text-[var(--color-text-dim)]">carregando…</div>
        )}

        {filtered !== null && filtered.length === 0 && (
          <div className="py-10 text-center text-sm text-[var(--color-text-dim)]">
            {sessions && sessions.length === 0
              ? 'Nenhuma sessão neste repo ainda.'
              : 'Nenhuma sessão corresponde ao filtro.'}
          </div>
        )}

        <ul className="flex flex-col gap-px">
          {filtered?.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-2.5 transition hover:bg-[var(--color-surface-2)]/60"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[s.status]} ${
                    s.isLive ? '' : 'opacity-40'
                  }`}
                  title={STATUS_LABEL[s.status]}
                />
                <div className="min-w-0">
                  <div className="truncate text-sm text-[var(--color-text)]">
                    {s.name || s.title || '(sem nome)'}
                  </div>
                  <div className="flex min-w-0 items-center gap-2 text-[10px] text-[var(--color-text-dim)]">
                    <span className="shrink-0">
                      {s.isLive ? STATUS_LABEL[s.status] : 'encerrada'} ·{' '}
                      {s.isLive ? 'ao vivo' : relativeTime(s.lastActivityAt)}
                    </span>
                    <SessionFeatureChip sessionId={s.id} featureId={s.featureId} density="chip" />
                  </div>
                </div>
              </div>
              <Button
                variant="ghost"
                className="shrink-0"
                onClick={() => {
                  void resumeSession(repo, projectName, projectIcon, projectColor, s.ccSessionId)
                  onClose()
                }}
              >
                Retomar
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  )
}
