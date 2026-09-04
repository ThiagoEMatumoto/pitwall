import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as designStore from './design-store'
import { exportArtboardPng } from './export'
import { exportArtboardsPdf, type PdfExportResult } from './pdf'
import { orderArtboardsSpatially } from './artboard-order'
import { MAX_PDF_PAGES } from '../../../../shared/design/safety'
import type {
  DesignArtboard,
  DesignDocument,
  DesignExportScale,
} from '../../../../shared/types/design'

// Document-level exports: one artboard is one page (PDF) or one file (PNG
// batch). Both take the same scope and walk the artboards in the same reading
// order, so page 3 of the PDF and 03-*.png are the same artboard.

export interface DesignExportScope {
  docId: string
  // Ignored when artboardIds is given.
  pageId?: string
  // Highest precedence: exactly these artboards, in reading order.
  artboardIds?: string[]
}

export interface SelectedArtboards {
  doc: DesignDocument
  artboards: DesignArtboard[]
}

export function selectArtboards(scope: DesignExportScope): SelectedArtboards {
  const doc = designStore.getDocument(scope.docId)
  if (!doc) throw new Error(`design document not found: ${scope.docId}`)

  let artboards: DesignArtboard[]
  if (scope.artboardIds && scope.artboardIds.length > 0) {
    const wanted = new Set(scope.artboardIds)
    artboards = doc.pages.flatMap((p) => p.artboards.filter((a) => wanted.has(a.id)))
    const missing = scope.artboardIds.filter((id) => !artboards.some((a) => a.id === id))
    if (missing.length > 0) throw new Error(`design artboard not found: ${missing.join(', ')}`)
  } else if (scope.pageId) {
    const page = doc.pages.find((p) => p.id === scope.pageId)
    if (!page) throw new Error(`design page not found: ${scope.pageId}`)
    artboards = [...page.artboards]
  } else {
    artboards = doc.pages.flatMap((p) => p.artboards)
  }

  if (artboards.length === 0) throw new Error('design export: no artboards in this selection')
  if (artboards.length > MAX_PDF_PAGES) {
    throw new Error(
      `design export: ${artboards.length} artboards exceed the limit of ${MAX_PDF_PAGES}`,
    )
  }
  return { doc, artboards: orderArtboardsSpatially(artboards) }
}

export interface DocumentPdfResult extends PdfExportResult {
  doc: DesignDocument
  artboards: number
}

export async function exportDocumentPdf(scope: DesignExportScope): Promise<DocumentPdfResult> {
  const { doc, artboards } = selectArtboards(scope)
  const result = await exportArtboardsPdf(
    artboards.map((a) => ({
      artboardId: a.id,
      docId: doc.id,
      width: a.width,
      height: a.height,
      sizing: a.sizing,
    })),
  )
  return { ...result, doc, artboards: artboards.length }
}

export function fileSafeName(name: string, fallback: string): string {
  return (
    name
      .trim()
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  )
}

export interface PngBatchInput extends DesignExportScope {
  dir: string
  scale?: DesignExportScale
}

// Written one by one into a directory the human picked: holding every PNG in
// memory buys nothing when the files are going straight to disk.
export async function exportDocumentPngs(input: PngBatchInput): Promise<string[]> {
  const { artboards } = selectArtboards(input)
  const files: string[] = []
  for (const [index, artboard] of artboards.entries()) {
    const png = await exportArtboardPng({ artboardId: artboard.id, scale: input.scale ?? 1 })
    const name = `${String(index + 1).padStart(2, '0')}-${fileSafeName(artboard.name, 'artboard')}.png`
    await writeFile(join(input.dir, name), Buffer.from(png.pngBase64, 'base64'))
    files.push(name)
  }
  return files
}
