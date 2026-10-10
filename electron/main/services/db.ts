import { app } from 'electron'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { runMigrations } from './migrations/index'

let dbInstance: Database.Database | null = null
let interruptedAtOpen: ReadonlySet<string> = new Set()

// Handoffs que o sweep desta abertura do banco tirou de running/needs_input.
export function handoffsInterruptedAtOpen(): string[] {
  return [...interruptedAtOpen]
}

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance

  const userDataDir = app.getPath('userData')
  mkdirSync(userDataDir, { recursive: true })
  const dbPath = join(userDataDir, 'app.db')

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')

  runMigrations(db)

  // Sessões marcadas 'running' de um boot anterior são órfãs: o processo claude
  // morre junto com o app, então nenhuma está realmente viva ao iniciar.
  db.prepare("UPDATE sessions SET status = 'exited', ended_at = ? WHERE status = 'running'").run(
    Date.now(),
  )

  // Handoffs vivos (running OU needs_input) de um boot anterior também são órfãos:
  // a sessão-filha (PTY) não sobrevive ao restart, e a reconciliação via evento
  // PTY exit nunca dispara (o ptyManager morreu junto). Sem isto, órfãos travam
  // o dedup do repo-alvo para sempre. No boot TODO in-flight é órfão — nenhum
  // PTY-filho sobrevive ao restart (inclui needs_input: a filha que perguntou
  // também morreu junto com o app). Marca 'interrupted' (RECUPERÁVEL, não
  // 'failed'): app-restart não é erro de tarefa; o handoff sai do ativo (libera
  // o dedup) mas fica retomável pelo humano. Mantém em sync com failIfRunning /
  // reconcileStuck (mesma transição em → interrupted).
  //
  // Quem estava em voo é lido ANTES do UPDATE: o lazy restore sobe eager a mãe e a
  // filha desses handoffs, e depois do sweep eles são indistinguíveis de um
  // 'interrupted' antigo (que não deve acordar nada no boot).
  const inFlight = db
    .prepare("SELECT id FROM handoffs WHERE status IN ('running','needs_input')")
    .all() as Array<{ id: string }>
  interruptedAtOpen = new Set(inFlight.map((r) => r.id))
  db.prepare(
    "UPDATE handoffs SET status = 'interrupted', error = ?, updated_at = ? WHERE status IN ('running','needs_input')",
  ).run('Sessão-filha órfã: app reiniciou sem reconciliar o handoff', Date.now())

  dbInstance = db
  return db
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}
