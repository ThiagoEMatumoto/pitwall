import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { cloneWithNewIds } from '../../../../shared/design/ops'
import { MAX_SUMMARY_CHARS, clampArtboardSize } from '../../../../shared/design/safety'
import type {
  CreateDesignArtboardInput,
  DesignArtboard,
  DesignAuthor,
  DesignLink,
  DesignNode,
  DesignVersion,
  DesignVersionMeta,
  DuplicateDesignArtboardInput,
} from '../../../../shared/types/design'
import {
  type ArtboardRow,
  type LinkRow,
  type PageRow,
  type VersionRow,
  clampName,
  defaultTree,
  getArtboardRow,
  getPageRow,
  parseTree,
  rowToArtboard,
  rowToLink,
  rowToVersionMeta,
  touchDocument,
} from './design-rows'

// Artboards (the head), versions (the history) and document links. Documents
// and pages live in design-store.ts, which re-exports everything here.
//
// `setTree` bumps `version` on EVERY mutation (the client sends baseVersion
// and a mismatch means resync) and only writes a design_versions row when
// snapshot=true. Versions therefore have gaps and retention is by count, not
// by `version <= head - N`.

// Claude names its versions; humans generate bursts. When the cap is hit the
// oldest human snapshots go first so the named milestones survive.
export const MAX_SNAPSHOTS = 50

const INSERT_VERSION_SQL = `INSERT INTO design_versions
    (id, artboard_id, version, author, summary, tree, created_at)
   VALUES
    (@id, @artboard_id, @version, @author, @summary, @tree, @created_at)`

function pruneVersions(artboardId: string): void {
  getDb()
    .prepare(
      `DELETE FROM design_versions WHERE artboard_id = ? AND id NOT IN (
         SELECT id FROM design_versions WHERE artboard_id = ?
         ORDER BY (author = 'claude') DESC, version DESC LIMIT ?
       )`,
    )
    .run(artboardId, artboardId, MAX_SNAPSHOTS)
}

// ---- artboards ----

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

// Broadcasts are per document; the artboard only knows its page.
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
  // Head and version 1 in the SAME transaction: an artboard without snapshot 1
  // would have nothing to restore to.
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
      // Default: to the right of the original, with a gap.
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
    // Versions go with ON DELETE CASCADE.
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

// The only write path for the tree. Always bumps `version` (the client detects
// divergence through it); only snapshot=true writes history.
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

// ---- versions (the history) ----

export function listVersions(artboardId: string): DesignVersionMeta[] {
  // No `tree` in the SELECT: the history is a light list, snapshots come through getVersion.
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

// Git-revert: copies the snapshot to the head and writes a NEW version pointing
// at it. Never deletes history — restoring is an event, not a rewind.
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
