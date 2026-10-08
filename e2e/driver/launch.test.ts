// @vitest-environment node
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/services/migrations/index'
import type { PaneSnapshot } from '../../shared/types/ipc'
import { queryDb } from './inspect'
import { copyRealUserData, inheritedEnv } from './launch'

const PANES: PaneSnapshot[] = [
  { ccSessionId: 'real-cc-1', repo: null, projectName: null, projectIcon: null, paneId: 'pane-1' },
  { ccSessionId: 'real-cc-2', repo: null, projectName: null, projectIcon: null, paneId: 'pane-2' },
]

let realDir: string
let writer: Database.Database
const originalOverride = process.env.CM_REAL_USERDATA
const copies: string[] = []

// Perfil "real" com o schema das migrations do app e o app AINDA ABERTO (writer
// vivo em WAL): o estado das abas vive só no -wal, como na máquina do usuário.
function openLiveProfile(): Database.Database {
  const db = new Database(join(realDir, 'app.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  runMigrations(db)
  const now = Date.now()
  db.prepare(
    'INSERT INTO workspace_state (id, last_opened_at, open_panes, dock_layout) VALUES (1, ?, ?, ?)',
  ).run(now, JSON.stringify(PANES), '{"grid":{}}')
  db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)").run(
    now,
    now,
  )
  db.prepare(
    "INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES ('r1','p1','R1','/tmp/r1',0,?), ('r2','p1','R2','/tmp/r2',1,?)",
  ).run(now, now)
  // Repos distintos: um handoff ativo por repo (índice da migration 054).
  const insertHandoff = db.prepare(
    `INSERT INTO handoffs (id, target_repo_id, task, composed_prompt, status, mode, created_at, updated_at)
     VALUES (?, ?, 'tarefa', 'prompt', ?, 'interactive', ?, ?)`,
  )
  insertHandoff.run('h-pending', 'r1', 'pending', now, now)
  insertHandoff.run('h-running', 'r2', 'running', now, now)
  return db
}

function copy(restoreTabs: boolean): string {
  const dir = copyRealUserData(restoreTabs)
  copies.push(dir)
  return dir
}

beforeEach(() => {
  realDir = mkdtempSync(join(tmpdir(), 'cm-launch-test-real-'))
  process.env.CM_REAL_USERDATA = realDir
  writer = openLiveProfile()
})

afterEach(() => {
  writer.close()
  rmSync(realDir, { recursive: true, force: true })
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (originalOverride === undefined) delete process.env.CM_REAL_USERDATA
  else process.env.CM_REAL_USERDATA = originalOverride
})

describe('copyRealUserData — gatilhos de spawn no boot', () => {
  it('o fixture tem as abas só no -wal (o app real está aberto)', async () => {
    expect(existsSync(join(realDir, 'app.db-wal'))).toBe(true)
    await expect(queryDb(realDir, 'SELECT open_panes FROM workspace_state')).rejects.toThrow(
      /no such table/,
    )
  })

  it('esvazia open_panes e dock_layout na cópia', async () => {
    const dir = copy(false)
    const rows = await queryDb<{ open_panes: string | null; dock_layout: string | null }>(
      dir,
      'SELECT open_panes, dock_layout FROM workspace_state WHERE id = 1',
    )
    expect(rows).toEqual([{ open_panes: null, dock_layout: null }])
  })

  it('tira da fila os handoffs pending (o boot os aprovaria e spawnaria a filha)', async () => {
    const dir = copy(false)
    const rows = await queryDb<{ id: string; status: string }>(
      dir,
      'SELECT id, status FROM handoffs ORDER BY id',
    )
    expect(rows).toEqual([
      { id: 'h-pending', status: 'rejected' },
      { id: 'h-running', status: 'running' },
    ])
  })

  it('deixa o app.db da cópia autocontido (sem -wal pendente)', () => {
    const dir = copy(false)
    expect(existsSync(join(dir, 'app.db-wal'))).toBe(false)
  })

  it('restoreTabs:true mantém abas e handoffs intactos', () => {
    const dir = copy(true)
    const db = new Database(join(dir, 'app.db'), { readonly: true })
    try {
      const ws = db.prepare('SELECT open_panes FROM workspace_state WHERE id = 1').get() as {
        open_panes: string
      }
      expect(JSON.parse(ws.open_panes)).toEqual(PANES)
      const pending = db.prepare("SELECT id FROM handoffs WHERE status = 'pending'").all()
      expect(pending).toEqual([{ id: 'h-pending' }])
    } finally {
      db.close()
    }
  })

  it('nunca toca o perfil real', () => {
    copy(false)
    const ws = writer.prepare('SELECT open_panes FROM workspace_state WHERE id = 1').get() as {
      open_panes: string
    }
    expect(JSON.parse(ws.open_panes)).toEqual(PANES)
    const h = writer.prepare("SELECT status FROM handoffs WHERE id = 'h-pending'").get()
    expect(h).toEqual({ status: 'pending' })
  })
})

describe('inheritedEnv', () => {
  it('tira os marcadores de sessão Claude Code do env do Electron', () => {
    const env = inheritedEnv({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', PATH: '/bin' })
    expect(env).toEqual({ PATH: '/bin' })
  })
})
