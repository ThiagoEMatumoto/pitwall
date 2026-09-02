import { getDb } from '../db'
import { newNodeId } from '../../../../shared/design/ids'
import { MAX_NAME_CHARS } from '../../../../shared/design/safety'
import type {
  DesignArtboard,
  DesignAuthor,
  DesignFonts,
  DesignLink,
  DesignNode,
  DesignPageViewport,
  DesignParentType,
  DesignVersionMeta,
} from '../../../../shared/types/design'

// Row shapes and row ⇄ entity helpers shared by design-store (documents,
// pages) and artboard-store (artboards, versions, links). Kept apart so the
// two stores do not import each other in a cycle.

export interface DocumentRow {
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

export interface PageRow {
  id: string
  document_id: string
  name: string
  position: number
  viewport: string
  created_at: number
  updated_at: number
}

export interface ArtboardRow {
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

export interface VersionRow {
  id: string
  artboard_id: string
  version: number
  author: string
  summary: string
  tree: string
  created_at: number
}

export interface LinkRow {
  document_id: string
  parent_type: string
  parent_id: string
}

export const DEFAULT_VIEWPORT: DesignPageViewport = { x: 0, y: 0, zoom: 1 }

export function clampName(name: string): string {
  return name.trim().slice(0, MAX_NAME_CHARS)
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

export function parseObject<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T
  } catch {
    // falls through to the fallback
  }
  return fallback
}

export function parseTree(raw: string): DesignNode {
  const parsed = parseObject<Partial<DesignNode> | null>(raw, null)
  if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.children)) {
    return parsed as DesignNode
  }
  return defaultTree()
}

export function parseFonts(raw: string): DesignFonts {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((f): f is string => typeof f === 'string')
  } catch {
    // falls through to the fallback
  }
  return []
}

export function rowToArtboard(row: ArtboardRow): DesignArtboard {
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

export function rowToVersionMeta(row: VersionRow): DesignVersionMeta {
  return {
    id: row.id,
    artboardId: row.artboard_id,
    version: row.version,
    author: row.author as DesignAuthor,
    summary: row.summary,
    createdAt: row.created_at,
  }
}

export function rowToLink(row: LinkRow): DesignLink {
  return {
    documentId: row.document_id,
    parentType: row.parent_type as DesignParentType,
    parentId: row.parent_id,
  }
}

export function getDocumentRow(id: string): DocumentRow | undefined {
  return getDb().prepare('SELECT * FROM design_documents WHERE id = ?').get(id) as
    DocumentRow | undefined
}

export function getPageRow(id: string): PageRow | undefined {
  return getDb().prepare('SELECT * FROM design_pages WHERE id = ?').get(id) as PageRow | undefined
}

export function getArtboardRow(id: string): ArtboardRow | undefined {
  return getDb().prepare('SELECT * FROM design_artboards WHERE id = ?').get(id) as
    ArtboardRow | undefined
}

export function touchDocument(id: string, now: number): void {
  getDb().prepare('UPDATE design_documents SET updated_at = ? WHERE id = ?').run(now, id)
}
