import { ipcMain } from 'electron'
import { z } from 'zod'
import { simpleGit } from 'simple-git'
import { homedir } from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, cp, rm, symlink, lstat, unlink } from 'node:fs/promises'
import { getDb } from '../services/db'
import { backfillRepoRemotes } from '../services/git-remote'
import { resolveRepoPath } from '../services/repo-path'
import { cloneMissingRepos, listMissingRepos } from '../services/repo-clone'
import { pullAllRepos, pullOneRepo } from '../services/repo-pull'
import { getLastPullRun, recordPullRun, type PullRunTrigger } from '../services/repo-pull-store'
import { emitToast } from '../services/notifications'
import { validateBlankRepoName } from './blank-repo'
import type { CloneMissingResult, PullRepoResult } from '../../../shared/types/ipc'

const VAULT_ROOT_KEY = 'vault_root'

function defaultVaultRoot(): string {
  return path.join(homedir(), 'ClaudeManager')
}

export function isInsideVault(vaultPath: string, target: string): boolean {
  const rel = path.relative(vaultPath, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

const setRootSchema = z.object({ root: z.string().min(1) })
const ensureDirSchema = z.object({ path: z.string().min(1) })
const isInsideSchema = z.object({ vaultPath: z.string().min(1), target: z.string().min(1) })
const moveSchema = z.object({
  source: z.string().min(1),
  vaultPath: z.string().min(1),
  label: z.string().min(1),
})
const symlinkSchema = moveSchema
const removeSymlinkSchema = z.object({ target: z.string().min(1) })
const cloneSchema = z.object({ url: z.string().min(1), vaultPath: z.string().min(1) })
const createBlankSchema = z.object({
  vaultPath: z.string().min(1),
  name: z.string().min(1),
  gitInit: z.boolean(),
})

function repoNameFromUrl(url: string): string {
  const base = url.replace(/\/+$/, '').split('/').pop() ?? 'repo'
  return base.replace(/\.git$/, '')
}

// Clona os repos faltantes emitindo toast de progresso por-repo + um resumo
// final. Compartilhado pelo handler manual (repos:clone-missing) e pelo gatilho
// de boot (index.ts). No-op silencioso quando não há nada a clonar.
export async function cloneMissingWithToasts(): Promise<CloneMissingResult[]> {
  const results = await cloneMissingRepos(({ index, total, label }) => {
    emitToast('Clonando repositórios', `Clonando ${index} de ${total}: ${label}`)
  })
  const cloned = results.filter((r) => r.status === 'cloned').length
  const errored = results.filter((r) => r.status === 'error').length
  if (results.length > 0) {
    const parts = [`${cloned} repo${cloned === 1 ? '' : 's'} clonado${cloned === 1 ? '' : 's'}`]
    if (errored > 0) parts.push(`${errored} com erro`)
    emitToast('Repositórios sincronizados', parts.join(' · '))
  }
  return results
}

// Puxa (ff-only) todos os repos emitindo toast de progresso por-repo + um resumo
// final. Compartilhado pelo handler manual (repos:pull-all) e pelo cron
// (repo-pull-scheduler.ts) — `trigger` distingue os dois na run persistida.
// O resumo SEMPRE aparece no disparo manual (mesmo com 0 atualizados: o usuário
// clicou e precisa de resposta) e sempre que houve erro; no cron, só quando há
// algo a mostrar.
export async function pullAllWithToasts(trigger: PullRunTrigger): Promise<PullRepoResult[]> {
  const startedAt = Date.now()
  const results = await pullAllRepos(({ index, total, label }) => {
    emitToast('Atualizando repositórios', `git pull ${index} de ${total}: ${label}`)
  })
  recordPullRun({ trigger, startedAt, finishedAt: Date.now(), results })
  const pulled = results.filter((r) => r.status === 'pulled').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const errored = results.filter((r) => r.status === 'error').length
  if (trigger === 'manual' || pulled > 0 || errored > 0) {
    const parts = [`${pulled} atualizado${pulled === 1 ? '' : 's'}`]
    if (skipped > 0) parts.push(`${skipped} pulado${skipped === 1 ? '' : 's'}`)
    if (errored > 0) parts.push(`${errored} com erro`)
    emitToast('Repositórios atualizados', parts.join(' · '))
  }
  return results
}

const pullOneSchema = z
  .object({ repoId: z.string().min(1).optional(), path: z.string().min(1).optional() })
  .refine((v) => Boolean(v.repoId) || Boolean(v.path), {
    message: 'informe repoId ou path',
  })

export function registerGitIpc(): void {
  ipcMain.handle('vault:get-root', () => {
    const row = getDb()
      .prepare('SELECT value FROM app_prefs WHERE key = ?')
      .get(VAULT_ROOT_KEY) as { value: string } | undefined
    return row?.value ?? defaultVaultRoot()
  })

  ipcMain.handle('vault:is-configured', () => {
    const row = getDb()
      .prepare('SELECT value FROM app_prefs WHERE key = ?')
      .get(VAULT_ROOT_KEY) as { value: string } | undefined
    return row !== undefined
  })

  ipcMain.handle('vault:set-root', (_e, payload: unknown) => {
    const { root } = setRootSchema.parse(payload)
    getDb()
      .prepare('INSERT OR REPLACE INTO app_prefs (key, value) VALUES (?, ?)')
      .run(VAULT_ROOT_KEY, root)
  })

  ipcMain.handle('vault:ensure-dir', async (_e, payload: unknown) => {
    const { path: dir } = ensureDirSchema.parse(payload)
    const existed = existsSync(dir)
    await mkdir(dir, { recursive: true })
    const entries = await readdir(dir)
    return { created: !existed, wasEmpty: entries.length === 0 }
  })

  ipcMain.handle('vault:is-inside', (_e, payload: unknown) => {
    const { vaultPath, target } = isInsideSchema.parse(payload)
    return isInsideVault(vaultPath, target)
  })

  ipcMain.handle('repo:move-into-vault', async (_e, payload: unknown) => {
    const { source, vaultPath, label } = moveSchema.parse(payload)
    const vaultDir = resolveRepoPath(vaultPath)

    // NÃO criamos o vault aqui de propósito: quando o vault_path do projeto
    // aponta pra pasta inexistente (typo, projeto renomeado), criar esconderia o
    // erro e espalharia pastas órfãs. Falhar com o path na mensagem é o que leva
    // o usuário a corrigir o caminho nas configurações do projeto.
    if (!existsSync(vaultDir)) {
      throw new Error(
        `A pasta do vault não existe: ${vaultDir}. Corrija o caminho do projeto nas configurações do projeto.`,
      )
    }

    const dest = path.join(vaultDir, label)

    // O destino pode já existir. Caso comum: um symlink órfão deixado por um
    // registro 'symlink' anterior que foi deletado. Tratamos antes do rename
    // (que falharia com EEXIST/ENOTEMPTY e seria engolido pela UI).
    const destStat = await lstat(dest).catch(() => null)
    if (destStat) {
      if (destStat.isSymbolicLink()) {
        // Artefato órfão: remove só o link (NÃO segue o alvo) e segue com o move.
        await unlink(dest)
      } else {
        throw new Error(`destino já existe: ${dest}`)
      }
    }

    try {
      await rename(source, dest)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await cp(source, dest, { recursive: true })
        await rm(source, { recursive: true, force: true })
      } else {
        throw err
      }
    }
    return { path: dest }
  })

  ipcMain.handle('repo:symlink-into-vault', async (_e, payload: unknown) => {
    const { source, vaultPath, label } = symlinkSchema.parse(payload)
    const dest = path.join(vaultPath, label)
    try {
      await symlink(source, dest)
    } catch (err) {
      throw new Error(`Falha ao criar symlink em ${dest}: ${(err as Error).message}`)
    }
    return { path: dest }
  })

  ipcMain.handle('repo:remove-symlink', async (_e, payload: unknown) => {
    const { target } = removeSymlinkSchema.parse(payload)
    const stat = await lstat(target).catch(() => null)
    if (!stat) return { removed: false }
    // Segurança: só removemos symlinks. Diretórios/arquivos reais são dados do
    // usuário e jamais devem ser apagados aqui.
    if (!stat.isSymbolicLink()) {
      throw new Error(`não é um symlink, recusando remover: ${target}`)
    }
    await unlink(target)
    return { removed: true }
  })

  ipcMain.handle('repo:clone-url', async (_e, payload: unknown) => {
    const { url, vaultPath } = cloneSchema.parse(payload)
    const dest = path.join(vaultPath, repoNameFromUrl(url))
    await simpleGit().clone(url, dest)
    // A persistência de remote_url/default_branch acontece no registro
    // (projects:repos:create), que deriva a origin do disco recém-clonado.
    // Devolvemos a URL usada só por transparência ao caller.
    return { path: dest, url }
  })

  // Idempotente: preenche remote_url/default_branch de repos ainda nulos cujo path
  // existe no disco. Exposto pra ser acionado no boot (gatilho ligado em fase
  // posterior) ou manualmente. Retorna { scanned, updated }.
  ipcMain.handle('repos:backfill-remotes', () => backfillRepoRemotes())

  // Repos registrados no DB cujo path não existe no disco mas têm remote_url.
  ipcMain.handle('repos:list-missing', () => listMissingRepos())

  // Clona os faltantes (concorrência limitada, credential-helper gh) com
  // progresso via toast. Retorna o resumo por-repo.
  ipcMain.handle('repos:clone-missing', () => cloneMissingWithToasts())

  // Pull ff-only de todos os repos locais (pula sujos/divergentes) com progresso
  // via toast. Retorna o resumo por-repo.
  ipcMain.handle('repos:pull-all', () => pullAllWithToasts('manual'))

  // Pull ff-only de um único repo, resolvido por repoId ou path.
  ipcMain.handle('repos:pull-one', (_e, payload: unknown) => {
    const sel = pullOneSchema.parse(payload)
    return pullOneRepo(sel)
  })

  // Última run de pull (auto ou manual) recortada por repo — alimenta o badge
  // "N atrás" na sidebar. null quando nunca rodou.
  ipcMain.handle('repos:last-run', () => getLastPullRun())

  ipcMain.handle('repo:create-blank', async (_e, payload: unknown) => {
    const { vaultPath, name, gitInit } = createBlankSchema.parse(payload)
    const result = validateBlankRepoName(name)
    if (!result.ok) {
      throw new Error(result.error)
    }
    // O nome validado não contém separadores → o join nunca escapa do vault.
    const dest = path.join(vaultPath, result.name)
    // lstat (e não existsSync) pra detectar também symlinks quebrados no destino.
    const destStat = await lstat(dest).catch(() => null)
    if (destStat) {
      throw new Error(`destino já existe: ${dest}`)
    }
    await mkdir(dest, { recursive: true })
    if (gitInit) {
      await simpleGit(dest).init()
    }
    return { path: dest }
  })
}
