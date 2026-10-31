import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { useDesignStore } from '@/store/designStore'
import { customPreset } from '@shared/types/design'
import { ArtboardSizeDialog } from './ArtboardSizeDialog'
import { formatPresetSize, groupPresets } from './artboard-format'

const PRESET_GROUPS = groupPresets()

// A document with no artboards yet: pick a preset size to start.
export function EmptyState() {
  const createArtboard = useDesignStore((s) => s.createArtboard)
  const [busy, setBusy] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
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
      <Button variant="ghost" className="px-3 py-1 text-xs" onClick={() => setCustomOpen(true)}>
        <Icon as={Plus} size={13} />
        Personalizado…
      </Button>
      {customOpen && (
        <ArtboardSizeDialog
          title="Novo artboard"
          initial={{ width: 1440, height: 900 }}
          onClose={() => setCustomOpen(false)}
          onSubmit={(width, height) => void run(() => createArtboard(customPreset(width, height)))}
        />
      )}
    </div>
  )
}
