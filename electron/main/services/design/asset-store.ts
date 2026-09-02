import { createHash, randomUUID } from 'node:crypto'
import { getDb } from '../db'
import type { DesignAsset, DesignAssetMime } from '../../../../shared/types/design'

// Assets binários do Design Studio, guardados no SQLite como BLOB. Os bytes
// nunca viajam pelo IPC de listagem: saem só pelo scheme
// pitwall-design://asset/<id> (registrado no protocol do main).

export const ASSET_URL_PREFIX = 'pitwall-design://asset/'

const ALLOWED_MIMES: ReadonlySet<string> = new Set<DesignAssetMime>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
])

export const MAX_ASSET_BYTES = 5 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024

interface AssetRow {
  id: string
  document_id: string | null
  name: string
  mime: string
  size: number
  width: number | null
  height: number | null
  sha256: string
  created_at: number
}

export interface AssetUploadInput {
  documentId: string | null
  name: string
  mime: string
  bytes: Buffer
}

function rowToAsset(row: AssetRow): DesignAsset {
  return {
    id: row.id,
    documentId: row.document_id,
    name: row.name,
    mime: row.mime as DesignAssetMime,
    size: row.size,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    url: `${ASSET_URL_PREFIX}${row.id}`,
    createdAt: row.created_at,
  }
}

const META_COLUMNS = 'id, document_id, name, mime, size, width, height, sha256, created_at'

function findBySha(sha256: string, documentId: string | null): AssetRow | undefined {
  return getDb()
    .prepare(
      `SELECT ${META_COLUMNS} FROM design_assets
       WHERE sha256 = ? AND COALESCE(document_id, '') = ?`,
    )
    .get(sha256, documentId ?? '') as AssetRow | undefined
}

function usedBytes(documentId: string | null): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS total FROM design_assets
       WHERE COALESCE(document_id, '') = ?`,
    )
    .get(documentId ?? '') as { total: number }
  return row.total
}

export function upload(input: AssetUploadInput): DesignAsset {
  if (!ALLOWED_MIMES.has(input.mime)) throw new Error(`asset mime not allowed: ${input.mime}`)
  if (input.bytes.length === 0) throw new Error('asset is empty')
  if (input.bytes.length > MAX_ASSET_BYTES) {
    throw new Error(`asset exceeds ${MAX_ASSET_BYTES} bytes: ${input.bytes.length}`)
  }

  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  // Dedupe por escopo: o mesmo arquivo mandado duas vezes pro mesmo doc
  // devolve o registro existente em vez de dobrar o banco.
  const existing = findBySha(sha256, input.documentId)
  if (existing) return rowToAsset(existing)

  if (usedBytes(input.documentId) + input.bytes.length > MAX_DOCUMENT_BYTES) {
    throw new Error(`document asset quota exceeded (${MAX_DOCUMENT_BYTES} bytes)`)
  }

  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO design_assets
        (id, document_id, name, mime, bytes, size, width, height, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      id,
      input.documentId,
      input.name.trim() || 'asset',
      input.mime,
      input.bytes,
      input.bytes.length,
      sha256,
      Date.now(),
    )
  return getMeta(id)!
}

export function getMeta(id: string): DesignAsset | null {
  const row = getDb()
    .prepare(`SELECT ${META_COLUMNS} FROM design_assets WHERE id = ?`)
    .get(id) as AssetRow | undefined
  return row ? rowToAsset(row) : null
}

export function get(id: string): { mime: DesignAssetMime; bytes: Buffer } | null {
  const row = getDb()
    .prepare('SELECT mime, bytes FROM design_assets WHERE id = ?')
    .get(id) as { mime: string; bytes: Buffer } | undefined
  if (!row) return null
  return { mime: row.mime as DesignAssetMime, bytes: row.bytes }
}

// documentId null = só os compartilhados.
export function list(documentId: string | null): DesignAsset[] {
  const rows = getDb()
    .prepare(
      `SELECT ${META_COLUMNS} FROM design_assets
       WHERE COALESCE(document_id, '') = ? ORDER BY created_at DESC`,
    )
    .all(documentId ?? '') as AssetRow[]
  return rows.map(rowToAsset)
}

export function remove(id: string): void {
  getDb().prepare('DELETE FROM design_assets WHERE id = ?').run(id)
}
