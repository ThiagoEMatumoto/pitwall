import { useMemo } from 'react'
import { Circle, Loader, Zap } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { relativeTime } from '@/lib/time'
import { useVisibleLiveSessions } from '@/features/session-switcher/useGlobalSessions'
import { useAppStore } from '@/store/appStore'
import { groupLiveSessions } from '../../../shared/home-selectors'
import type { LiveSessionInfo } from '../../../shared/types/ipc'
import { CardDot, CardEmpty, HomeCard } from './HomeGrid'

type Row = { item: LiveSessionInfo; kind: 'waiting' | 'working' | 'idle' }

// Card "Sessões agora" (design Pitwall): lista plana ordenada aguardando →
// trabalhando → ociosas. Aguardando ("sua vez") ganha destaque accent; as
// demais seguem a voz da casa (em pista / na garagem). São as sessões DELE —
// filhas de handoff vivem no Crew Dock (ver useVisibleLiveSessions); clique
// foca/re-attacha a pane.
export function SessionsCard() {
  const liveSessions = useVisibleLiveSessions()
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)

  const rows = useMemo<Row[]>(() => {
    const g = groupLiveSessions(liveSessions)
    return [
      ...g.waiting.map((item): Row => ({ item, kind: 'waiting' })),
      ...g.working.map((item): Row => ({ item, kind: 'working' })),
      ...g.idle.map((item): Row => ({ item, kind: 'idle' })),
    ]
  }, [liveSessions])

  return (
    <HomeCard
      title="Sessões agora"
      count={rows.length}
      dot={<CardDot color="var(--color-accent)" pulse={rows.some((r) => r.kind === 'waiting')} />}
    >
      {rows.length === 0 ? (
        <CardEmpty>Nenhuma sessão viva.</CardEmpty>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map(({ item, kind }) => (
            <li key={item.ccSessionId}>
              <SessionRow item={item} kind={kind} onOpen={() => void focusOrOpenSession(item)} />
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  )
}

function SessionRow({
  item,
  kind,
  onOpen,
}: {
  item: LiveSessionInfo
  kind: Row['kind']
  onOpen: () => void
}) {
  const title = (item.title ?? item.name ?? item.repo?.label) || (item.repo?.label ?? 'Avulsa')
  const waiting = kind === 'waiting'
  const idle = kind === 'idle'

  return (
    <button
      type="button"
      onClick={onOpen}
      title={item.lastText?.replace(/\s+/g, ' ').trim() || title}
      className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left transition hover:translate-x-[3px]"
      style={
        waiting
          ? {
              border: '1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)',
              background:
                'linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 12%, transparent), transparent)',
            }
          : { border: '1px solid transparent' }
      }
    >
      <Icon
        as={waiting ? Zap : kind === 'working' ? Loader : Circle}
        size={13}
        className={kind === 'working' ? 'shrink-0 animate-spin motion-reduce:animate-none' : 'shrink-0'}
        style={{
          color: waiting
            ? 'var(--color-accent)'
            : kind === 'working'
              ? 'var(--color-accent2)'
              : 'var(--color-text-dim)',
        }}
      />
      <span
        className="min-w-0 flex-1 truncate text-[13px] font-medium"
        style={{ color: idle ? 'var(--color-text-dim)' : 'var(--color-text)' }}
      >
        {title}
      </span>
      {item.projectName && (
        <span className="shrink-0 truncate font-mono text-[10px] text-[var(--color-text-dim)] max-w-24">
          {item.projectName}
        </span>
      )}
      {waiting ? (
        <span className="shrink-0 font-mono text-[10px] font-medium text-[var(--color-accent)]">
          sua vez
        </span>
      ) : idle ? (
        <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-dim)]">
          na garagem
        </span>
      ) : (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--color-text-dim)]">
          {relativeTime(item.lastActivityAt)}
        </span>
      )}
    </button>
  )
}
