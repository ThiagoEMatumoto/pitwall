import { useState } from 'react'
import { Code2, Download, FileCode2, Image } from 'lucide-react'
import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { api } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { useDesignStore } from '@/store/designStore'
import type { DesignExportFormat, DesignExportScale } from '@shared/types/design'
import { exceedsCaptureBudget, planCaptureTiles } from '@shared/design/capture-plan'
import { MAX_CAPTURE_PIXELS } from '@shared/design/safety'
import { Section } from '../controls/Section'

interface Props {
  artboardId: string
}

interface ExportButton {
  key: string
  label: string
  format: DesignExportFormat
  scale: DesignExportScale
  icon: ComponentType<LucideProps>
}

const BUTTONS: ExportButton[] = [
  { key: 'png1', label: 'PNG 1x', format: 'png', scale: 1, icon: Image },
  { key: 'png2', label: 'PNG 2x', format: 'png', scale: 2, icon: Image },
  { key: 'png3', label: 'PNG 3x', format: 'png', scale: 3, icon: Image },
  { key: 'png4', label: 'PNG 4x', format: 'png', scale: 4, icon: Image },
  { key: 'html', label: 'HTML', format: 'html', scale: 1, icon: FileCode2 },
  { key: 'jsx', label: 'JSX', format: 'jsx', scale: 1, icon: Code2 },
]

const BUDGET_MPX = Math.round(MAX_CAPTURE_PIXELS / 1_000_000)

// Same plan the main process runs; refusing here saves a round trip and a
// toast. For a flow artboard the height is the last one measured.
export function pngOverBudget(width: number, height: number, scale: DesignExportScale): boolean {
  return exceedsCaptureBudget(planCaptureTiles({ width, height, scale }))
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

function safeName(s: string): string {
  return (
    s
      .trim()
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'artboard'
  )
}

// <doc>-<artboard>@2x.png · <doc>-<artboard>.html · <doc>-<artboard>.jsx
export function exportFilename(
  doc: string,
  artboard: string,
  format: DesignExportFormat,
  scale: DesignExportScale,
): string {
  const base = `${safeName(doc)}-${safeName(artboard)}`
  if (format === 'png') return `${base}@${scale}x.png`
  return `${base}.${format}`
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/timeout/i.test(msg)) return 'A captura demorou demais. Tente de novo.'
  if (/not found/i.test(msg)) return 'O artboard não existe mais.'
  if (/budget/i.test(msg)) return `Acima do limite de ${BUDGET_MPX} Mpx. Use uma escala menor.`
  return msg
}

export function ExportSection({ artboardId }: Props) {
  const artboardName = useDesignStore((s) => s.artboards[artboardId]?.meta.name ?? 'artboard')
  const docTitle = useDesignStore((s) => s.doc?.title ?? 'design')
  const width = useDesignStore((s) => s.artboards[artboardId]?.meta.width ?? 0)
  const height = useDesignStore((s) => s.artboards[artboardId]?.meta.height ?? 0)
  const [busy, setBusy] = useState<string | null>(null)

  async function run(b: ExportButton): Promise<void> {
    setBusy(b.key)
    const filename = exportFilename(docTitle, artboardName, b.format, b.scale)
    try {
      const result = await api.design.export({
        artboardId,
        format: b.format,
        scale: b.scale,
      })
      const blob =
        b.format === 'png'
          ? new Blob([base64ToBytes(result.data)], { type: 'image/png' })
          : new Blob([result.data], {
              type: b.format === 'jsx' ? 'text/jsx' : 'text/html',
            })
      download(blob, filename)
      showToast({
        title: `Exportado ${filename}`,
        body: b.format === 'png' ? `${result.width}×${result.height}px` : undefined,
        durationMs: 3000,
      })
    } catch (err) {
      showToast({
        title: `Falha ao exportar ${b.label}`,
        body: friendlyError(err),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Exportar" defaultOpen={false}>
      <div className="grid grid-cols-2 gap-1">
        {BUTTONS.map((b) => {
          const running = busy === b.key
          const overBudget = b.format === 'png' && pngOverBudget(width, height, b.scale)
          const title = overBudget
            ? `${b.label} passa de ${BUDGET_MPX} Mpx (${width}×${height} @${b.scale}x). Use uma escala menor.`
            : exportFilename(docTitle, artboardName, b.format, b.scale)
          return (
            <button
              key={b.key}
              type="button"
              disabled={busy != null || overBudget}
              aria-busy={running}
              aria-disabled={overBudget || undefined}
              onClick={() => void run(b)}
              title={title}
              className="flex h-6 items-center justify-center gap-1 rounded-md border border-[var(--color-border)] text-[11px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)]/60 hover:text-[var(--color-text)] disabled:opacity-50"
            >
              {running ? (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Icon as={b.icon} size={12} />
              )}
              {running ? 'Exportando…' : b.label}
            </button>
          )
        })}
      </div>
      <p className="flex items-center gap-1 text-[10px] text-[var(--color-text-dim)]">
        <Icon as={Download} size={10} />
        HTML sai standalone (assets embutidos); JSX usa style inline.
      </p>
    </Section>
  )
}
