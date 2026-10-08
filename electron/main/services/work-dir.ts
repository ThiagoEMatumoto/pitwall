import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { getDb } from './db'

// O `db` é parâmetro porque a migration 057 usa este mesmo resolvedor no backfill,
// e durante as migrations o getDb() ainda não terminou de abrir o banco.

// Mesma regra do resolveRepoPath (repo-path.ts), lendo o vault root do `db` dado:
// path legado RELATIVO (bug do importer do sync antigo) resolve contra a raiz.
function absolutePath(db: Database.Database, p: string): string {
  if (isAbsolute(p)) return p
  const row = db.prepare("SELECT value FROM app_prefs WHERE key = 'vault_root'").get() as
    { value: string } | undefined
  return join(row?.value?.trim() || join(homedir(), 'ClaudeManager'), p)
}

// Worktree registrado em feature_repos para o par (feature, repo). Quando existe
// no disco, é ele o cwd da sessão — não a raiz do repo. Nada de checkout/troca
// de branch aqui: só respeitamos o worktree que o usuário já registrou. Worktree
// removido do disco cai pro repo (o usuário apaga worktree o tempo todo).
export function resolveFeatureWorktree(
  featureId: string | null,
  repoId: string | null,
  db: Database.Database = getDb(),
): string | null {
  if (!featureId || !repoId) return null
  try {
    const row = db
      .prepare('SELECT worktree_path FROM feature_repos WHERE feature_id = ? AND repo_id = ?')
      .get(featureId, repoId) as { worktree_path: string | null } | undefined
    const path = row?.worktree_path?.trim()
    if (!path) return null
    const abs = absolutePath(db, path)
    return statSync(abs).isDirectory() ? abs : null
  } catch {
    return null
  }
}

// Chave da posse: um diretório, uma string. Sem isto, `/x/repo/`, `/x/repo` e um
// symlink pra ele seriam três donos diferentes do mesmo checkout (dois repos
// cadastrados no mesmo path, ou worktree registrado = raiz do repo). Só a chave é
// canônica; o cwd do spawn continua o path registrado.
function canonicalDir(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

// Diretório onde a filha de um handoff vai trabalhar: o worktree da feature
// nesse repo, senão a raiz do repo. É a MESMA regra do cwd do spawnSession, e é a
// chave da posse (handoffs.work_dir): duas filhas que escrevem só colidem se
// caem no mesmo checkout. null só se o repo não existe.
export function resolveHandoffWorkDir(
  repoId: string,
  featureId: string | null,
  db: Database.Database = getDb(),
): string | null {
  const worktree = resolveFeatureWorktree(featureId, repoId, db)
  if (worktree) return canonicalDir(worktree)
  const repo = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
    { path: string } | undefined
  return repo ? canonicalDir(absolutePath(db, repo.path)) : null
}
