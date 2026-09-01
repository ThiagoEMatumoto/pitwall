import { isAbsolute } from 'node:path'
import type Database from 'better-sqlite3'
import { resolveAgainstRoot } from '../repo-path'

export const version = 44
export const name = '044_normalize_relative_paths'

// Colunas de path de disco que o importer do sync (versões antigas) chegou a
// gravar RELATIVAS quando o bundle vinha de outra máquina.
const TARGETS = [
  { table: 'repos', column: 'path' },
  { table: 'projects', column: 'vault_path' },
  { table: 'feature_repos', column: 'worktree_path' },
] as const

// One-shot: repara no BANCO o estrago que a 0.65.2 passou a contornar na
// LEITURA (resolveRepoPath). A camada defensiva fez o app voltar a funcionar,
// mas todo consumidor novo que esquecer de chamá-la volta a resolver contra o
// cwd do processo; e o exporter continua espalhando as rows sujas no próximo
// bundle. Aqui os paths viram absolutos de uma vez.
//
// Duas decisões carregam o resto:
//
// 1. `vault_root` é lido por SQL cru, não por getVaultRoot(): esta migration roda
//    DENTRO de runMigrations, chamado por getDb() antes de dbInstance existir —
//    qualquer service que faça getDb() aqui reentra no init.
// 2. Sem `vault_root` utilizável (ausente, vazio ou ele próprio relativo) o
//    reparo é NO-OP silencioso. O default ~/ClaudeManager de getVaultRoot() é
//    aceitável pra resolver um path na leitura (some quando a pref aparece), mas
//    NÃO pra gravar: persistiria paths fabricados que apontam pra lugar nenhum —
//    exatamente a classe de bug que estamos limpando. Rows que sobram continuam
//    cobertas por resolveRepoPath, e a migration não roda de novo.
export function up(db: Database.Database): void {
  const pref = db.prepare(`SELECT value FROM app_prefs WHERE key = 'vault_root'`).get() as
    | { value: string }
    | undefined
  const root = pref?.value?.trim()
  if (!root || !isAbsolute(root)) return

  for (const { table, column } of TARGETS) {
    const rows = db
      .prepare(
        `SELECT rowid AS rid, ${column} AS value FROM ${table}
         WHERE ${column} IS NOT NULL AND ${column} != ''`,
      )
      .all() as Array<{ rid: number; value: string }>
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`)
    for (const row of rows) {
      // Filtro em JS, não em SQL: `LIKE '/%'` só acerta POSIX, e isAbsolute é a
      // MESMA condição que resolveRepoPath usa na leitura — as duas camadas não
      // podem divergir sobre o que é "relativo".
      if (isAbsolute(row.value)) continue
      update.run(resolveAgainstRoot(row.value, root), row.rid)
    }
  }
}
