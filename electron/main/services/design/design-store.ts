import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { MAX_GLOBAL_CSS_BYTES, MAX_TOKEN_KEYS } from '../../../../shared/design/safety'
import type {
  CreateDesignDocumentInput,
  CreateDesignPageInput,
  DesignDocument,
  DesignDocumentMeta,
  DesignDocumentStatus,
  DesignListFilter,
  DesignPage,
  DesignPageViewport,
  DesignTokens,
  UpdateDesignDocumentInput,
  UpdateDesignPageInput,
} from '../../../../shared/types/design'
import {
  DEFAULT_VIEWPORT,
  type DocumentRow,
  type PageRow,
  clampName,
  getDocumentRow,
  getPageRow,
  parseFonts,
  parseObject,
  touchDocument,
} from './design-rows'
import { listArtboards, listLinks } from './artboard-store'

// Design Studio store: documents and pages. Modelled on diagram-store: loose
// functions, snake_case rows ⇄ camelCase entities, `db.transaction` on
// compound mutations, JSON.parse always defensive.
//
// Artboards, versions and links live in artboard-store.ts and are re-exported
// here so callers keep a single `designStore` import.

export * from './artboard-store'
export { defaultTree } from './design-rows'

// ---- input limits (IPC and MCP both land here) ----

function assertDocumentLimits(input: { tokens?: DesignTokens; globalCss?: string }): void {
  if (input.globalCss !== undefined && Buffer.byteLength(input.globalCss) > MAX_GLOBAL_CSS_BYTES) {
    throw new Error(`globalCss exceeds ${MAX_GLOBAL_CSS_BYTES} bytes`)
  }
  for (const [category, values] of Object.entries(input.tokens ?? {})) {
    if (values && Object.keys(values).length > MAX_TOKEN_KEYS) {
      throw new Error(`tokens.${category} has more than ${MAX_TOKEN_KEYS} keys`)
    }
  }
}

// ---- rows <-> entities ----

function rowToMeta(row: DocumentRow): DesignDocumentMeta {
  return {
    id: row.id,
    title: row.title,
    status: row.status as DesignDocumentStatus,
    thumbnail: row.thumbnail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToDocument(row: DocumentRow): DesignDocument {
  return {
    ...rowToMeta(row),
    tokens: parseObject<DesignTokens>(row.tokens, {}),
    fonts: parseFonts(row.fonts),
    globalCss: row.global_css,
    pages: listPages(row.id),
    links: listLinks(row.id),
  }
}

function rowToPage(row: PageRow): DesignPage {
  return {
    id: row.id,
    documentId: row.document_id,
    name: row.name,
    position: row.position,
    viewport: parseObject<DesignPageViewport>(row.viewport, DEFAULT_VIEWPORT),
    artboards: listArtboards(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const INSERT_PAGE_SQL = `INSERT INTO design_pages
    (id, document_id, name, position, viewport, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`

// `%` and `_` are LIKE wildcards: a search for "100%" must not match everything.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// ---- documents ----

export function listDocuments(filter?: DesignListFilter): DesignDocumentMeta[] {
  const where: string[] = []
  const params: unknown[] = []

  const status = filter?.status ?? 'active'
  if (status !== 'all') {
    where.push('status = ?')
    params.push(status)
  }
  if (filter?.parentType || filter?.parentId) {
    const linkWhere: string[] = ['document_id = design_documents.id']
    if (filter.parentType) {
      linkWhere.push('parent_type = ?')
      params.push(filter.parentType)
    }
    if (filter.parentId) {
      linkWhere.push('parent_id = ?')
      params.push(filter.parentId)
    }
    where.push(`EXISTS (SELECT 1 FROM design_links WHERE ${linkWhere.join(' AND ')})`)
  }
  if (filter?.search?.trim()) {
    where.push("title LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(filter.search.trim())}%`)
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = getDb()
    .prepare(
      `SELECT id, title, status, thumbnail, created_at, updated_at
       FROM design_documents ${clause} ORDER BY updated_at DESC, title ASC`,
    )
    .all(...params) as DocumentRow[]
  return rows.map(rowToMeta)
}

export function getDocument(id: string): DesignDocument | null {
  const row = getDocumentRow(id)
  return row ? rowToDocument(row) : null
}

export function createDocument(input: CreateDesignDocumentInput): DesignDocument {
  assertDocumentLimits(input)
  const now = Date.now()
  const id = randomUUID()
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO design_documents
        (id, title, status, tokens, fonts, global_css, thumbnail, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, NULL, ?, ?)`,
    ).run(
      id,
      clampName(input.title),
      JSON.stringify(input.tokens ?? {}),
      JSON.stringify(input.fonts ?? []),
      input.globalCss ?? '',
      now,
      now,
    )
    db.prepare(INSERT_PAGE_SQL).run(
      randomUUID(),
      id,
      'Page 1',
      0,
      JSON.stringify(DEFAULT_VIEWPORT),
      now,
      now,
    )
    for (const link of input.links ?? []) {
      db.prepare(
        `INSERT OR IGNORE INTO design_links (document_id, parent_type, parent_id)
         VALUES (?, ?, ?)`,
      ).run(id, link.parentType, link.parentId)
    }
  })
  tx()
  return getDocument(id)!
}

export function updateDocument(input: UpdateDesignDocumentInput): DesignDocument {
  const row = getDocumentRow(input.id)
  if (!row) throw new Error(`design document not found: ${input.id}`)
  assertDocumentLimits(input)
  getDb()
    .prepare(
      `UPDATE design_documents
       SET title = ?, tokens = ?, fonts = ?, global_css = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      (input.title && clampName(input.title)) || row.title,
      input.tokens ? JSON.stringify(input.tokens) : row.tokens,
      input.fonts ? JSON.stringify(input.fonts) : row.fonts,
      input.globalCss ?? row.global_css,
      Date.now(),
      input.id,
    )
  return getDocument(input.id)!
}

export function archiveDocument(id: string): DesignDocument {
  return setStatus(id, 'archived')
}

export function unarchiveDocument(id: string): DesignDocument {
  return setStatus(id, 'active')
}

function setStatus(id: string, status: DesignDocumentStatus): DesignDocument {
  if (!getDocumentRow(id)) throw new Error(`design document not found: ${id}`)
  getDb()
    .prepare('UPDATE design_documents SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id)
  return getDocument(id)!
}

export function removeDocument(id: string): void {
  if (!getDocumentRow(id)) throw new Error(`design document not found: ${id}`)
  // Pages, artboards, versions, assets and links go with ON DELETE CASCADE.
  getDb().prepare('DELETE FROM design_documents WHERE id = ?').run(id)
}

// ---- pages ----

export function listPages(documentId: string): DesignPage[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM design_pages WHERE document_id = ? ORDER BY position ASC, created_at ASC',
    )
    .all(documentId) as PageRow[]
  return rows.map(rowToPage)
}

export function getPage(id: string): DesignPage | null {
  const row = getPageRow(id)
  return row ? rowToPage(row) : null
}

export function createPage(input: CreateDesignPageInput): DesignPage {
  if (!getDocumentRow(input.docId)) throw new Error(`design document not found: ${input.docId}`)
  const now = Date.now()
  const id = randomUUID()
  const db = getDb()
  const tx = db.transaction(() => {
    const position =
      input.position ??
      (
        db
          .prepare(
            'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM design_pages WHERE document_id = ?',
          )
          .get(input.docId) as { next: number }
      ).next
    db.prepare(INSERT_PAGE_SQL).run(
      id,
      input.docId,
      input.name.trim(),
      position,
      JSON.stringify(DEFAULT_VIEWPORT),
      now,
      now,
    )
    touchDocument(input.docId, now)
  })
  tx()
  return getPage(id)!
}

export function updatePage(input: UpdateDesignPageInput): DesignPage {
  const row = getPageRow(input.id)
  if (!row) throw new Error(`design page not found: ${input.id}`)
  const now = Date.now()
  getDb()
    .prepare(
      'UPDATE design_pages SET name = ?, position = ?, viewport = ?, updated_at = ? WHERE id = ?',
    )
    .run(
      input.name?.trim() || row.name,
      input.position ?? row.position,
      input.viewport ? JSON.stringify(input.viewport) : row.viewport,
      now,
      input.id,
    )
  return getPage(input.id)!
}

export function reorderPages(documentId: string, orderedIds: string[]): DesignPage[] {
  const db = getDb()
  const now = Date.now()
  const tx = db.transaction(() => {
    orderedIds.forEach((id, index) => {
      db.prepare(
        'UPDATE design_pages SET position = ?, updated_at = ? WHERE id = ? AND document_id = ?',
      ).run(index, now, id, documentId)
    })
    touchDocument(documentId, now)
  })
  tx()
  return listPages(documentId)
}

export function removePage(id: string): void {
  const row = getPageRow(id)
  if (!row) throw new Error(`design page not found: ${id}`)
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM design_pages WHERE id = ?').run(id)
    touchDocument(row.document_id, Date.now())
  })
  tx()
}
