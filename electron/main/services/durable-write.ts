import type Database from 'better-sqlite3'

// O app.db roda em WAL + synchronous=NORMAL: o commit sobrevive a kill -9 (o WAL
// já está no page cache do SO), mas não a queda de energia/reboot, porque NORMAL
// não faz fsync do WAL no commit. O que não pode sumir de jeito nenhum sobe para
// FULL só na própria transação. A conexão do better-sqlite3 é única e síncrona,
// então nada mais escreve entre o set e o restore.
export function writeDurably<T>(db: Database.Database, write: () => T): T {
  const previous = db.pragma('synchronous', { simple: true }) as number
  db.pragma('synchronous = FULL')
  try {
    return db.transaction(write)()
  } finally {
    db.pragma(`synchronous = ${Number(previous)}`)
  }
}
