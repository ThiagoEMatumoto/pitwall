import type Database from 'better-sqlite3'
import type { PaneSnapshot } from '../../../shared/types/ipc'
import { writeDurably } from './durable-write'

// open_panes e dock_layout são o que o próximo boot reabre: perder um deles numa
// queda de energia é perder abas. Gravam em FULL (ver durable-write.ts).

function ensureRow(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workspace_state (id, last_opened_at) VALUES (1, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(Date.now())
}

export function saveOpenPanes(db: Database.Database, panes: PaneSnapshot[]): void {
  writeDurably(db, () => {
    ensureRow(db)
    db.prepare('UPDATE workspace_state SET open_panes = ? WHERE id = 1').run(JSON.stringify(panes))
  })
}

export function saveDockLayout(db: Database.Database, layout: string | null): void {
  writeDurably(db, () => {
    ensureRow(db)
    db.prepare('UPDATE workspace_state SET dock_layout = ? WHERE id = 1').run(layout)
  })
}

export function readOpenPanes(db: Database.Database): PaneSnapshot[] {
  const row = db.prepare('SELECT open_panes FROM workspace_state WHERE id = 1').get() as
    { open_panes: string | null } | undefined
  return row?.open_panes ? (JSON.parse(row.open_panes) as PaneSnapshot[]) : []
}
