import { useMemo } from 'react'
import { Circle, Loader, Zap } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { relativeTime } from '@/lib/time'
import {
  countWithCrew,
  crewOnlyLabel,
  useCrewOnlyCount,
  useVisibleLiveSessions,
} from '@/features/session-switcher/useGlobalSessions'
import { useAppStore } from '@/store/appStore'
import { motherOfChildMap, nestUnderMothers } from '@/features/sessions/conversation-hierarchy'
import { useSessionGraphStore } from '@/features/sessions/session-graph-store'
import { groupLiveSessions } from '../../../shared/home-selectors'
import type { LiveSessionInfo } from '../../../shared/types/ipc'
import { CardDot, CardEmpty, HomeCard } from './HomeGrid'
import { liveSessionLabel } from '@/features/session-switcher/session-label'

type Row = { item: LiveSessionInfo; kind: 'waiting' | 'working' | 'idle'; depth: number }

// Card "Sessões agora" (design Pitwall): lista ordenada aguardando →
// trabalhando → ociosas. Aguardando ("sua vez") ganha destaque accent; as
// demais seguem a voz da casa (em pista / na garagem). São as sessões DELE —
// filhas de handoff vivem no Crew Dock (ver useVisibleLiveSessions); clique
// foca/re-attacha a pane.
export function SessionsCard() {
  const liveSessions = useVisibleLiveSessions()
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)

  const graph = useSessionGraphStore((s) => s.graph)

  // Raízes por status (aguardando → trabalhando → ociosas); cada filha logo abaixo
  // da mãe, pela régua única por conversa.
  const rows = useMemo<Row[]>(() => {
    const g = groupLiveSessions(liveSessions)
    const kindOf = new Map<string, Row['kind']>([
      ...g.waiting.map((s) => [s.id, 'waiting'] as const),
      ...g.working.map((s) => [s.id, 'working'] as const),
      ...g.idle.map((s) => [s.id, 'idle'] as const),
    ])
    const flat = [...g.waiting, ...g.working, ...g.idle]
    return nestUnderMothers(flat, motherOfChildMap(graph.nodes)).map(({ item, depth }) => ({
      item,
      depth,
      kind: kindOf.get(item.id) ?? 'idle',
    }))
  }, [liveSessions, graph])

  const crewCount = useCrewOnlyCount()
  const crew = crewOnlyLabel(crewCount)
  return (
    <HomeCard
      title="Sessões agora"
      count={countWithCrew(rows.length, crewCount, false)}
      dot={<CardDot color="var(--color-accent)" pulse={rows.some((r) => r.kind === 'waiting')} />}
      action={
        crew && (
          <span
            data-testid="home-sessions-crew"
            title="Filhas de handoff: entram no total, mas ficam na Equipe (Ctrl+J), fora desta lista."
            className="text-[10px] text-[var(--color-text-dim)]"
          >
            {crew}
          </span>
        )
      }
    >
      {rows.length === 0 ? (
        <CardEmpty>Nenhuma sessão viva.</CardEmpty>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map(({ item, kind, depth }) => (
            <li key={item.ccSessionId} style={depth ? { paddingLeft: depth * 16 } : undefined}>
              <SessionRow
                item={item}
                kind={kind}
                nested={depth > 0}
                onOpen={() => void focusOrOpenSession(item)}
              />
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
  nested = false,
  onOpen,
}: {
  item: LiveSessionInfo
  kind: Row['kind']
  nested?: boolean
  onOpen: () => void
}) {
  const title = liveSessionLabel(item)
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
      {nested && (
        <span
          data-testid="home-session-nested"
          aria-hidden
          title="Filha da sessão acima"
          className="-mr-1 shrink-0 text-[11px] text-[var(--color-text-dim)]"
        >
          ↳
        </span>
      )}
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
