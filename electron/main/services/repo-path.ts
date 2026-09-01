import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { getDb } from './db'

// Resolução defensiva de paths de repo/worktree vindos do DB.
//
// O importer do sync (versões antigas) gravou paths RELATIVOS em repos.path /
// feature_repos.worktree_path quando não havia raiz local configurada (ex.:
// `projetos/x` em vez de `/home/u/projetos/x`). Um path relativo passado a
// existsSync/statSync/cwd de spawn resolve contra o cwd do PROCESSO — sempre
// errado. Todo consumidor que vai ao disco deve passar por resolveRepoPath
// antes: rows legados relativos voltam a funcionar sem reparo do banco.

const VAULT_ROOT_KEY = 'vault_root'

// Mesma semântica do handler vault:get-root (ipc/git.ts): pref explícita em
// app_prefs, senão o default ~/ClaudeManager.
export function getVaultRoot(): string {
  const row = getDb()
    .prepare('SELECT value FROM app_prefs WHERE key = ?')
    .get(VAULT_ROOT_KEY) as { value: string } | undefined
  return row?.value?.trim() || join(homedir(), 'ClaudeManager')
}

// PURA/testável: relativo → resolve contra `root`; absoluto → intacto.
export function resolveAgainstRoot(p: string, root: string): string {
  return isAbsolute(p) ? p : join(root, p)
}

export function resolveRepoPath(p: string): string {
  return isAbsolute(p) ? p : resolveAgainstRoot(p, getVaultRoot())
}
