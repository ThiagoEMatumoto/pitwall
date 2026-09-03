import type Database from 'better-sqlite3'

export const version = 48
export const name = '048_design_artboard_sizing'

// Design Studio v2 — flow artboards (fixed width, height follows the content).
// Additive: every existing artboard keeps clipping as it did ('fixed').
export function up(db: Database.Database): void {
  db.exec(
    `ALTER TABLE design_artboards ADD COLUMN sizing TEXT NOT NULL DEFAULT 'fixed'
       CHECK (sizing IN ('fixed','flow'))`,
  )
}
