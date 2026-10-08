// Apoio dos testes da projeção: banco migrado de verdade e telas capturadas do
// claude real. Nada aqui monta Handoff/estado à mão — quem escreve é o store.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import xtermHeadless from '@xterm/headless'
import { migrations } from '../migrations/index'
import { scanScreen, type ScreenScan } from '../../../../shared/tui/attention-reason'
import type { AttentionLiveSession } from '../../../../shared/types/attention'
import type { LiveSessionInfo } from '../../../../shared/types/ipc'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

export function applyAllMigrations(db: Database.Database): void {
  for (const m of migrations) {
    if (m.disableForeignKeys) {
      db.pragma('foreign_keys = OFF')
      try {
        m.up(db)
      } finally {
        db.pragma('foreign_keys = ON')
      }
    } else {
      m.up(db)
    }
  }
}

// Um projeto e N repos: o índice da 054 permite um handoff ativo por repo.
export function seedRepos(db: Database.Database, count = 6): void {
  const now = Date.now()
  db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',?,?)`).run(
    now,
    now,
  )
  const insert = db.prepare(
    `INSERT INTO repos (id, project_id, label, path, position, created_at) VALUES (?, 'p1', ?, ?, ?, ?)`,
  )
  for (let i = 1; i <= count; i++) insert.run(`r${i}`, `Repo ${i}`, `/tmp/r${i}`, i, now)
}

// cc_session_id é UUID de verdade: o resumable do store só reconhece transcript
// de id nativo válido.
export function seedSession(
  db: Database.Database,
  id: string,
  opts: { repoId?: string | null; featureId?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at, feature_id)
     VALUES (?, ?, ?, 'running', ?, ?)`,
  ).run(id, opts.repoId ?? 'r1', randomUUID(), Date.now(), opts.featureId ?? null)
}

export function seedFeature(db: Database.Database, id: string): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO features (id, project_id, slug, title, status, doc_path, created_at, updated_at)
     VALUES (?, 'p1', ?, ?, 'in_progress', ?, ?, ?)`,
  ).run(id, id, id, `/tmp/${id}.md`, now, now)
}

const FIXTURES = join(__dirname, '../../../../shared/tui/__fixtures__')

export type ScreenFixture = 'idle-prompt' | 'permission-bash'

// Mesma renderização do pty-manager (80x24) sobre a captura BRUTA do claude 2.1.286.
export async function scanFixture(name: ScreenFixture): Promise<ScreenScan> {
  const raw = readFileSync(join(FIXTURES, `claude-2.1.286-${name}.ansi`), 'utf8')
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(raw, resolve))
  const readTail = (n: number) => {
    const buf = term.buffer.active
    let text = ''
    for (let y = Math.max(0, buf.length - n); y < buf.length; y++) {
      text += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
    }
    return text
  }
  return scanScreen(readTail, 1000)
}

// O ÚNICO shape sintético dos testes de superfície: a LiveSessionInfo que o
// renderer recebe de sessions:list-live-global. Copia só o que o mapeamento lê
// (id, ccSessionId do banco, status e o motivo da tela); o resto é do teste.
export function toLiveInfo(
  db: Database.Database,
  s: AttentionLiveSession,
  over: Partial<LiveSessionInfo> = {},
): LiveSessionInfo {
  const row = db.prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get(s.sessionId) as {
    cc_session_id: string
  }
  return {
    id: s.sessionId,
    ccSessionId: row.cc_session_id,
    status: s.status,
    attentionReason: s.screenReason,
    name: null,
    title: null,
    repo: null,
    projectName: 'proj',
    projectIcon: null,
    projectColor: null,
    lastActivityAt: s.lastActivityAt,
    lastText: null,
    ...over,
  }
}
