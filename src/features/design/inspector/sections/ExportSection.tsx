import { useState } from 'react'
import { Download } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { api } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { useDesignStore } from '@/store/designStore'
import type { DesignExportFormat } from '@shared/types/design'
import { Section } from '../controls/Section'

interface Props {
  artboardId: string
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // Revoking synchronously would cancel the download in Chromium.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ExportSection({ artboardId }: Props) {
  const name = useDesignStore((s) => s.artboards[artboardId]?.meta.name ?? 'artboard')
  const [busy, setBusy] = useState<string | null>(null)

  async function run(format: DesignExportFormat, scale: 1 | 2 = 1): Promise<void> {
    const key = `${format}${scale}`
    setBusy(key)
    try {
      const result = await api.design.export({ artboardId, format, scale })
      const safe = name.replace(/[^\w.-]+/g, '_')
      if (format === 'png') {
        download(new Blob([base64ToBytes(result.data)], { type: 'image/png' }), `${safe}@${scale}x.png`)
      } else {
        download(new Blob([result.data], { type: 'text/html' }), `${safe}.${format === 'jsx' ? 'jsx' : 'html'}`)
      }
    } catch (err) {
      showToast({ title: `Falha ao exportar: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setBusy(null)
    }
  }

  const buttons: Array<{ key: string; label: string; format: DesignExportFormat; scale?: 1 | 2 }> = [
    { key: 'png1', label: 'PNG 1x', format: 'png', scale: 1 },
    { key: 'png2', label: 'PNG 2x', format: 'png', scale: 2 },
    { key: 'html1', label: 'HTML', format: 'html' },
  ]

  return (
    <Section title="Exportar" defaultOpen={false}>
      <div className="flex gap-1">
        {buttons.map((b) => (
          <button
            key={b.key}
            type="button"
            disabled={busy != null}
            onClick={() => void run(b.format, b.scale)}
            className="flex h-6 flex-1 items-center justify-center gap-1 rounded-md border border-[var(--color-border)] text-[11px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)] disabled:opacity-50"
          >
            <Icon as={Download} size={12} />
            {busy === b.key ? '…' : b.label}
          </button>
        ))}
      </div>
    </Section>
  )
}
