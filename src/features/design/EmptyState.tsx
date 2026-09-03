import { useState } from 'react'
import { PenTool, Plus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { useDesignStore } from '@/store/designStore'
import { formatPresetSize, groupPresets } from './artboard-format'
import { AskClaudeComposer } from './ask-claude/AskClaudeComposer'

interface Props {
  variant: 'no-doc' | 'no-artboards'
}

const DEFAULT_DOC_TITLE = 'Sem título'
const PRESET_GROUPS = groupPresets()

export function EmptyState({ variant }: Props) {
  const createDoc = useDesignStore((s) => s.createDoc)
  const createArtboard = useDesignStore((s) => s.createArtboard)
  const setAskOpen = useDesignStore((s) => s.setAskOpen)
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
      // The composer docks to this container (CanvasHost is not mounted without a doc).
      <div className="relative flex h-full flex-1 items-center justify-center">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center text-sm text-[var(--color-text-dim)]">
          <Icon as={PenTool} size={32} />
          <span>
            Selecione um documento — ou peça ao Claude para criar um (ex.: “desenha a landing do
            produto”).
          </span>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button loading={busy} onClick={() => void run(() => createDoc(DEFAULT_DOC_TITLE))}>
              <Icon as={Plus} size={14} />
              Novo documento
            </Button>
            <Button variant="ghost" title="Ask Claude" onClick={() => setAskOpen(true)}>
              <Icon as={Sparkles} size={14} />
              Pedir ao Claude
            </Button>
          </div>
          {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
        </div>
        <AskClaudeComposer />
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-5 text-center text-sm text-[var(--color-text-dim)] shadow-lg">
      <span className="text-[var(--color-text)]">Este documento ainda não tem artboards.</span>
      <div className="flex flex-col items-center gap-2">
        {PRESET_GROUPS.map((group) => (
          <div key={group.group} className="flex flex-wrap items-center justify-center gap-2">
            <span className="w-14 text-right text-[10px] uppercase tracking-wider opacity-60">
              {group.label}
            </span>
            {group.presets.map((preset) => (
              <Button
                key={preset.id}
                variant="ghost"
                loading={busy}
                className="px-3 py-1 text-xs"
                onClick={() => void run(() => createArtboard(preset))}
              >
                <Icon as={Plus} size={13} />
                {preset.label}
                <span className="tabular-nums opacity-60">{formatPresetSize(preset)}</span>
              </Button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
