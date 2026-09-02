import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'
import type { Meeting } from '../../../shared/types/ipc'

interface Props {
  meeting: Meeting
  onResummarize: () => void
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <p className="text-sm text-[var(--color-text-dim)]">Gerando resumo…</p>
      {[92, 70, 84, 55].map((w) => (
        <div
          key={w}
          className="h-3 animate-pulse rounded bg-[var(--color-surface-2)]"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

export function SummaryView({ meeting, onResummarize }: Props) {
  const processing = meeting.status === 'processing'
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">Resumo</h3>
        <Button variant="ghost" onClick={onResummarize} disabled={processing} className="!px-3 !py-1 !text-xs">
          <Icon as={RefreshCw} size={13} />
          Regenerar
        </Button>
      </header>
      {processing ? (
        <Skeleton />
      ) : meeting.status === 'error' ? (
        <p className="text-sm text-[var(--color-danger)]">{meeting.error ?? 'Falha ao gerar o resumo.'}</p>
      ) : meeting.summaryMd ? (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <MarkdownViewer content={meeting.summaryMd} />
        </div>
      ) : (
        <p className="text-sm text-[var(--color-text-dim)]">Sem resumo.</p>
      )}
    </section>
  )
}
