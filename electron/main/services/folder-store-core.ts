import { randomUUID } from 'node:crypto'
import { MAX_NAME_CHARS } from '../../../shared/design/safety'
import { getDb } from './db'

// One-level folders shared by the Design and Diagrams hubs. Both tables have
// the same shape (migrations 065 and 066) and their items carry a nullable
// folder_id with ON DELETE SET NULL, so deleting a folder unfiles its items.
// Table names come from the two call sites below, never from input.

export interface HubFolder {
  id: string
  name: string
  color: string | null
  sortOrder: number
  // Active (non-archived) items in the folder.
  docCount: number
  createdAt: number
  updatedAt: number
}

export interface CreateHubFolderInput {
  name: string
  color?: string | null
}

export interface UpdateHubFolderInput {
  name?: string
  color?: string | null
  sortOrder?: number
}

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

function rowToFolder(row: FolderRow): HubFolder {
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
  const name = typeof raw === 'string' ? raw.trim().slice(0, MAX_NAME_CHARS) : ''
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

export interface FolderStoreConfig {
  folderTable: 'design_folders' | 'diagram_folders'
  itemTable: 'design_documents' | 'diagrams'
  // Used in error messages: "design folder not found: …".
  label: string
}

export function createFolderStore({ folderTable, itemTable, label }: FolderStoreConfig) {
  const selectFolders = `SELECT f.*,
      (SELECT COUNT(*) FROM ${itemTable} d
        WHERE d.folder_id = f.id AND d.status = 'active') AS doc_count
    FROM ${folderTable} f`

  function listFolders(): HubFolder[] {
    const rows = getDb()
      .prepare(`${selectFolders} ORDER BY f.sort_order ASC, f.name COLLATE NOCASE ASC`)
      .all() as FolderRow[]
    return rows.map(rowToFolder)
  }

  function getFolder(id: string): HubFolder | null {
    const row = getDb().prepare(`${selectFolders} WHERE f.id = ?`).get(id) as
      | FolderRow
      | undefined
    return row ? rowToFolder(row) : null
  }

  function findFolderByName(name: string): HubFolder | null {
    const row = getDb()
      .prepare(`${selectFolders} WHERE f.name = ? COLLATE NOCASE ORDER BY f.created_at LIMIT 1`)
      .get(name.trim()) as FolderRow | undefined
    return row ? rowToFolder(row) : null
  }

  function createFolder(input: CreateHubFolderInput): HubFolder {
    const name = requireName(input.name)
    const color = readColor(input.color)
    const id = randomUUID()
    const now = Date.now()
    getDb()
      .prepare(
        `INSERT INTO ${folderTable} (id, name, color, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ${folderTable}), ?, ?)`,
      )
      .run(id, name, color, now, now)
    return getFolder(id)!
  }

  // Match by name ignoring case; creates the folder when none matches.
  function ensureFolder(name: string): HubFolder {
    return findFolderByName(requireName(name)) ?? createFolder({ name })
  }

  function updateFolder(id: string, input: UpdateHubFolderInput): HubFolder {
    const current = getFolder(id)
    if (!current) throw new Error(`${label} not found: ${id}`)
    if (
      input.sortOrder !== undefined &&
      (typeof input.sortOrder !== 'number' || !Number.isInteger(input.sortOrder))
    ) {
      throw new Error('sortOrder must be an integer')
    }
    getDb()
      .prepare(
        `UPDATE ${folderTable} SET name = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
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

  function deleteFolder(id: string): void {
    if (!getFolder(id)) throw new Error(`${label} not found: ${id}`)
    getDb().prepare(`DELETE FROM ${folderTable} WHERE id = ?`).run(id)
  }

  function assertFolderExists(folderId: string | null | undefined): void {
    if (folderId && !getFolder(folderId)) throw new Error(`${label} not found: ${folderId}`)
  }

  // Moving is filing, not editing: updated_at stays put so the hub's "recent"
  // order does not reshuffle. The caller checks the item exists.
  function setItemFolder(itemId: string, folderId: string | null): void {
    assertFolderExists(folderId)
    getDb().prepare(`UPDATE ${itemTable} SET folder_id = ? WHERE id = ?`).run(folderId, itemId)
  }

  return {
    listFolders,
    getFolder,
    findFolderByName,
    createFolder,
    ensureFolder,
    updateFolder,
    deleteFolder,
    assertFolderExists,
    setItemFolder,
  }
}
