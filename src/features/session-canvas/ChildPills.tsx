import { useAppStore } from '@/store/appStore'
import type { SessionGraph } from '../../../shared/types/session-graph'
import { TONE_COLOR, indicatorFor, indicatorText } from './card-indicator'
import { cardTitle } from './card-display'
import { useMapLive } from './map-live'

// As filhas da mãe do painel numa barra de pílulas no rodapé dele (a pill bar da
// agent view do Warp): o estado de cada uma à vista sem tirar o olho da mãe.
// Clique centraliza o cartão dela no mapa; duplo clique ou Enter abre a janela
// grande (o lift) — ao fechar, o painel segue com a mesma PTY e o mesmo buffer.
export function ChildPills({
  graph,
  motherId,
  inUse,
  onCenter,
  onOpen,
}: {
  graph: SessionGraph
  motherId: string
  inUse: ReadonlySet<string>
  onCenter: (sessionId: string) => void
  onOpen: (sessionId: string) => void
}) {
  const liveSessions = useAppStore((s) => s.liveSessions)
  const { now, workingSince } = useMapLive()
  const ids = graph.edges.flatMap((e) =>
    e.kind === 'handoff' && e.from === motherId && inUse.has(e.to) ? [e.to] : [],
  )
  const children = ids
    .map((id) => graph.nodes.find((n) => n.sessionId === id))
    .filter((n): n is NonNullable<typeof n> => !!n)
  if (children.length === 0) return null
  return (
    <nav
      data-testid="child-pills"
      aria-label="Filhas da mãe"
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2"
    >
      {children.map((n) => {
        const live = liveSessions.find((x) => x.id === n.sessionId)
        const ind = indicatorFor(n, live, workingSince.get(n.sessionId) ?? null, null)
        const title = cardTitle(n)
        const state = indicatorText(ind, now)
        return (
          <button
            key={n.sessionId}
            type="button"
            data-testid="child-pill"
            data-session-id={n.sessionId}
            data-tone={ind.tone}
            title={`${title} · ${state} — clique centraliza, duplo clique ou Enter abre`}
            onClick={() => onCenter(n.sessionId)}
            onDoubleClick={() => onOpen(n.sessionId)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              onOpen(n.sessionId)
            }}
            className="flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-[12px] text-[var(--color-text)] transition hover:border-[var(--color-accent)]"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: TONE_COLOR[ind.tone] }}
              aria-hidden
            />
            <span className="min-w-0 truncate">{title}</span>
            <span className="sr-only">{state}</span>
          </button>
        )
      })}
    </nav>
  )
}
