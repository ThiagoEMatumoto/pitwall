import type Database from 'better-sqlite3'

export const version = 49
export const name = '049_normalize_relative_paths'

// Reparo dos rows legados com path RELATIVO (ver repo-path.ts): o importer do
// sync gravou `diligencia` / `diligencia/api` em vez do caminho absoluto. O fix
// defensivo em runtime cobre quem lê via resolveRepoPath, mas todo consumidor
// novo tem que lembrar de chamá-lo — esta migration tira o problema do caminho.
//
// Decisões:
//
// 1. `vault_root` de app_prefs é a única raiz confiável aqui (mesma semântica de
//    getVaultRoot, sem o default ~/ClaudeManager: adivinhar a raiz reescreveria
//    paths pra um lugar que nunca existiu). Sem a pref → no-op.
// 2. Só toca valor que NÃO começa com '/'. Rodar de novo é inócuo: depois do
//    UPDATE todo valor tocado já é absoluto e sai do WHERE.
export function up(db: Database.Database): void {
  const root = (
    db.prepare(`SELECT value FROM app_prefs WHERE key = 'vault_root'`).get() as
      | { value: string }
      | undefined
  )?.value?.trim()
  if (!root || !root.startsWith('/')) return

  const prefix = `${root.replace(/\/+$/, '')}/`
  for (const [table, column] of [
    ['projects', 'vault_path'],
    ['repos', 'path'],
    ['feature_repos', 'worktree_path'],
  ] as const) {
    db.prepare(
      `UPDATE ${table} SET ${column} = ? || ${column}
        WHERE ${column} IS NOT NULL AND ${column} <> '' AND ${column} NOT LIKE '/%'`,
    ).run(prefix)
  }
}
