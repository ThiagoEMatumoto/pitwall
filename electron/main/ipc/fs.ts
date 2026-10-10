import { ipcMain } from 'electron'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { readdirSync, statSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { z } from 'zod'
import { getDb } from '../services/db'
import { isInsideVault } from './git'
import type { FsEntry, FsFile } from '../../../shared/types/ipc'

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2MB

const pathSchema = z.object({ path: z.string().min(1) })
const writeSchema = z.object({ path: z.string().min(1), content: z.string() })

// Expande ~ para o homedir e resolve para caminho absoluto canônico.
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2))
  return p
}

// Raízes permitidas calculadas server-side. NUNCA confiar em roots vindos do
// renderer: a allowlist é a fronteira de segurança desta camada.
function allowedRoots(): string[] {
  const roots = new Set<string>()
  try {
    const db = getDb()
    const repos = db.prepare('SELECT path FROM repos').all() as { path: string }[]
    for (const r of repos) if (r.path) roots.add(path.resolve(r.path))
    const projects = db
      .prepare('SELECT vault_path FROM projects WHERE vault_path IS NOT NULL')
      .all() as { vault_path: string | null }[]
    for (const p of projects) if (p.vault_path) roots.add(path.resolve(p.vault_path))
  } catch {
    // DB indisponível — segue só com as raízes estáticas abaixo.
  }
  roots.add(path.join(homedir(), '.claude'))
  roots.add(path.resolve(tmpdir()))
  roots.add('/tmp')
  // Scratchpad do claude sai do tmpfs quando CLAUDE_CODE_TMPDIR está definido;
  // sem isto, clicar num path de scratch no terminal dá "fora do permitido".
  if (process.env.CLAUDE_CODE_TMPDIR) roots.add(path.resolve(process.env.CLAUDE_CODE_TMPDIR))
  return [...roots]
}

// Resolve symlinks ANTES de comparar para impedir escape via link simbólico.
// Para writes em arquivos ainda inexistentes, resolve o diretório PAI (que
// precisa existir) e recompõe o caminho final.
function realResolve(absPath: string): string {
  try {
    return realpathSync(absPath)
  } catch {
    const parent = realpathSync(path.dirname(absPath))
    return path.join(parent, path.basename(absPath))
  }
}

// Garante que o alvo está contido em alguma raiz permitida. Lança erro genérico
// (sem vazar conteúdo/stack) quando escapa.
function assertAllowed(targetPath: string): string {
  const abs = path.resolve(expandHome(targetPath))
  const real = realResolve(abs)
  const roots = allowedRoots()
  const allowed = roots.some((root) => {
    const realRoot = realResolve(root)
    return real === realRoot || isInsideVault(realRoot, real)
  })
  if (!allowed) throw new Error('Path fora do permitido')
  return real
}

export function registerFsIpc(): void {
  ipcMain.handle('fs:list-dir', (_e, raw: unknown): FsEntry[] => {
    const { path: target } = pathSchema.parse(raw)
    const dir = assertAllowed(target)
    const entries = readdirSync(dir, { withFileTypes: true })
    const visible = entries.filter((e) => e.name !== '.git' && e.name !== 'node_modules')
    const mapped: FsEntry[] = visible.map((e) => ({
      name: e.name,
      path: path.join(dir, e.name),
      isDir: e.isDirectory(),
    }))
    return mapped.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  })

  ipcMain.handle('fs:read-file', (_e, raw: unknown): FsFile => {
    const { path: target } = pathSchema.parse(raw)
    const file = assertAllowed(target)
    const size = statSync(file).size
    if (size > MAX_FILE_BYTES) {
      throw new Error('Arquivo muito grande (limite 2MB)')
    }
    const buf = readFileSync(file)
    if (buf.includes(0)) {
      throw new Error('Arquivo binário não suportado')
    }
    return { path: file, content: buf.toString('utf8') }
  })

  ipcMain.handle('fs:write-file', (_e, raw: unknown): void => {
    const { path: target, content } = writeSchema.parse(raw)
    const file = assertAllowed(target)
    writeFileSync(file, content, 'utf8')
  })
}
