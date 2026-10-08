import { useMemo, useRef } from 'react'
import { useAppStore } from '@/store/appStore'
import { cycleAttention, getAttentionQueue } from '@/features/session-switcher/useAttentionQueue'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { TONE_COLOR, indicatorFor, mapCounters, type IndicatorTone } from './card-indicator'
import { useCardViewStore } from './card-view-store'
import { tailText } from './card-tail'
import { useMapLive } from './map-live'
import { plural } from './MapChrome'

type CountedTone = Extract<IndicatorTone, 'working' | 'needs-you' | 'done'>

const STYLE: Record<CountedTone, { color: string; label: (n: number) => string }> = {
  working: { color: TONE_COLOR.working, label: () => 'trabalhando' },
  'needs-you': {
    color: TONE_COLOR['needs-you'],
    label: (n) => plural(n, 'precisa de você', 'precisam de você'),
  },
  done: { color: TONE_COLOR.done, label: (n) => plural(n, 'pronta', 'prontas') },
}

const ORDER: CountedTone[] = ['needs-you', 'working', 'done']

// "3 trabalhando · 1 precisa de você · 2 prontas" na barra do mapa. Componente
// à parte porque assina a saída ao vivo (tails) — no SessionMap, cada tela nova
// re-renderizaria o mapa inteiro. Clique: "precisa de você" anda pela fila de
// atenção (o SessionMap centraliza pelo flash); os outros, pelos cartões.
// needsYou vem da fila única recortada pelo escopo (scopeAttentionCount), não dos
// cartões: a filha falhada/interrompida não tem PTY e não desenha cartão.
export function MapStatusCounters({
  nodes,
  needsYou,
  projectScope,
  onCenter,
}: {
  nodes: SessionGraphNode[]
  needsYou: number
  projectScope: boolean
  onCenter: (sessionId: string) => void
}) {
  const liveSessions = useAppStore((s) => s.liveSessions)
  const tails = useCardViewStore((s) => s.tails)
  const { workingSince } = useMapLive()
  const cursor = useRef<Record<string, number>>({})

  const byTone = useMemo(() => {
    const live = new Map(liveSessions.map((s) => [s.id, s]))
    return nodes.map((n) => {
      const tail = tails[n.sessionId]
      const ind = indicatorFor(
        n,
        live.get(n.sessionId),
        workingSince.get(n.sessionId) ?? null,
        tail ? tailText(tail.lines) : null,
      )
      return { sessionId: n.sessionId, tone: ind.tone }
    })
  }, [nodes, liveSessions, tails, workingSince])
  const counters = mapCounters(byTone.map((t) => t.tone))
  const count: Record<CountedTone, number> = {
    working: counters.working,
    'needs-you': needsYou,
    done: counters.done,
  }

  function pick(tone: CountedTone) {
    if (tone === 'needs-you') {
      cycleAttention(getAttentionQueue(), 1)
      return
    }
    const ids = byTone.filter((t) => t.tone === tone).map((t) => t.sessionId)
    if (ids.length === 0) return
    const i = ((cursor.current[tone] ?? -1) + 1) % ids.length
    cursor.current[tone] = i
    onCenter(ids[i])
  }

  const shown = ORDER.filter((t) => count[t] > 0)
  if (shown.length === 0) return null
  return (
    <div
      data-testid="map-status-counters"
      className="pointer-events-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-[12px] shadow-lg"
    >
      {shown.map((tone, i) => (
        <span key={tone} className="flex items-center gap-1">
          {i > 0 && <span className="text-[var(--color-text-dim)]">·</span>}
          <button
            type="button"
            data-testid={`map-count-${tone}`}
            onClick={() => pick(tone)}
            title={
              tone === 'needs-you'
                ? projectScope
                  ? 'Conta só este projeto. Ir para a próxima que espera você (Alt+A)'
                  : 'Conta todas as features. Ir para a próxima que espera você (Alt+A)'
                : 'Centralizar a próxima'
            }
            className="flex items-center gap-1 rounded-full px-2 py-0.5 transition hover:bg-[var(--color-surface-2)]"
            style={{ color: STYLE[tone].color }}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${tone === 'needs-you' ? 'pw-pulse' : ''}`}
              style={{ background: STYLE[tone].color }}
            />
            <span className="font-semibold tabular-nums">{count[tone]}</span>
            <span>{STYLE[tone].label(count[tone])}</span>
          </button>
        </span>
      ))}
    </div>
  )
}
