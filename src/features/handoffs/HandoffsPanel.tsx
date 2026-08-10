import { useMemo } from 'react'
import { RefreshCw } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useHandoffsStore } from '@/store/handoffsStore'
import { HandoffCard, StatusBadge, useHeartbeatTtl } from './HandoffCard'
import type { HandoffStatus } from '../../../shared/types/ipc'

// Inbox de handoffs cross-repo: lista todos agrupados por status. O corpo do card
// (identidade da filha, estado ao vivo, resposta in-place) vive em HandoffCard,
// compartilhado com o Crew Dock. A assinatura load+watch já é montada pelo
// useHandoffs() no AppShell; aqui só lemos do store.

// Ordem de agrupamento/exibição: ativos primeiro, recuperáveis no meio, terminais
// depois. interrupted fica antes dos terminais (pede ação: retomar).
const STATUS_ORDER: HandoffStatus[] = [
  'pending',
  'approved',
  'running',
  'needs_input',
  'interrupted',
  'done',
  'failed',
  'rejected',
]

export function HandoffsPanel() {
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const loading = useHandoffsStore((s) => s.loading)
  const load = useHandoffsStore((s) => s.load)
  const ttlHours = useHeartbeatTtl()

  // Agrupa por status na ordem ativos → terminais; cada grupo já vem ordenado
  // por createdAt DESC do store.
  const groups = useMemo(() => {
    return STATUS_ORDER.map((status) => ({
      status,
      items: handoffs.filter((h) => h.status === status),
    })).filter((g) => g.items.length > 0)
  }, [handoffs])

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--color-text)]">Handoffs</h1>
          <p className="text-xs text-[var(--color-text-dim)]">
            Delegações cross-repo entre sessões.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          title="Recarregar"
          className="rounded-md p-1.5 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={RefreshCw} size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {handoffs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-dim)]">
            {loading ? 'Carregando…' : 'Nenhum handoff ainda.'}
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-6">
            {groups.map((group) => (
              <section key={group.status}>
                <div className="mb-2 flex items-center gap-2">
                  <StatusBadge status={group.status} />
                  <span className="font-mono text-xs tabular-nums text-[var(--color-text-dim)]">
                    {group.items.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  {group.items.map((h) => (
                    <HandoffCard key={h.id} handoff={h} ttlHours={ttlHours} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
