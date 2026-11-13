import { app } from 'electron'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { runMigrations } from './migrations/index'
import { sweepInFlightHandoffs } from './handoff/boot-sweep'

let dbInstance: Database.Database | null = null
let interruptedAtOpen: ReadonlySet<string> = new Set()

// Handoffs que o sweep desta abertura do banco tirou de running/needs_input.
export function handoffsInterruptedAtOpen(): string[] {
  return [...interruptedAtOpen]
}

// Abre o app.db com os pragmas e as migrations de produção. Separado do getDb
// (que depende do electron) para o teste de durabilidade abrir o banco por este
// mesmo caminho num processo Node comum.
export function openAppDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // NORMAL em WAL: commit sobrevive a kill -9, não a queda de energia. Escritas
  // que precisam sobreviver à energia sobem para FULL na própria transação
  // (ver durable-write.ts e composer-drafts.ts).
  db.pragma('synchronous = NORMAL')
  runMigrations(db)
  return db
}

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance

  const userDataDir = app.getPath('userData')
  mkdirSync(userDataDir, { recursive: true })
  const db = openAppDb(join(userDataDir, 'app.db'))

  // Sessões marcadas 'running' de um boot anterior são órfãs: o processo claude
  // morre junto com o app, então nenhuma está realmente viva ao iniciar.
  db.prepare("UPDATE sessions SET status = 'exited', ended_at = ? WHERE status = 'running'").run(
    Date.now(),
  )

  interruptedAtOpen = new Set(sweepInFlightHandoffs(db))

  dbInstance = db
  return db
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}
