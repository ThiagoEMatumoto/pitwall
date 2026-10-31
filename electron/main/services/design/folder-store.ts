import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import type {
  CreateDesignFolderInput,
  DesignFolder,
  UpdateDesignFolderInput,
} from '../../../../shared/types/design'
import { clampName, getDocumentRow } from './design-rows'

// Folders of the design hub. Deleting one leaves its documents without a
// folder through the ON DELETE SET NULL of migration 065.

interface FolderRow {
  id: string
  name: string
  color: string | null
  sort_order: number
  created_at: number
  updated_at: number
  doc_count: number
}

const MAX_COLOR_CHARS = 64

function rowToFolder(row: FolderRow): DesignFolder {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    sortOrder: row.sort_order,
    docCount: row.doc_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function requireName(raw: unknown): string {
  const name = typeof raw === 'string' ? clampName(raw) : ''
  if (!name) throw new Error('folder name must be a non-empty string')
  return name
}

function readColor(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string' || raw.length > MAX_COLOR_CHARS) {
    throw new Error(`folder color must be a string up to ${MAX_COLOR_CHARS} chars or null`)
  }
  return raw.trim() || null
}

const SELECT_FOLDERS = `SELECT f.*,
    (SELECT COUNT(*) FROM design_documents d
      WHERE d.folder_id = f.id AND d.status = 'active') AS doc_count
  FROM design_folders f`

export function listFolders(): DesignFolder[] {
  const rows = getDb()
    .prepare(`${SELECT_FOLDERS} ORDER BY f.sort_order ASC, f.name COLLATE NOCASE ASC`)
    .all() as FolderRow[]
  return rows.map(rowToFolder)
}

export function getFolder(id: string): DesignFolder | null {
  const row = getDb().prepare(`${SELECT_FOLDERS} WHERE f.id = ?`).get(id) as FolderRow | undefined
  return row ? rowToFolder(row) : null
}

export function findFolderByName(name: string): DesignFolder | null {
  const row = getDb()
    .prepare(`${SELECT_FOLDERS} WHERE f.name = ? COLLATE NOCASE ORDER BY f.created_at LIMIT 1`)
    .get(name.trim()) as FolderRow | undefined
  return row ? rowToFolder(row) : null
}

export function createFolder(input: CreateDesignFolderInput): DesignFolder {
  const name = requireName(input.name)
  const color = readColor(input.color)
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO design_folders (id, name, color, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM design_folders), ?, ?)`,
  ).run(id, name, color, now, now)
  return getFolder(id)!
}

// Match by name ignoring case; creates the folder when none matches.
export function ensureFolder(name: string): DesignFolder {
  return findFolderByName(requireName(name)) ?? createFolder({ name })
}

export function updateFolder(id: string, input: UpdateDesignFolderInput): DesignFolder {
  const current = getFolder(id)
  if (!current) throw new Error(`design folder not found: ${id}`)
  if (
    input.sortOrder !== undefined &&
    (typeof input.sortOrder !== 'number' || !Number.isInteger(input.sortOrder))
  ) {
    throw new Error('sortOrder must be an integer')
  }
  getDb()
    .prepare(
      'UPDATE design_folders SET name = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?',
    )
    .run(
      input.name === undefined ? current.name : requireName(input.name),
      input.color === undefined ? current.color : readColor(input.color),
      input.sortOrder ?? current.sortOrder,
      Date.now(),
      id,
    )
  return getFolder(id)!
}

export function deleteFolder(id: string): void {
  if (!getFolder(id)) throw new Error(`design folder not found: ${id}`)
  getDb().prepare('DELETE FROM design_folders WHERE id = ?').run(id)
}

export function assertFolderExists(folderId: string | null | undefined): void {
  if (folderId && !getFolder(folderId)) throw new Error(`design folder not found: ${folderId}`)
}

// Moving is filing, not editing: updated_at stays put so the hub's "recent"
// order does not reshuffle.
export function moveDocument(docId: string, folderId: string | null): void {
  if (!getDocumentRow(docId)) throw new Error(`design document not found: ${docId}`)
  assertFolderExists(folderId)
  getDb().prepare('UPDATE design_documents SET folder_id = ? WHERE id = ?').run(folderId, docId)
}
