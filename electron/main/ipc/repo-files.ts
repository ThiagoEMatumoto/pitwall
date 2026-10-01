import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { RepoFilesResult } from '../../../shared/types/send-prompt'

// Arquivos do cwd de uma sessão pro #arquivo do composer. git ls-files é a fonte
// (rastreados + novos não ignorados); fora de repo, um readdir raso basta pra
// não deixar o menu vazio.

const execFileAsync = promisify(execFile)

export const MAX_FILES = 20_000
export const CACHE_TTL_MS = 30_000

interface ListerDeps {
  // null = cwd não é repo git.
  gitFiles?: (cwd: string) => Promise<string[] | null>
  now?: () => number
}

async function gitLsFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    )
    return [...new Set(stdout.split('\0').filter(Boolean))]
  } catch {
    return null
  }
}

async function shallowList(cwd: string): Promise<string[] | null> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true })
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  } catch {
    return null
  }
}

async function listUncached(
  cwd: string,
  gitFiles: (cwd: string) => Promise<string[] | null>,
): Promise<RepoFilesResult> {
  const fromGit = await gitFiles(cwd)
  const files = fromGit ?? (await shallowList(cwd))
  if (!files) return { files: [], truncated: false, source: 'none' }
  return {
    files: files.slice(0, MAX_FILES),
    truncated: files.length > MAX_FILES,
    source: fromGit ? 'git' : 'readdir',
  }
}

export function createRepoFilesLister(deps: ListerDeps = {}) {
  const gitFiles = deps.gitFiles ?? gitLsFiles
  const now = deps.now ?? Date.now
  const cache = new Map<string, { at: number; result: Promise<RepoFilesResult> }>()
  return (cwd: string): Promise<RepoFilesResult> => {
    const hit = cache.get(cwd)
    if (hit && now() - hit.at <= CACHE_TTL_MS) return hit.result
    const result = listUncached(cwd, gitFiles)
    cache.set(cwd, { at: now(), result })
    return result
  }
}

// Relativo resolveria contra o cwd do processo Electron e listaria o próprio app.
const inputSchema = z.object({ cwd: z.string().min(1).refine(isAbsolute, 'cwd absoluto') })

export function registerRepoFilesIpc(): void {
  const list = createRepoFilesLister()
  ipcMain.handle('fs:list-repo-files', async (_e, raw: unknown) => {
    const { cwd } = inputSchema.parse(raw)
    return list(cwd)
  })
}
