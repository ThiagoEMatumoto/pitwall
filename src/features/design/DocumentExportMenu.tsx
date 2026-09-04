import { useState } from 'react'
import { Download } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu, type MenuItem } from '@/components/ui/Menu'
import { api } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { useDesignStore } from '@/store/designStore'
import { MAX_PDF_PAGES } from '@shared/design/safety'

// Document-level export: one artboard is one page (PDF) or one file (PNG).
// The per-artboard export lives in the inspector; this one never asks which
// artboard is selected.

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/timed out/i.test(msg)) return 'A exportação demorou demais. Tente com menos artboards.'
  if (/exceed the limit/i.test(msg)) return `Máximo de ${MAX_PDF_PAGES} artboards por exportação.`
  if (/no artboards/i.test(msg)) return 'Não há artboards nessa seleção.'
  return msg
}

export function DocumentExportMenu() {
  const docId = useDesignStore((s) => s.docId)
  const pageId = useDesignStore((s) => s.pageId)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!docId) return null

  async function exportPdf(scope: { pageId?: string }): Promise<void> {
    if (!docId) return
    setBusy(true)
    try {
      const res = await api.design.pdfExport({ docId, ...scope })
      if (res.state === 'canceled') return
      showToast({
        title: 'PDF exportado',
        body: `${res.pages} ${res.pages === 1 ? 'página' : 'páginas'} · ${res.filePath}`,
        durationMs: 5000,
      })
    } catch (err) {
      showToast({ title: 'Falha ao exportar o PDF', body: friendlyError(err) })
    } finally {
      setBusy(false)
    }
  }

  async function exportPngs(scale: 1 | 2): Promise<void> {
    if (!docId) return
    setBusy(true)
    try {
      const res = await api.design.pngBatchExport({
        docId,
        ...(pageId ? { pageId } : {}),
        scale,
      })
      if (res.state === 'canceled') return
      showToast({
        title: `${res.files.length} PNGs exportados`,
        body: res.dirPath ?? undefined,
        durationMs: 5000,
      })
    } catch (err) {
      showToast({ title: 'Falha ao exportar os PNGs', body: friendlyError(err) })
    } finally {
      setBusy(false)
    }
  }

  const items: MenuItem[] = [
    {
      label: 'PDF — documento inteiro',
      onClick: () => void exportPdf({}),
    },
    {
      label: 'PDF — página atual',
      disabled: !pageId,
      onClick: () => void exportPdf(pageId ? { pageId } : {}),
    },
    { label: 'PNGs — página atual (1x)', onClick: () => void exportPngs(1) },
    { label: 'PNGs — página atual (2x)', onClick: () => void exportPngs(2) },
  ]

  return (
    <Menu open={open} onClose={() => setOpen(false)} portal items={items}>
      <button
        type="button"
        data-testid="design-export-doc"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        title="Exportar o documento (PDF multipágina ou PNGs)"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition disabled:opacity-40 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
      >
        <Icon as={Download} />
      </button>
    </Menu>
  )
}
