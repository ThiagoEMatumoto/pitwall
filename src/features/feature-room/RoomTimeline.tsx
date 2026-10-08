import type { RoomTimelineEvent } from '../../../shared/types/feature-room'
import { eventGlyph, sinceText, timelineVerb } from './room-labels'
import { Glyph, SectionHead } from './room-ui'

interface Props {
  events: RoomTimelineEvent[]
  filterName: string | null
  hasSessions: boolean
  nameOf: (e: RoomTimelineEvent) => string
  now: number
  onClearFilter: () => void
}

// handoff_events da feature, mais novo primeiro; filtrável por sessão.
export function RoomTimeline({
  events,
  filterName,
  hasSessions,
  nameOf,
  now,
  onClearFilter,
}: Props) {
  return (
    <section
      aria-labelledby="room-timeline-h"
      className="min-h-0 overflow-auto border-t border-[var(--color-border)] p-4"
    >
      <SectionHead id="room-timeline-h" title="Linha do tempo">
        {filterName ? (
          <button
            type="button"
            onClick={onClearFilter}
            data-testid="room-timeline-filter"
            aria-label={`Mostrar todas as sessões (filtro: só ${filterName})`}
            className="rounded-full border px-2 py-px text-[11.5px]"
            style={{
              color: 'var(--color-accent)',
              borderColor: 'color-mix(in srgb, var(--color-accent) 50%, transparent)',
            }}
          >
            só {filterName} ✕
          </button>
        ) : (
          hasSessions && (
            <span className="text-[12px] text-[var(--color-text-dim)]">
              todas as sessões · clique numa sessão para filtrar
            </span>
          )
        )}
      </SectionHead>
      <ul
        aria-labelledby="room-timeline-h"
        data-testid="room-timeline"
        className="m-0 list-none p-0"
      >
        {events.length === 0 ? (
          <li className="text-[12.5px] text-[var(--color-text-dim)]">
            Nada aconteceu ainda. Delegar, perguntar, falhar e retomar aparecem aqui, inclusive as
            falhas.
          </li>
        ) : (
          events.map((e) => (
            <li
              key={e.id}
              data-testid="room-timeline-event"
              className="flex items-center gap-2.5 border-b border-[var(--color-border)] py-[7px] text-[12.5px] last:border-b-0"
            >
              <Glyph shape={eventGlyph(e.event)} />
              <span className="min-w-0 flex-1 truncate">
                <b className="font-mono text-[12px] font-semibold">{nameOf(e)}</b> {timelineVerb(e)}
              </span>
              <span className="shrink-0 tabular-nums text-[11.5px] text-[var(--color-text-dim)]">
                {sinceText(e.at, now)}
              </span>
            </li>
          ))
        )}
      </ul>
    </section>
  )
}
