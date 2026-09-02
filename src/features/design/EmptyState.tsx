import { useState } from 'react'
import { PenTool, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { useDesignStore } from '@/store/designStore'
import { ARTBOARD_PRESETS } from '@shared/types/design'

interface Props {
  variant: 'no-doc' | 'no-artboards'
}

const DEFAULT_DOC_TITLE = 'Sem título'

export function EmptyState({ variant }: Props) {
  const createDoc = useDesignStore((s) => s.createDoc)
  const createArtboard = useDesignStore((s) => s.createArtboard)
  const error = useDesignStore((s) => s.error)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  if (variant === 'no-doc') {
    return (
      <div className="flex h-full flex-1 items-center justify-center">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center text-sm text-[var(--color-text-dim)]">
          <Icon as={PenTool} size={32} />
          <span>
            Selecione um documento — ou peça ao Claude para criar um (ex.: “desenha a landing do produto”).
          </span>
          <Button loading={busy} onClick={() => void run(() => createDoc(DEFAULT_DOC_TITLE))}>
            <Icon as={Plus} size={14} />
            Novo documento
          </Button>
          {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-5 text-center text-sm text-[var(--color-text-dim)] shadow-lg">
      <span className="text-[var(--color-text)]">Este documento ainda não tem artboards.</span>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {ARTBOARD_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            variant="ghost"
            loading={busy}
            className="px-3 py-1 text-xs"
            onClick={() => void run(() => createArtboard(preset))}
          >
            <Icon as={Plus} size={13} />
            {preset.label}
            <span className="tabular-nums opacity-60">
              {preset.width}×{preset.height}
            </span>
          </Button>
        ))}
      </div>
    </div>
  )
}
