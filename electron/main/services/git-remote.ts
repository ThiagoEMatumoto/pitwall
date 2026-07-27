import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { getDb } from './db'
import { pingSyncMutation } from './notify'

export interface RepoRemoteInfo {
  // URL de fetch do remote `origin`, ou null se o repo não tem origin.
  remoteUrl: string | null
  // Branch default resolvida via origin/HEAD, ou null se não resolvida localmente.
  defaultBranch: string | null
}

// Lê a origin (fetch URL + branch default) de um repo local. Espelha o padrão de
// `sync/git-sync.ts:120` (getRemotes(true) → origin.refs.fetch). Retorna
// { null, null } quando o path não é um repo git ou não tem remote origin.
export async function readOriginUrl(repoPath: string): Promise<RepoRemoteInfo> {
  if (!existsSync(join(repoPath, '.git'))) {
    return { remoteUrl: null, defaultBranch: null }
  }
  const git = simpleGit(repoPath)

  let remoteUrl: string | null = null
  try {
    const remotes = await git.getRemotes(true)
    remoteUrl = remotes.find((r) => r.name === 'origin')?.refs.fetch ?? null
  } catch {
    remoteUrl = null
  }

  const defaultBranch = await readDefaultBranch(git)
  return { remoteUrl, defaultBranch }
}

// origin/HEAD aponta pra branch default do remote (ex. "origin/main"). Null
// quando não está resolvido localmente: NÃO caímos pra branch em CHECKOUT, que
// gravava feature branch como default (`legal-app` ficou com 'feat/mvp-scaffold')
// e fazia o auto-pull fast-forwardar a branch errada. Quem precisa do valor
// resolve via `remote set-head -a` (repo-pull.ts). Exportada pra reuso lá.
export async function readDefaultBranch(git: ReturnType<typeof simpleGit>): Promise<string | null> {
  try {
    const ref = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
    if (ref) return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref
  } catch {
    // origin/HEAD não resolvido.
  }
  return null
}

export interface BackfillResult {
  scanned: number
  updated: number
}

// Preenche remote_url/default_branch dos repos que ainda estão nulos e cujo path
// existe no disco. Idempotente: toca rows com remote_url OU default_branch nulos
// (a default sozinha basta — a migration 034 zerou as defaults sujas e elas
// precisam ser re-derivadas mesmo com remote_url já preenchida), e repos sem
// origin (blank/local-only) permanecem nulos. Seguro pra rodar múltiplas vezes.
export async function backfillRepoRemotes(): Promise<BackfillResult> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, path FROM repos WHERE (remote_url IS NULL OR default_branch IS NULL) AND path IS NOT NULL`,
    )
    .all() as Array<{ id: string; path: string }>

  const update = db.prepare(
    `UPDATE repos SET remote_url = ?, default_branch = COALESCE(?, default_branch) WHERE id = ?`,
  )

  let updated = 0
  for (const row of rows) {
    if (!existsSync(row.path)) continue
    const { remoteUrl, defaultBranch } = await readOriginUrl(row.path)
    if (!remoteUrl) continue
    update.run(remoteUrl, defaultBranch, row.id)
    updated++
  }

  if (updated > 0) pingSyncMutation()
  return { scanned: rows.length, updated }
}
