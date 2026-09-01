import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getDb } from './db'
import { resolveRepoPath } from './repo-path'
import { authArgs, netGit } from './git-auth'
import { pingSyncMutation } from './notify'
import type { CloneMissingResult, MissingRepo } from '../../../shared/types/ipc'

// Máximo de clones simultâneos: limita rede/CPU ao clonar muitos repos numa
// máquina nova sem serializar tudo.
const CLONE_CONCURRENCY = 3

interface RepoRow {
  id: string
  label: string
  path: string
  remote_url: string | null
}

// Puro e testável: filtra os repos cujo path NÃO existe no disco E têm remote_url
// setado. `exists` é injetável (fs real no runtime; stub nos testes).
export function selectMissingRepos(
  rows: RepoRow[],
  exists: (p: string) => boolean,
): MissingRepo[] {
  const out: MissingRepo[] = []
  for (const row of rows) {
    if (!row.remote_url) continue
    if (exists(row.path)) continue
    out.push({ repoId: row.id, label: row.label, path: row.path, remoteUrl: row.remote_url })
  }
  return out
}

export function listMissingRepos(): MissingRepo[] {
  const rows = getDb()
    .prepare('SELECT id, label, path, remote_url FROM repos WHERE remote_url IS NOT NULL')
    .all() as RepoRow[]
  // Rows legados podem ter path RELATIVO (bug do importer do sync): resolve
  // contra o vault root ANTES do existsSync — senão todo repo legado aparece
  // como "missing" e o clone iria pra um path relativo ao cwd do processo.
  const resolved = rows.map((r) => ({ ...r, path: resolveRepoPath(r.path) }))
  return selectMissingRepos(resolved, existsSync)
}

// Progresso emitido antes de cada clone (índice 1-based / total + label).
export interface CloneProgress {
  index: number
  total: number
  label: string
}

async function cloneOne(target: MissingRepo): Promise<CloneMissingResult> {
  const base = { repoId: target.repoId, label: target.label, path: target.path }
  // O registro pode ter sido clonado por fora entre o list e o clone.
  if (existsSync(target.path)) return { ...base, status: 'skipped', detail: 'já existe no disco' }
  try {
    await mkdir(dirname(target.path), { recursive: true })
    // authArgs (gh credential helper) vem ANTES do subcomando `clone`; netGit
    // roda a partir do diretório-pai e clona no path absoluto.
    await netGit(dirname(target.path)).raw([
      ...authArgs(target.remoteUrl),
      'clone',
      target.remoteUrl,
      target.path,
    ])
    return { ...base, status: 'cloned' }
  } catch (err) {
    return { ...base, status: 'error', detail: (err as Error).message }
  }
}

// Clona todos os repos faltantes com concorrência limitada. Chama onProgress
// antes de iniciar cada clone (útil pra toast sequencial). Retorna o resumo.
export async function cloneMissingRepos(
  onProgress?: (p: CloneProgress) => void,
): Promise<CloneMissingResult[]> {
  const targets = listMissingRepos()
  const total = targets.length
  const results: CloneMissingResult[] = new Array(total)

  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= total) return
      const target = targets[i]
      onProgress?.({ index: i + 1, total, label: target.label })
      results[i] = await cloneOne(target)
    }
  }

  const workers = Array.from({ length: Math.min(CLONE_CONCURRENCY, total) }, () => worker())
  await Promise.all(workers)

  if (results.some((r) => r?.status === 'cloned')) pingSyncMutation()
  return results
}
