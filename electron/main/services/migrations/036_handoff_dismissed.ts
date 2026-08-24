import type Database from 'better-sqlite3'

export const version = 36
export const name = '036_handoff_dismissed'

// Dispensa manual de handoff no Crew Dock. O carimbo é DELIBERADAMENTE separado
// de `status`: sumir do dock é decisão de EXIBIÇÃO do humano, não um desfecho da
// filha. Marcar 'rejected'/'failed' pra esconder um card mentiria na trilha de
// handoff_events e na instrumentação (outcome/consumed_at) — daí a coluna
// própria. NULL = nunca dispensado (todo handoff legado nasce assim).
//
// Aditiva: ALTER ADD COLUMN não recria tabela nem toca a FK CASCADE da 018.
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE handoffs ADD COLUMN dismissed_at INTEGER;
  `)
}
