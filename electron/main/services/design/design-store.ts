import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { newNodeId } from '../../../../shared/design/ids'
import { cloneWithNewIds } from '../../../../shared/design/ops'
import {
  MAX_GLOBAL_CSS_BYTES,
  MAX_NAME_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TOKEN_KEYS,
  clampArtboardSize,
} from '../../../../shared/design/safety'
import type {
  CreateDesignArtboardInput,
  CreateDesignDocumentInput,
  CreateDesignPageInput,
  DesignArtboard,
  DesignAuthor,
  DesignDocument,
  DesignDocumentMeta,
  DesignDocumentStatus,
  DesignFonts,
  DesignLink,
  DesignListFilter,
  DesignNode,
  DesignPage,
  DesignPageViewport,
  DesignParentType,
  DesignTokens,
  DesignVersion,
  DesignVersionMeta,
  DuplicateDesignArtboardInput,
  UpdateDesignDocumentInput,
  UpdateDesignPageInput,
} from '../../../../shared/types/design'

// Store do Design Studio. Molde de diagram-store: funções soltas, rows
// snake_case ⇄ entidades camelCase, `db.transaction` nas mutações compostas,
// JSON.parse sempre defensivo.
//
// Diferença chave em relação a diagramas: `setTree` bumpa `version` em TODA
// mutação (o cliente manda baseVersion e diverge = resync), e só grava linha
// em design_versions quando snapshot=true. Por isso versions têm lacunas e o
// cap de retenção é por contagem, não por `version <= head - 30`.

const MAX_SNAPSHOTS = 30

// ---- rows <-> entidades ----

interface DocumentRow {
  id: string
  title: string
  status: string
  tokens: string
  fonts: string
  global_css: string
  thumbnail: string | null
  created_at: number
  updated_at: number
}

interface PageRow {
  id: string
  document_id: string
  name: string
  position: number
  viewport: string
  created_at: number
  updated_at: number
}

interface ArtboardRow {
  id: string
  page_id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  tree: string
  version: number
  position: number
  created_at: number
  updated_at: number
}

interface VersionRow {
  id: string
  artboard_id: string
  version: number
  author: string
  summary: string
  tree: string
  created_at: number
}

interface LinkRow {
  document_id: string
  parent_type: string
  parent_id: string
}

const DEFAULT_VIEWPORT: DesignPageViewport = { x: 0, y: 0, zoom: 1 }

// ---- input limits (IPC and MCP both land here) ----

function clampName(name: string): string {
  return name.trim().slice(0, MAX_NAME_CHARS)
}

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

export function defaultTree(): DesignNode {
  return {
    id: newNodeId(),
    tag: 'div',
    kind: 'frame',
    name: 'Frame',
    style: {
      position: 'relative',
      width: '100%',
      height: '100%',
      background: '#ffffff',
    },
    attrs: {},
    children: [],
  }
}

function parseObject<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T
  } catch {
    // cai no fallback
  }
  return fallback
}

function parseTree(raw: string): DesignNode {
  const parsed = parseObject<Partial<DesignNode> | null>(raw, null)
  if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.children)) {
    return parsed as DesignNode
  }
  return defaultTree()
}

function parseFonts(raw: string): DesignFonts {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((f): f is string => typeof f === 'string')
  } catch {
    // cai no fallback
  }
  return []
}

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

function rowToArtboard(row: ArtboardRow): DesignArtboard {
  return {
    id: row.id,
    pageId: row.page_id,
    name: row.name,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    tree: parseTree(row.tree),
    version: row.version,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToVersionMeta(row: VersionRow): DesignVersionMeta {
  return {
    id: row.id,
    artboardId: row.artboard_id,
    version: row.version,
    author: row.author as DesignAuthor,
    summary: row.summary,
    createdAt: row.created_at,
  }
}

function rowToLink(row: LinkRow): DesignLink {
  return {
    documentId: row.document_id,
    parentType: row.parent_type as DesignParentType,
    parentId: row.parent_id,
  }
}

function getDocumentRow(id: string): DocumentRow | undefined {
  return getDb().prepare('SELECT * FROM design_documents WHERE id = ?').get(id) as
    DocumentRow | undefined
}

function getPageRow(id: string): PageRow | undefined {
  return getDb().prepare('SELECT * FROM design_pages WHERE id = ?').get(id) as PageRow | undefined
}

function getArtboardRow(id: string): ArtboardRow | undefined {
  return getDb().prepare('SELECT * FROM design_artboards WHERE id = ?').get(id) as
    ArtboardRow | undefined
}

function touchDocument(id: string, now: number): void {
  getDb().prepare('UPDATE design_documents SET updated_at = ? WHERE id = ?').run(now, id)
}

const INSERT_VERSION_SQL = `INSERT INTO design_versions
    (id, artboard_id, version, author, summary, tree, created_at)
   VALUES
    (@id, @artboard_id, @version, @author, @summary, @tree, @created_at)`

const INSERT_PAGE_SQL = `INSERT INTO design_pages
    (id, document_id, name, position, viewport, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`

// Retenção por contagem: versions têm lacunas (só snapshots geram linha),
// então "as 30 mais recentes" não é `version <= head - 30`.
function pruneVersions(artboardId: string): void {
  getDb()
    .prepare(
      `DELETE FROM design_versions WHERE artboard_id = ? AND id NOT IN (
         SELECT id FROM design_versions WHERE artboard_id = ?
         ORDER BY version DESC LIMIT ?
       )`,
    )
    .run(artboardId, artboardId, MAX_SNAPSHOTS)
}

// ---- documentos ----

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
    where.push('title LIKE ?')
    params.push(`%${filter.search.trim()}%`)
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
  // Páginas, artboards, versões, assets e links saem por ON DELETE CASCADE.
  getDb().prepare('DELETE FROM design_documents WHERE id = ?').run(id)
}

// Só o preview: não bumpa updated_at — thumbnail é derivado, não edição.
export function setThumbnail(id: string, dataUrl: string): void {
  getDb().prepare('UPDATE design_documents SET thumbnail = ? WHERE id = ?').run(dataUrl, id)
}

// ---- páginas ----

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

// ---- artboards (a cabeça) ----

export function listArtboards(pageId: string): DesignArtboard[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM design_artboards WHERE page_id = ? ORDER BY position ASC, created_at ASC',
    )
    .all(pageId) as ArtboardRow[]
  return rows.map(rowToArtboard)
}

export function getArtboard(id: string): DesignArtboard | null {
  const row = getArtboardRow(id)
  return row ? rowToArtboard(row) : null
}

// Broadcasts são por documento; o artboard só conhece a página.
export function getArtboardDocumentId(artboardId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT p.document_id AS document_id FROM design_artboards a
       JOIN design_pages p ON p.id = a.page_id WHERE a.id = ?`,
    )
    .get(artboardId) as { document_id: string } | undefined
  return row?.document_id ?? null
}

function insertArtboard(
  page: PageRow,
  fields: { name: string; x: number; y: number; width: number; height: number; tree: DesignNode },
  author: DesignAuthor,
  summary: string,
): string {
  const now = Date.now()
  const id = randomUUID()
  const treeJson = JSON.stringify(fields.tree)
  const db = getDb()
  // Cabeça e versão 1 na MESMA transação: artboard sem snapshot 1 não teria
  // pra onde ser restaurado.
  const tx = db.transaction(() => {
    const position = (
      db
        .prepare(
          'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM design_artboards WHERE page_id = ?',
        )
        .get(page.id) as { next: number }
    ).next
    db.prepare(
      `INSERT INTO design_artboards
        (id, page_id, name, x, y, width, height, tree, version, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      id,
      page.id,
      fields.name.trim(),
      fields.x,
      fields.y,
      fields.width,
      fields.height,
      treeJson,
      position,
      now,
      now,
    )
    db.prepare(INSERT_VERSION_SQL).run({
      id: randomUUID(),
      artboard_id: id,
      version: 1,
      author,
      summary,
      tree: treeJson,
      created_at: now,
    })
    touchDocument(page.document_id, now)
  })
  tx()
  return id
}

export function createArtboard(input: CreateDesignArtboardInput): DesignArtboard {
  const page = input.pageId
    ? getPageRow(input.pageId)
    : (getDb()
        .prepare(
          'SELECT * FROM design_pages WHERE document_id = ? ORDER BY position ASC, created_at ASC LIMIT 1',
        )
        .get(input.docId) as PageRow | undefined)
  if (!page) throw new Error(`design page not found for document ${input.docId}`)
  if (page.document_id !== input.docId) {
    throw new Error(`design page ${page.id} does not belong to document ${input.docId}`)
  }

  const id = insertArtboard(
    page,
    {
      name: clampName(input.name) || 'Artboard',
      x: input.x ?? 0,
      y: input.y ?? 0,
      width: clampArtboardSize(input.width),
      height: clampArtboardSize(input.height),
      tree: input.tree ?? defaultTree(),
    },
    input.author ?? 'human',
    'initial version',
  )
  return getArtboard(id)!
}

export function updateArtboard(
  id: string,
  patch: Partial<Pick<DesignArtboard, 'x' | 'y' | 'width' | 'height' | 'name' | 'position'>>,
): DesignArtboard {
  const row = getArtboardRow(id)
  if (!row) throw new Error(`design artboard not found: ${id}`)
  const now = Date.now()
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE design_artboards
       SET name = ?, x = ?, y = ?, width = ?, height = ?, position = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      (patch.name && clampName(patch.name)) || row.name,
      patch.x ?? row.x,
      patch.y ?? row.y,
      patch.width !== undefined ? clampArtboardSize(patch.width) : row.width,
      patch.height !== undefined ? clampArtboardSize(patch.height) : row.height,
      patch.position ?? row.position,
      now,
      id,
    )
    const docId = getArtboardDocumentId(id)
    if (docId) touchDocument(docId, now)
  })
  tx()
  return getArtboard(id)!
}

export function duplicateArtboard(input: DuplicateDesignArtboardInput): DesignArtboard {
  const row = getArtboardRow(input.artboardId)
  if (!row) throw new Error(`design artboard not found: ${input.artboardId}`)
  const page = getPageRow(row.page_id)!
  const id = insertArtboard(
    page,
    {
      name: input.name ?? `${row.name} copy`,
      // Default: à direita do original, com folga.
      x: input.x ?? row.x + row.width + 80,
      y: input.y ?? row.y,
      width: row.width,
      height: row.height,
      tree: cloneWithNewIds(parseTree(row.tree)).node,
    },
    'human',
    `duplicated from ${row.name}`,
  )
  return getArtboard(id)!
}

export function removeArtboard(id: string): void {
  if (!getArtboardRow(id)) throw new Error(`design artboard not found: ${id}`)
  const docId = getArtboardDocumentId(id)
  const db = getDb()
  const tx = db.transaction(() => {
    // Versões saem por ON DELETE CASCADE.
    db.prepare('DELETE FROM design_artboards WHERE id = ?').run(id)
    if (docId) touchDocument(docId, Date.now())
  })
  tx()
}

export interface SetTreeOptions {
  snapshot: boolean
  author: DesignAuthor
  summary?: string
}

// Único caminho de escrita da árvore. Sempre bumpa `version` (o cliente
// detecta divergência por ela); só snapshot=true grava histórico.
export function setTree(
  artboardId: string,
  tree: DesignNode,
  opts: SetTreeOptions,
): DesignArtboard {
  const row = getArtboardRow(artboardId)
  if (!row) throw new Error(`design artboard not found: ${artboardId}`)

  const now = Date.now()
  const treeJson = JSON.stringify(tree)
  const nextVersion = row.version + 1
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE design_artboards SET tree = ?, version = ?, updated_at = ? WHERE id = ?',
    ).run(treeJson, nextVersion, now, artboardId)
    if (opts.snapshot) {
      db.prepare(INSERT_VERSION_SQL).run({
        id: randomUUID(),
        artboard_id: artboardId,
        version: nextVersion,
        author: opts.author,
        summary: opts.summary?.trim().slice(0, MAX_SUMMARY_CHARS) || `version ${nextVersion}`,
        tree: treeJson,
        created_at: now,
      })
      pruneVersions(artboardId)
    }
    const docId = getArtboardDocumentId(artboardId)
    if (docId) touchDocument(docId, now)
  })
  tx()
  return getArtboard(artboardId)!
}

// ---- versões (o histórico) ----

export function listVersions(artboardId: string): DesignVersionMeta[] {
  // Sem `tree` no SELECT: histórico é lista leve, snapshot vem por getVersion.
  const rows = getDb()
    .prepare(
      `SELECT id, artboard_id, version, author, summary, created_at, '' AS tree
       FROM design_versions WHERE artboard_id = ? ORDER BY version DESC`,
    )
    .all(artboardId) as VersionRow[]
  return rows.map(rowToVersionMeta)
}

export function getVersion(artboardId: string, version: number): DesignVersion | null {
  const row = getDb()
    .prepare('SELECT * FROM design_versions WHERE artboard_id = ? AND version = ?')
    .get(artboardId, version) as VersionRow | undefined
  if (!row) return null
  return { ...rowToVersionMeta(row), tree: parseTree(row.tree) }
}

// Git-revert: copia o snapshot pra cabeça e grava versão NOVA apontando pra
// ela. Nunca apaga histórico — restaurar é um evento, não um rewind.
export function restoreVersion(
  artboardId: string,
  version: number,
  author: DesignAuthor,
): DesignArtboard {
  const snapshot = getVersion(artboardId, version)
  if (!snapshot) throw new Error(`design version not found: ${artboardId} v${version}`)
  return setTree(artboardId, snapshot.tree, {
    snapshot: true,
    author,
    summary: `restore version ${version}`,
  })
}

// ---- links ----

export function listLinks(documentId: string): DesignLink[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM design_links WHERE document_id = ? ORDER BY parent_type ASC, parent_id ASC',
    )
    .all(documentId) as LinkRow[]
  return rows.map(rowToLink)
}

export function link(input: DesignLink): DesignLink[] {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO design_links (document_id, parent_type, parent_id)
       VALUES (?, ?, ?)`,
    )
    .run(input.documentId, input.parentType, input.parentId)
  return listLinks(input.documentId)
}

export function unlink(input: DesignLink): DesignLink[] {
  getDb()
    .prepare('DELETE FROM design_links WHERE document_id = ? AND parent_type = ? AND parent_id = ?')
    .run(input.documentId, input.parentType, input.parentId)
  return listLinks(input.documentId)
}
