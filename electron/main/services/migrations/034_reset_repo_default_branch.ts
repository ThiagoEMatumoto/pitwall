import type Database from 'better-sqlite3'

export const version = 34
export const name = '034_reset_repo_default_branch'

// One-shot: zera repos.default_branch. Até agora `readDefaultBranch` caía pra
// branch em CHECKOUT quando origin/HEAD não estava resolvido, então rows ficaram
// com feature branch como "default" (ex. 'feat/mvp-scaffold') e o auto-pull
// passou a fast-forwardar a branch errada. O fallback ruim foi removido; o valor
// é re-derivado via origin/HEAD (ou `remote set-head -a`) no próximo pull/backfill.
export function up(db: Database.Database): void {
  db.exec(`UPDATE repos SET default_branch = NULL`)
}
