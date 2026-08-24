import { getDb } from './db'
import type { DiagramLibraryItem, DiagramLibraryStatus } from '../../../shared/types/ipc'

// Store da biblioteca de shapes (.excalidrawlib). Molde de diagram-store:
// funções soltas, rows snake_case ⇄ entidades camelCase, `db.transaction` nas
// mutações compostas, JSON.parse defensivo.
//
// A biblioteca é GLOBAL (uma por app, compartilhada por todos os canvases) e a
// fonte da verdade da ordem é `position`:
// - replaceAll é o caminho do onLibraryChange do editor — o Excalidraw manda
//   sempre a biblioteca INTEIRA já ordenada, então regravamos 0..N-1.
// - addItems é o caminho de instalação (arquivo/URL/MCP) — merge POR ID: item
//   novo sobrescreve o existente de mesmo id (mantendo a position), ids
//   inéditos entram no fim, na ordem recebida.

interface LibraryRow {
  id: string
  name: string | null
  status: string
  elements: string
  created: number
  position: number
  updated_at: number
}

// JSON gravado por nós, mas ainda assim defendido: uma row corrompida por
// edição manual no sqlite não pode derrubar o getItems() inteiro.
function parseElements(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // cai no fallback
  }
  return []
}

function rowToItem(row: LibraryRow): DiagramLibraryItem {
  return {
    id: row.id,
    name: row.name,
    status: row.status as DiagramLibraryStatus,
    elements: parseElements(row.elements),
    created: row.created,
  }
}

const INSERT_SQL = `INSERT INTO diagram_library_items
    (id, name, status, elements, created, position, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`

export function getItems(): DiagramLibraryItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM diagram_library_items ORDER BY position ASC')
    .all() as LibraryRow[]
  return rows.map(rowToItem)
}

export function replaceAll(items: DiagramLibraryItem[]): DiagramLibraryItem[] {
  const db = getDb()
  const now = Date.now()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM diagram_library_items').run()
    const insert = db.prepare(INSERT_SQL)
    items.forEach((item, i) => {
      insert.run(
        item.id,
        item.name,
        item.status,
        JSON.stringify(item.elements),
        item.created,
        i,
        now,
      )
    })
  })
  tx()
  return getItems()
}

export function removeItem(id: string): DiagramLibraryItem[] {
  getDb().prepare('DELETE FROM diagram_library_items WHERE id = ?').run(id)
  return getItems()
}

export function addItems(items: DiagramLibraryItem[]): DiagramLibraryItem[] {
  const db = getDb()
  const now = Date.now()
  const tx = db.transaction(() => {
    const { max } = db
      .prepare('SELECT COALESCE(MAX(position), -1) AS max FROM diagram_library_items')
      .get() as { max: number }
    let nextPosition = max + 1
    const update = db.prepare(
      `UPDATE diagram_library_items
       SET name = ?, status = ?, elements = ?, created = ?, updated_at = ?
       WHERE id = ?`,
    )
    const insert = db.prepare(INSERT_SQL)
    for (const item of items) {
      const elementsJson = JSON.stringify(item.elements)
      const { changes } = update.run(
        item.name,
        item.status,
        elementsJson,
        item.created,
        now,
        item.id,
      )
      if (changes === 0) {
        insert.run(item.id, item.name, item.status, elementsJson, item.created, nextPosition++, now)
      }
    }
  })
  tx()
  return getItems()
}
