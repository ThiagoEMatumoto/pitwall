import { useEffect, useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'
import { Menu } from '@/components/ui/Menu'
import { prefsApi } from '@/lib/ipc'
import type { Meeting } from '../../../shared/types/ipc'

export const SUMMARY_MODEL_PREF = 'meeting_summary_model'
export const SUMMARY_MODEL_OPTIONS = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
] as const
type SummaryModelId = (typeof SUMMARY_MODEL_OPTIONS)[number]['id']

interface Props {
  meeting: Meeting
  onResummarize: () => void
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <p className="text-sm text-[var(--color-text-dim)]">Gerando resumo…</p>
      {[92, 70, 84, 55].map((w) => (
        <div key={w} className="h-3 animate-pulse rounded bg-[var(--color-surface-2)]" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}

export function SummaryView({ meeting, onResummarize }: Props) {
  const processing = meeting.status === 'processing'
  const [menuOpen, setMenuOpen] = useState(false)
  const [model, setModel] = useState<SummaryModelId>('sonnet')

  useEffect(() => {
    void prefsApi.get<string>(SUMMARY_MODEL_PREF).then((v) => {
      if (v === 'opus' || v === 'sonnet') setModel(v)
    })
  }, [])

  // Grava a pref antes de regenerar: o main lê meeting_summary_model na hora de chamar o claude.
  const regenerateWith = async (next: SummaryModelId) => {
    setModel(next)
    await prefsApi.set(SUMMARY_MODEL_PREF, next)
    onResummarize()
  }

  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-dim)]">
          Resumo
          {meeting.summaryModel && meeting.summaryModel !== 'none' && (
            <span className="ml-2 normal-case tracking-normal opacity-70">· {meeting.summaryModel}</span>
          )}
        </h3>
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          sections={[
            {
              title: 'Regenerar com',
              items: SUMMARY_MODEL_OPTIONS.map((opt) => ({
                label: opt.label,
                active: opt.id === model,
                onClick: () => void regenerateWith(opt.id),
              })),
            },
          ]}
        >
          <Button
            variant="ghost"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={processing}
            className="!px-3 !py-1 !text-xs"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Icon as={RefreshCw} size={13} />
            Regenerar
            <Icon as={ChevronDown} size={12} />
          </Button>
        </Menu>
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
