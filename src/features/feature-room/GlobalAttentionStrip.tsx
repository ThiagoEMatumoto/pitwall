import { useCallback, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/ShortcutHints'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import type { AttentionItem } from '../../../shared/types/attention'
import type { SessionGraph } from '../../../shared/types/session-graph'
import { stripUnsafeDisplay } from '../../../shared/tui/permission-request'
import { CollapsedItem, OpenItem, type QueueSubject } from './QueueItem'
import { groupBySubject, type RoomQueueRow } from './room-model'
import { COMPACT } from './room-ui'

interface Props {
  needYou: AttentionItem[] // o MESMO array do AllMothers (humanQueue, uma vez)
  graph: SessionGraph
  featureTitleOf: (featureId: string | null) => string | null
  now: number
  onOpenRoom: (featureId: string) => void
}

// Faixa "Precisa de você" de todas as features. Cada sujeito é um item da fila da
// sala (QueueItem): aberto, ele tem as mesmas ações (Aprovar/Negar via
// AttentionMenuPanel, Responder, Ler). "Abrir sala" leva à feature do item.
export function GlobalAttentionStrip({ needYou, graph, featureTitleOf, now, onOpenRoom }: Props) {
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const liveSessions = useAppStore((s) => s.liveSessions)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const rows = useMemo(() => groupBySubject(needYou), [needYou])
  const open = rows.find((r) => r.subjectKey === openKey) ?? null

  const subjectOf = useCallback(
    (row: RoomQueueRow): QueueSubject => {
      const item = row.head
      const handoff = item.handoffId
        ? (handoffs.find((h) => h.id === item.handoffId) ?? null)
        : null
      const live = item.sessionId
        ? (liveSessions.find((s) => s.id === item.sessionId) ?? null)
        : null
      const node = item.sessionId ? graph.nodes.find((n) => n.sessionId === item.sessionId) : null
      return {
        who: stripUnsafeDisplay(
          node?.cliName ?? node?.title ?? handoff?.task ?? live?.title ?? live?.name ?? 'Sessão',
        ),
        repo: stripUnsafeDisplay(node?.repoLabel ?? handoff?.targetRepoLabel ?? ''),
        handoff,
        live,
      }
    },
    [handoffs, liveSessions, graph],
  )
  const featureOf = (row: RoomQueueRow): string | null => {
    const item = row.head
    if (item.featureId) return item.featureId
    const node = item.sessionId ? graph.nodes.find((n) => n.sessionId === item.sessionId) : null
    return node?.featureId ?? null
  }

  return (
    <section
      data-testid="all-mothers-strip"
      aria-label="Precisa de você em todas as features"
      className="flex shrink-0 flex-col gap-2 border-b border-[var(--color-border)] px-4 py-2.5"
    >
      <div className="flex items-center gap-2 text-[12.5px] font-semibold">
        Precisa de você
        <span
          data-testid="all-mothers-strip-count"
          className="rounded-full bg-[var(--color-surface-2)] px-1.5 text-[11px] tabular-nums"
        >
          {rows.length}
        </span>
        <span className="ml-auto flex items-center gap-1 text-[11.5px] font-normal text-[var(--color-text-dim)]">
          <Kbd>1</Kbd>–<Kbd>9</Kbd> foca tile · <Kbd>/</Kbd> escreve · <Kbd>Enter</Kbd> abre a sala
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-[12.5px] text-[var(--color-text-dim)]">
          Nada esperando você em nenhuma feature.
        </p>
      ) : (
        <ul role="list" className="m-0 flex list-none gap-2 overflow-x-auto p-0 pb-0.5">
          {rows.map((row) => {
            const featureId = featureOf(row)
            const title = featureTitleOf(featureId)
            return (
              <li
                key={row.subjectKey}
                data-testid="all-mothers-strip-item"
                className="flex w-[300px] shrink-0 flex-col gap-1"
              >
                <ul role="list" className="m-0 list-none p-0">
                  <CollapsedItem
                    row={row}
                    subject={subjectOf(row)}
                    now={now}
                    onOpen={() => setOpenKey(row.subjectKey === openKey ? null : row.subjectKey)}
                  />
                </ul>
                <div className="flex items-center gap-2 px-1 text-[11.5px] text-[var(--color-text-dim)]">
                  <span className="min-w-0 flex-1 truncate">
                    {title ? stripUnsafeDisplay(title) : 'Sem feature'}
                  </span>
                  {featureId && (
                    <Button
                      variant="ghost"
                      className={COMPACT}
                      data-testid="all-mothers-strip-open-room"
                      aria-label={`Abrir sala de ${subjectOf(row).who}`}
                      onClick={() => onOpenRoom(featureId)}
                    >
                      Abrir sala
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {open && (
        <ul role="list" className="m-0 max-h-[40vh] list-none overflow-auto p-0">
          <OpenItem
            row={open}
            subject={subjectOf(open)}
            now={now}
            hasNext={false}
            onNext={() => {}}
          />
        </ul>
      )}
    </section>
  )
}
