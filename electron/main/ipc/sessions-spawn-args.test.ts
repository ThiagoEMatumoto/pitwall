/** @vitest-environment node */
// O wake da hibernação é um sessions:resume. Contra os produtores reais (SQLite com
// as migrations do app, spawnSession e o handler sessions:resume), o comando que
// chega ao ptyManager.spawn no wake tem as MESMAS flags do spawn original.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from '../services/migrations/index'
import { SPAWNABLE_MODEL_ALIASES } from '../../../shared/models'

const { HOME } = vi.hoisted(() => ({
  HOME: `${process.env.TMPDIR ?? '/tmp'}/cm-spawn-args-${process.pid}-${Date.now()}`,
}))

const seam = vi.hoisted(() => ({
  db: null as unknown as import('better-sqlite3').Database,
  handlers: new Map<string, (event: unknown, ...args: never[]) => unknown>(),
  // Linha de comando de cada spawn real (o que o login shell executa).
  spawns: [] as { sessionId: string; argv: string }[],
  live: new Set<string>(),
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME }
})
vi.mock('electron', () => ({
  app: { getPath: () => `${HOME}/userdata`, getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: never[]) => unknown) => {
      seam.handlers.set(channel, fn)
    },
    on: () => {},
  },
}))
vi.mock('chokidar', () => ({
  default: { watch: () => ({ on: () => {}, close: async () => {} }) },
}))
vi.mock('../services/db', () => ({
  getDb: () => seam.db,
  handoffsInterruptedAtOpen: () => [],
}))
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    on: () => {},
    off: () => {},
    write: () => {},
    isRunning: (id: string) => seam.live.has(id),
    runningIds: () => [...seam.live],
    getPid: () => null,
    sessionIdByPid: () => null,
    spawn: (opts: { sessionId: string; command: string; args: string[] }) => {
      seam.spawns.push({ sessionId: opts.sessionId, argv: [opts.command, ...opts.args].join(' ') })
      seam.live.add(opts.sessionId)
    },
  },
}))
vi.mock('../services/custom-env', () => ({ sessionSpawnEnv: () => ({}) }))
vi.mock('../services/feature-memory', () => ({ featureMemory: { onSessionExit: () => {} } }))
vi.mock('../services/mcp/server', () => ({ getMcpRuntime: () => null }))
vi.mock('../services/mcp/config', () => ({
  mcpClientConfigPath: () => '/tmp/mcp.json',
  writeSessionMcpClientConfig: () => '/tmp/mcp-session.json',
  removeSessionMcpConfig: () => {},
}))
vi.mock('../services/notify', () => ({ broadcast: () => {} }))

import { registerSessionIpc, spawnSession } from './sessions'

const REPO_DIR = join(HOME, 'repo')
const MODEL = SPAWNABLE_MODEL_ALIASES[0]

function applyAllMigrations(db: Database.Database): void {
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

// Flags que o resume precisa reproduzir. O --append-system-prompt-file é um
// arquivo temporário novo a cada launch: compara-se o conteúdo, não o path.
const RELEVANT = /^--(model|effort|advisor|permission-mode|disallowedTools|settings)$/

function relevantFlags(argv: string): string[] {
  const tokens = argv.match(/'(?:[^']|'\\'')*'|\S+/g) ?? []
  const out: string[] = []
  let inFlag = false
  for (const t of tokens) {
    if (t.startsWith('--')) inFlag = RELEVANT.test(t)
    if (inFlag) out.push(t)
  }
  return out
}

function systemPromptOf(argv: string): string | null {
  const m = /--append-system-prompt-file '([^']+)'/.exec(argv)
  return m ? readFileSync(m[1], 'utf8') : null
}

function argvOf(sessionId: string): string {
  const s = seam.spawns.find((x) => x.sessionId === sessionId)
  if (!s) throw new Error(`sem spawn para ${sessionId}`)
  return s.argv
}

function ccOf(sessionId: string): string {
  return (
    seam.db.prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get(sessionId) as {
      cc_session_id: string
    }
  ).cc_session_id
}

// O /exit da hibernação: a PTY sai e o handler de exit marca a linha.
function exitPty(sessionId: string): void {
  seam.live.delete(sessionId)
  seam.db
    .prepare("UPDATE sessions SET status = 'exited', ended_at = ? WHERE id = ?")
    .run(Date.now(), sessionId)
}

// O wake (wakeDormantPane) chama sessions:resume com o repo e o cc da pane.
function wake(cc: string): string {
  const res = seam.handlers.get('sessions:resume')!(null, {
    repoId: 'r1',
    ccSessionId: cc,
  } as never) as { session: { id: string }; reattached: boolean }
  expect(res.reattached).toBe(false)
  return res.session.id
}

beforeEach(() => {
  seam.handlers.clear()
  seam.spawns = []
  seam.live.clear()
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(REPO_DIR, { recursive: true })
  mkdirSync(join(HOME, '.claude', 'sessions'), { recursive: true })
  seam.db = new Database(':memory:')
  seam.db.pragma('foreign_keys = ON')
  applyAllMigrations(seam.db)
  seam.db
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','P1',1,1)`)
    .run()
  seam.db
    .prepare(
      `INSERT INTO repos (id, project_id, label, path, position, created_at)
       VALUES ('r1','p1','Repo 1',?,0,1)`,
    )
    .run(REPO_DIR)
  registerSessionIpc()
})

afterEach(() => {
  seam.db.close()
})

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
})

function writeTranscript(cc: string): void {
  const dir = join(HOME, '.claude', 'projects', 'p')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${cc}.jsonl`), '')
}

describe('wake da hibernação reaplica as flags do spawn', () => {
  it('--permission-mode + --model + effort/advisor/denylist + system prompt: mesmo argv no wake', () => {
    const spawned = spawnSession({
      repoId: 'r1',
      name: 'infra',
      permissionMode: 'acceptEdits',
      model: MODEL,
      effort: 'high',
      advisorModel: 'opus',
      disallowedTools: ['Bash(curl:*)'],
      systemPromptText: 'Responda sempre em inglês.',
    } as never)
    const cc = ccOf(spawned.id)
    writeTranscript(cc)
    const before = argvOf(spawned.id)
    // acceptEdits é autônomo: o denylist destrutivo canônico entra depois do pedido.
    expect(relevantFlags(before).slice(0, 10)).toEqual([
      '--model',
      `'${MODEL}'`,
      '--effort',
      "'high'",
      '--advisor',
      "'opus'",
      '--permission-mode',
      "'acceptEdits'",
      '--disallowedTools',
      "'Bash(curl:*)'",
    ])
    expect(relevantFlags(before)).toContain("'Bash(rm:*)'")

    exitPty(spawned.id)
    const woke = wake(cc)
    const after = argvOf(woke)
    expect(after).toContain(`--resume ${cc}`)
    expect(relevantFlags(after)).toEqual(relevantFlags(before))
    expect(systemPromptOf(after)).toContain('Responda sempre em inglês.')

    // Segunda hibernação: a linha do wake guardou as flags, a cadeia não as perde.
    exitPty(woke)
    expect(relevantFlags(argvOf(wake(cc)))).toEqual(relevantFlags(before))
  })

  it('modo autônomo: o denylist destrutivo canônico volta junto', () => {
    const spawned = spawnSession({
      repoId: 'r1',
      name: 'auto',
      permissionMode: 'bypassPermissions',
    } as never)
    const cc = ccOf(spawned.id)
    writeTranscript(cc)
    const before = relevantFlags(argvOf(spawned.id))
    expect(before).toContain("'bypassPermissions'")
    expect(before.length).toBeGreaterThan(4)
    exitPty(spawned.id)
    expect(relevantFlags(argvOf(wake(cc)))).toEqual(before)
  })

  it('filha de handoff já terminada (sem relink): volta em plan e com o --settings dela', () => {
    const spawned = spawnSession({
      repoId: 'r1',
      name: 'filha-plan',
      permissionMode: 'plan',
      handoffChild: true,
    } as never)
    const cc = ccOf(spawned.id)
    writeTranscript(cc)
    const before = relevantFlags(argvOf(spawned.id))
    expect(before).toContain('--settings')
    expect(before).toContain("'plan'")
    exitPty(spawned.id)
    expect(relevantFlags(argvOf(wake(cc)))).toEqual(before)
  })

  it('conversa sem registro (linha de antes da 061): resume sem flags, como antes', () => {
    const cc = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    writeTranscript(cc)
    seam.db
      .prepare(
        `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at)
         VALUES ('old', 'r1', ?, 'exited', 1)`,
      )
      .run(cc)
    expect(relevantFlags(argvOf(wake(cc)))).toEqual([])
  })

  it('spawn_args adulterado no banco: o resume revalida pelas whitelists', () => {
    const cc = '3f2504e0-4f89-11d3-9a0c-0305e82c3302'
    writeTranscript(cc)
    seam.db
      .prepare(
        `INSERT INTO sessions (id, repo_id, cc_session_id, status, started_at, spawn_args)
         VALUES ('old', 'r1', ?, 'exited', 1, ?)`,
      )
      .run(cc, JSON.stringify({ model: "x'; rm -rf ~", permissionMode: 'yolo', effort: 'high' }))
    expect(relevantFlags(argvOf(wake(cc)))).toEqual(['--effort', "'high'"])
  })
})
