import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, lstatSync, unlinkSync, readdirSync } from 'node:fs'
import { z } from 'zod'
import { getDb } from '../services/db'
import { pingSyncMutation } from '../services/notify'
import { readOriginUrl } from '../services/git-remote'
import { normalizePath, selectUntracked } from './untracked-folders'
import { resolveRepoPath } from '../services/repo-path'
import type {
  Project,
  Repo,
  CreateProjectInput,
  CreateRepoInput,
  LinkKind,
  UntrackedFolder,
} from '../../../shared/types/ipc'

const updateProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  vaultPath: z.string().nullable().optional(),
})

const updateRepoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  role: z.string().nullable().optional(),
})

const reorderReposSchema = z.object({
  projectId: z.string().min(1),
  repoIds: z.array(z.string().min(1)),
})

interface ProjectRow {
  id: string
  name: string
  color: string | null
  icon: string | null
  vault_path: string | null
  position: number
  created_at: number
  updated_at: number
}

interface RepoRow {
  id: string
  project_id: string
  label: string
  path: string
  role: string | null
  link_kind: string
  source: string | null
  position: number
  created_at: number
  canvas_x: number | null
  canvas_y: number | null
  is_hub: number
  remote_url: string | null
  default_branch: string | null
}

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  color: row.color,
  icon: row.icon,
  vaultPath: row.vault_path,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toRepo = (row: RepoRow): Repo => ({
  id: row.id,
  projectId: row.project_id,
  label: row.label,
  path: row.path,
  role: row.role,
  linkKind: row.link_kind as LinkKind,
  source: row.source,
  position: row.position,
  createdAt: row.created_at,
  canvasX: row.canvas_x ?? null,
  canvasY: row.canvas_y ?? null,
  isHub: row.is_hub === 1,
  remoteUrl: row.remote_url ?? null,
  defaultBranch: row.default_branch ?? null,
})

export function registerProjectIpc(): void {
  ipcMain.handle('projects:list', () => {
    const rows = getDb()
      .prepare('SELECT * FROM projects ORDER BY position ASC, updated_at DESC')
      .all() as ProjectRow[]
    return rows.map(toProject)
  })

  ipcMain.handle('projects:create', (_e, input: CreateProjectInput) => {
    const db = getDb()
    const now = Date.now()
    const maxPos = db
      .prepare('SELECT COALESCE(MAX(position), -1) as max FROM projects')
      .get() as { max: number }
    const row: ProjectRow = {
      id: randomUUID(),
      name: input.name,
      color: input.color ?? null,
      icon: input.icon ?? null,
      vault_path: input.vaultPath ?? null,
      position: maxPos.max + 1,
      created_at: now,
      updated_at: now,
    }
    if (row.vault_path) {
      mkdirSync(row.vault_path, { recursive: true })
    }
    db.prepare(
      'INSERT INTO projects (id, name, color, icon, vault_path, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      row.id,
      row.name,
      row.color,
      row.icon,
      row.vault_path,
      row.position,
      row.created_at,
      row.updated_at,
    )
    pingSyncMutation()
    return toProject(row)
  })

  ipcMain.handle('projects:reorder', (_e, raw: unknown) => {
    const ids = z.array(z.string().min(1)).parse(raw)
    const db = getDb()
    const setPos = db.prepare('UPDATE projects SET position = ? WHERE id = ?')
    db.transaction(() => ids.forEach((id, i) => setPos.run(i, id)))()
    pingSyncMutation()
  })

  ipcMain.handle('projects:update', (_e, raw: unknown) => {
    const input = updateProjectSchema.parse(raw)
    const db = getDb()

    const sets: string[] = []
    const values: unknown[] = []
    if (input.name !== undefined) {
      sets.push('name = ?')
      values.push(input.name)
    }
    if (input.color !== undefined) {
      sets.push('color = ?')
      values.push(input.color)
    }
    if (input.icon !== undefined) {
      sets.push('icon = ?')
      values.push(input.icon)
    }
    if (input.vaultPath !== undefined) {
      sets.push('vault_path = ?')
      values.push(input.vaultPath)
      if (input.vaultPath) mkdirSync(input.vaultPath, { recursive: true })
    }
    sets.push('updated_at = ?')
    values.push(Date.now())

    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, input.id)
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(input.id) as ProjectRow
    pingSyncMutation()
    return toProject(row)
  })

  ipcMain.handle('projects:delete', (_e, id: string) => {
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
    pingSyncMutation()
  })

  // Todos os repos de todos os projetos — alimenta a vista de arquitetura global.
  ipcMain.handle('projects:repos:list-all', () => {
    const rows = getDb()
      .prepare('SELECT * FROM repos ORDER BY project_id ASC, position ASC')
      .all() as RepoRow[]
    return rows.map(toRepo)
  })

  ipcMain.handle('projects:repos:list', (_e, projectId: string) => {
    const rows = getDb()
      .prepare(
        'SELECT * FROM repos WHERE project_id = ? ORDER BY position ASC, created_at ASC',
      )
      .all(projectId) as RepoRow[]
    return rows.map(toRepo)
  })

  ipcMain.handle('projects:repos:create', async (_e, input: CreateRepoInput) => {
    const db = getDb()
    // Guard anti-duplicata: o schema não tem UNIQUE(project_id, path), então a
    // adoção de uma pasta existente precisa ser idempotente. Se já houver repo no
    // mesmo projeto apontando pro mesmo path, devolve o existente em vez de duplicar.
    const target = normalizePath(input.path)
    const existing = (
      db
        .prepare('SELECT * FROM repos WHERE project_id = ?')
        .all(input.projectId) as RepoRow[]
    ).find((r) => normalizePath(r.path) === target)
    if (existing) return toRepo(existing)

    // Adopt/clone: o path já existe no disco → deriva a origin (URL + branch).
    // Repos blank/local-only sem remote ficam null (o backfill os ignora).
    const { remoteUrl, defaultBranch } = await readOriginUrl(input.path)

    const maxPos = db
      .prepare('SELECT COALESCE(MAX(position), -1) as max FROM repos WHERE project_id = ?')
      .get(input.projectId) as { max: number }
    const row: RepoRow = {
      id: randomUUID(),
      project_id: input.projectId,
      label: input.label,
      path: input.path,
      role: input.role ?? null,
      link_kind: input.linkKind ?? 'external',
      source: input.source ?? null,
      position: maxPos.max + 1,
      created_at: Date.now(),
      canvas_x: null,
      canvas_y: null,
      is_hub: 0,
      remote_url: remoteUrl,
      default_branch: defaultBranch,
    }
    db.prepare(
      'INSERT INTO repos (id, project_id, label, path, role, link_kind, source, position, created_at, remote_url, default_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      row.id,
      row.project_id,
      row.label,
      row.path,
      row.role,
      row.link_kind,
      row.source,
      row.position,
      row.created_at,
      row.remote_url,
      row.default_branch,
    )
    pingSyncMutation()
    return toRepo(row)
  })

  ipcMain.handle('projects:repos:update', (_e, raw: unknown) => {
    const input = updateRepoSchema.parse(raw)
    const db = getDb()

    const sets: string[] = []
    const values: unknown[] = []
    if (input.label !== undefined) {
      sets.push('label = ?')
      values.push(input.label)
    }
    if (input.role !== undefined) {
      sets.push('role = ?')
      values.push(input.role)
    }

    if (sets.length > 0) {
      db.prepare(`UPDATE repos SET ${sets.join(', ')} WHERE id = ?`).run(...values, input.id)
      pingSyncMutation()
    }
    const row = db.prepare('SELECT * FROM repos WHERE id = ?').get(input.id) as RepoRow
    return toRepo(row)
  })

  ipcMain.handle('projects:repos:delete', (_e, id: string) => {
    const db = getDb()
    const row = db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined

    // Limpeza de disco antes de remover do DB:
    // - symlink: remove o link do vault (alvo intacto).
    // - inside: NUNCA apaga o diretório real (é dado do usuário) — só sai do DB.
    // - external: nada no disco.
    if (row?.link_kind === 'symlink' && row.path) {
      try {
        // Defensivo: só removemos se de fato for um symlink no disco.
        if (lstatSync(row.path).isSymbolicLink()) {
          unlinkSync(row.path)
        }
      } catch {
        // Symlink já ausente / inacessível — não bloqueia a remoção do registro.
      }
    }

    db.prepare('DELETE FROM repos WHERE id = ?').run(id)
    pingSyncMutation()
  })

  ipcMain.handle('projects:repos:reorder', (_e, raw: unknown) => {
    const input = reorderReposSchema.parse(raw)
    const db = getDb()
    const setPos = db.prepare(
      'UPDATE repos SET position = ? WHERE id = ? AND project_id = ?',
    )
    db.transaction(() => input.repoIds.forEach((id, i) => setPos.run(i, id, input.projectId)))()
    pingSyncMutation()
  })

  // Lista pastas que existem no primeiro nível do vault do projeto mas ainda não
  // foram registradas como repo. Permite "adotar" pastas clonadas/criadas por fora
  // do app (caso clássico: clonou direto no vault e a pasta não aparece na sidebar).
  ipcMain.handle('vault:list-untracked', (_e, raw: unknown) => {
    const { projectId } = z.object({ projectId: z.string().min(1) }).parse(raw)
    const db = getDb()
    const project = db
      .prepare('SELECT vault_path FROM projects WHERE id = ?')
      .get(projectId) as { vault_path: string | null } | undefined
    const rawVaultPath = project?.vault_path
    if (!rawVaultPath) return [] as UntrackedFolder[]

    // Rows legados guardam path RELATIVO (ver repo-path.ts). Sem resolver, o
    // readdirSync resolveria contra o cwd do PROCESSO e `registered` (relativo)
    // nunca casaria com as entries (absolutas) — a pasta do próprio projeto
    // reaparecia como "não adicionada".
    const vaultPath = resolveRepoPath(rawVaultPath)
    const registered = (
      db.prepare('SELECT path FROM repos WHERE project_id = ?').all(projectId) as {
        path: string
      }[]
    ).map((r) => resolveRepoPath(r.path))

    try {
      const entries = readdirSync(vaultPath, { withFileTypes: true })
      return selectUntracked(vaultPath, entries, registered)
    } catch {
      // Vault aponta pra caminho inexistente/inacessível — sem sugestões.
      return [] as UntrackedFolder[]
    }
  })
}
