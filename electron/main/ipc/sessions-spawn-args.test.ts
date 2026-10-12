/** @vitest-environment node */
// O wake da hibernação é um sessions:resume. Contra os produtores reais (SQLite com
// as migrations do app, spawnSession, o handler de exit da PTY e o sessions:resume),
// o comando que chega ao ptyManager.spawn no wake tem as MESMAS flags do spawn
// original. O resume manual só herda o cwd.
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
  // settings: conteúdo do --settings lido NO spawn (o exit apaga o arquivo);
  // null = o argv não tem --settings ou o arquivo não existia.
  spawns: [] as {
    sessionId: string
    argv: string
    cwd: string
    settingsPath: string | null
    settings: string | null
  }[],
  live: new Set<string>(),
  // Registrado uma vez por módulo (listenersAttached): não se limpa entre testes.
  exitHandlers: [] as ((e: { sessionId: string; exitCode: number }) => void)[],
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
vi.mock('../services/pty-manager', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ptyManager: {
    on: (event: string, fn: (e: { sessionId: string; exitCode: number }) => void) => {
      if (event === 'exit') seam.exitHandlers.push(fn)
    },
    off: () => {},
    write: () => {},
    isRunning: (id: string) => seam.live.has(id),
    runningIds: () => [...seam.live],
    getPid: () => null,
    sessionIdByPid: () => null,
    spawn: (opts: { sessionId: string; command: string; args: string[]; cwd: string }) => {
      const argv = [opts.command, ...opts.args].join(' ')
      const settingsPath = /--settings '([^']+)'/.exec(argv)?.[1] ?? null
      seam.spawns.push({
        sessionId: opts.sessionId,
        argv,
        cwd: opts.cwd,
        settingsPath,
        settings:
          settingsPath && fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null,
      })
      seam.live.add(opts.sessionId)
    },
  } }
})
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
import { IdleHibernator, setIdleHibernator } from '../services/hibernate/idle-hibernator'
import { markHibernated, unmarkHibernated } from '../services/hibernate/hibernated-store'
import { parseSpawnArgs } from '../services/spawn-args'

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

// Flags que o resume precisa reproduzir. O --append-system-prompt-file e o
// --settings são arquivos novos a cada launch: compara-se o conteúdo, não o path.
const RELEVANT = /^--(model|effort|advisor|permission-mode|disallowedTools|settings)$/

function relevantFlags(argv: string): string[] {
  const tokens = argv.match(/'(?:[^']|'\\'')*'|\S+/g) ?? []
  const out: string[] = []
  let inFlag = false
  let prev = ''
  for (const t of tokens) {
    if (t.startsWith('--')) inFlag = RELEVANT.test(t)
    if (inFlag) out.push(prev === '--settings' ? '<settings>' : t)
    prev = t
  }
  return out
}

function spawnOf(sessionId: string): (typeof seam.spawns)[number] {
  const s = seam.spawns.find((x) => x.sessionId === sessionId)
  if (!s) throw new Error(`sem spawn para ${sessionId}`)
  return s
}

// Conteúdo do --settings como estava no disco no momento do spawn.
function settingsOf(sessionId: string): {
  crossSessionInbound?: string
  permissions?: { deny?: string[] }
} | null {
  const raw = spawnOf(sessionId).settings
  return raw ? JSON.parse(raw) : null
}

// O que o wake precisa reproduzir: as flags + o arquivo de settings.
function launchOf(sessionId: string): { flags: string[]; settings: unknown } {
  return { flags: relevantFlags(argvOf(sessionId)), settings: settingsOf(sessionId) }
}

function systemPromptOf(argv: string): string | null {
  const m = /--append-system-prompt-file '([^']+)'/.exec(argv)
  return m ? readFileSync(m[1], 'utf8') : null
}

function cwdOf(sessionId: string): string {
  const s = seam.spawns.find((x) => x.sessionId === sessionId)
  if (!s) throw new Error(`sem spawn para ${sessionId}`)
  return s.cwd
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

// A PTY sai pelo handler de exit real (ele marca a linha e consulta o hibernator).
// hibernated = o exit foi o /exit da hibernação: o hibernator devolve o evento.
function exitPty(sessionId: string, opts: { hibernated: boolean; cc?: string }): void {
  const cc = opts.cc ?? ccOf(sessionId)
  setIdleHibernator({
    onExit: (id: string) =>
      opts.hibernated && id === sessionId ? { sessionId, ccSessionId: cc, paneId: 'pane-1' } : null,
  } as never)
  seam.live.delete(sessionId)
  for (const fn of seam.exitHandlers) fn({ sessionId, exitCode: 0 })
  setIdleHibernator(null)
}

function hibernate(sessionId: string, cc?: string): void {
  exitPty(sessionId, { hibernated: true, cc })
}

function resume(cc: string, fromHibernation?: boolean): string {
  const res = seam.handlers.get('sessions:resume')!(null, {
    repoId: 'r1',
    ccSessionId: cc,
    ...(fromHibernation === undefined ? {} : { fromHibernation }),
  } as never) as { session: { id: string }; reattached: boolean }
  expect(res.reattached).toBe(false)
  return res.session.id
}

// O wake (wakeDormantPane) de uma pane hibernada.
function wake(cc: string): string {
  return resume(cc, true)
}

function openDb(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  return db
}

beforeEach(() => {
  seam.handlers.clear()
  seam.spawns = []
  seam.live.clear()
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(REPO_DIR, { recursive: true })
  mkdirSync(join(HOME, '.claude', 'sessions'), { recursive: true })
  // Arquivo real: o teste de restart fecha e reabre o mesmo app.db.
  seam.db = openDb(join(HOME, 'app.db'))
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
    const before = launchOf(spawned.id)
    // acceptEdits é autônomo: o denylist destrutivo canônico entra depois do pedido,
    // e tudo vai no arquivo de --settings, não no argv.
    expect(before.flags).toEqual([
      '--model',
      `'${MODEL}'`,
      '--effort',
      "'high'",
      '--advisor',
      "'opus'",
      '--permission-mode',
      "'acceptEdits'",
      '--settings',
      '<settings>',
    ])
    expect(settingsOf(spawned.id)?.permissions?.deny?.slice(0, 1)).toEqual(['Bash(curl:*)'])
    expect(settingsOf(spawned.id)?.permissions?.deny).toContain('Bash(rm:*)')

    hibernate(spawned.id)
    const woke = wake(cc)
    const after = argvOf(woke)
    expect(after).toContain(`--resume ${cc}`)
    expect(launchOf(woke)).toEqual(before)
    expect(systemPromptOf(after)).toContain('Responda sempre em inglês.')

    // Segunda hibernação: a linha do wake guardou as flags, a cadeia não as perde.
    hibernate(woke)
    expect(launchOf(wake(cc))).toEqual(before)
  })

  it('modo autônomo: o denylist destrutivo canônico volta junto', () => {
    const spawned = spawnSession({
      repoId: 'r1',
      name: 'auto',
      permissionMode: 'bypassPermissions',
    } as never)
    const cc = ccOf(spawned.id)
    writeTranscript(cc)
    const before = launchOf(spawned.id)
    expect(before.flags).toContain("'bypassPermissions'")
    expect(settingsOf(spawned.id)?.permissions?.deny).toContain('Bash(rm:*)')
    hibernate(spawned.id)
    expect(launchOf(wake(cc))).toEqual(before)
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
    const before = launchOf(spawned.id)
    expect(before.flags).toContain('--settings')
    expect(before.flags).toContain("'plan'")
    expect(settingsOf(spawned.id)?.crossSessionInbound).toBe('accept')
    hibernate(spawned.id)
    expect(launchOf(wake(cc))).toEqual(before)
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
    hibernate('old', cc)
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
    hibernate('old', cc)
    expect(relevantFlags(argvOf(wake(cc)))).toEqual(['--effort', "'high'"])
  })
})

describe('wake da hibernação volta no cwd do spawn', () => {
  const WORKTREE = join(HOME, 'worktree-b')

  // O vínculo da sessão muda para uma feature com worktree registrado para r1.
  function relinkToFeatureWithWorktree(sessionId: string): void {
    mkdirSync(WORKTREE, { recursive: true })
    seam.db
      .prepare(
        `INSERT INTO features (id, project_id, slug, title, status, doc_path, created_at, updated_at)
         VALUES ('f1', 'p1', 'f1', 'F1', 'in-progress', 'f1.md', 1, 1)`,
      )
      .run()
    seam.db
      .prepare(
        `INSERT INTO feature_repos (feature_id, repo_id, worktree_path) VALUES ('f1', 'r1', ?)`,
      )
      .run(WORKTREE)
    seam.db.prepare(`UPDATE sessions SET feature_id = 'f1' WHERE id = ?`).run(sessionId)
  }

  it('nasce na raiz (A), feature_id muda para worktree B, hiberna e acorda em A', () => {
    const spawned = spawnSession({ repoId: 'r1', name: 'raiz' } as never)
    expect(cwdOf(spawned.id)).toBe(REPO_DIR)
    const cc = ccOf(spawned.id)
    writeTranscript(cc)
    relinkToFeatureWithWorktree(spawned.id)

    hibernate(spawned.id)
    const woke = wake(cc)
    expect(cwdOf(woke)).toBe(REPO_DIR)
    // A linha do wake carimba o mesmo cwd: a segunda hibernação também volta em A.
    hibernate(woke)
    expect(cwdOf(wake(cc))).toBe(REPO_DIR)
  })

  it('cwd gravado que sumiu do disco: cai no recalculado (worktree B)', () => {
    const spawned = spawnSession({ repoId: 'r1', name: 'sumiu' } as never)
    const cc = ccOf(spawned.id)
    writeTranscript(cc)
    relinkToFeatureWithWorktree(spawned.id)
    const gone = join(HOME, 'removido')
    seam.db
      .prepare(`UPDATE sessions SET spawn_args = json_set(spawn_args, '$.cwd', ?) WHERE id = ?`)
      .run(gone, spawned.id)

    hibernate(spawned.id)
    expect(cwdOf(wake(cc))).toBe(WORKTREE)
  })
})

describe('resume manual: só o cwd do spawn volta', () => {
  const WORKTREE = join(HOME, 'worktree-m')

  function spawnWithFlags(name: string): { id: string; cc: string } {
    const spawned = spawnSession({
      repoId: 'r1',
      name,
      permissionMode: 'acceptEdits',
      model: MODEL,
      effort: 'high',
      systemPromptText: 'Responda sempre em inglês.',
    } as never)
    const cc = ccOf(spawned.id)
    writeTranscript(cc)
    expect(argvOf(spawned.id)).toContain("--permission-mode 'acceptEdits'")
    expect(argvOf(spawned.id)).toContain(`--model '${MODEL}'`)
    // O vínculo muda para um worktree: o cwd recalculado não seria o da conversa.
    mkdirSync(WORKTREE, { recursive: true })
    seam.db
      .prepare(
        `INSERT INTO features (id, project_id, slug, title, status, doc_path, created_at, updated_at)
         VALUES ('fm', 'p1', 'fm', 'FM', 'in-progress', 'fm.md', 1, 1)`,
      )
      .run()
    seam.db
      .prepare(
        `INSERT INTO feature_repos (feature_id, repo_id, worktree_path) VALUES ('fm', 'r1', ?)`,
      )
      .run(WORKTREE)
    seam.db.prepare(`UPDATE sessions SET feature_id = 'fm' WHERE id = ?`).run(spawned.id)
    return { id: spawned.id, cc }
  }

  function expectDefaultFlags(sessionId: string): void {
    const argv = argvOf(sessionId)
    expect(argv).not.toContain('acceptEdits')
    expect(argv).not.toContain(`--model '${MODEL}'`)
    expect(relevantFlags(argv)).toEqual([])
    expect(systemPromptOf(argv) ?? '').not.toContain('Responda sempre em inglês.')
  }

  it('--permission-mode X --model Y: o argv do resume não tem X/Y, mas usa o cwd gravado', () => {
    const { id, cc } = spawnWithFlags('manual')
    exitPty(id, { hibernated: false })
    const resumed = resume(cc)
    expect(argvOf(resumed)).toContain(`--resume ${cc}`)
    expectDefaultFlags(resumed)
    expect(cwdOf(resumed)).toBe(REPO_DIR)
  })

  it('fromHibernation sem hibernação de fato: o main não reaplica as flags', () => {
    const { id, cc } = spawnWithFlags('forjado')
    exitPty(id, { hibernated: false })
    expectDefaultFlags(wake(cc))
  })

  // Quem decide é o sessions.hibernated_at, não o fromHibernation do renderer: a
  // conversa hibernada volta com as flags por qualquer caminho de resume.
  it('hibernada retomada à mão (aba fechada): volta com as flags, uma vez', () => {
    const { id, cc } = spawnWithFlags('fechada')
    hibernate(id)
    const resumed = resume(cc)
    expect(argvOf(resumed)).toContain("--permission-mode 'acceptEdits'")
    expect(cwdOf(resumed)).toBe(REPO_DIR)
    // O estado é consumido no resume: o seguinte, sem hibernação, é manual.
    exitPty(resumed, { hibernated: false })
    expectDefaultFlags(resume(cc))
  })

  it('resume manual não apaga as flags gravadas: a hibernação seguinte as reaplica', () => {
    const { id, cc } = spawnWithFlags('preserva')
    exitPty(id, { hibernated: false })
    const resumed = resume(cc)
    expectDefaultFlags(resumed)
    const row = seam.db.prepare('SELECT spawn_args FROM sessions WHERE id = ?').get(resumed) as {
      spawn_args: string
    }
    expect(parseSpawnArgs(row.spawn_args)).toMatchObject({
      permissionMode: 'acceptEdits',
      model: MODEL,
      effort: 'high',
      systemPromptText: 'Responda sempre em inglês.',
      cwd: REPO_DIR,
    })
    hibernate(resumed)
    const woke = wake(cc)
    expect(argvOf(woke)).toContain("--permission-mode 'acceptEdits'")
    expect(argvOf(woke)).toContain(`--model '${MODEL}'`)
  })

  it('wake da hibernada: o argv tem X/Y e o cwd gravado', () => {
    const { id, cc } = spawnWithFlags('acorda')
    hibernate(id)
    const woke = wake(cc)
    expect(argvOf(woke)).toContain("--permission-mode 'acceptEdits'")
    expect(argvOf(woke)).toContain(`--model '${MODEL}'`)
    expect(systemPromptOf(argvOf(woke))).toContain('Responda sempre em inglês.')
    expect(cwdOf(woke)).toBe(REPO_DIR)
  })
})

describe('estado "hibernada" no app.db sobrevive a restart', () => {
  // O IdleHibernator real com a mesma ligação de persistência do hibernate.ts: o
  // beforeWrite grava antes de a fila escrever o /exit, e o exit da PTY sai pelo
  // handler real.
  function realHibernator(persist: (sessionId: string, on: boolean) => void): IdleHibernator {
    const unused = (): never => {
      throw new Error('gate fora do escopo')
    }
    const h: IdleHibernator = new IdleHibernator({
      lazyRestore: () => true,
      afterMin: () => 30,
      candidates: unused,
      hasPane: unused,
      confirmPane: unused,
      registerDormant: () => {},
      persistHibernating: persist,
      lastIoAt: unused,
      sessionFile: unused,
      isPidAlive: unused,
      aliveSessionId: unused,
      activeHandoffCcSessionIds: unused,
      isHandoffChild: unused,
      queueHas: unused,
      agentMessageSince: unused,
      transcriptPath: unused,
      scanTranscript: unused,
      procTree: unused,
      // A PromptQueue chama beforeWrite logo antes de escrever no PTY.
      send: async (input) =>
        h.beforeWrite(input.sessionId, input.text, false)
          ? { ok: true, delivered: true }
          : { ok: false, error: 'not-running' },
      cancel: () => {},
      replaceText: () => true,
      warn: () => {},
    })
    return h
  }

  const persistToDb = (sessionId: string, on: boolean): void =>
    on ? markHibernated(seam.db, sessionId) : unmarkHibernated(seam.db, sessionId)

  function hibernatedAt(sessionId: string): number | null {
    return (
      seam.db.prepare('SELECT hibernated_at FROM sessions WHERE id = ?').get(sessionId) as {
        hibernated_at: number | null
      }
    ).hibernated_at
  }

  it('hiberna, o app reinicia (Set e hibernator zerados, banco reaberto) e o wake volta com as flags', async () => {
    const spawned = spawnSession({
      repoId: 'r1',
      name: 'restart',
      permissionMode: 'acceptEdits',
      model: MODEL,
      effort: 'high',
      disallowedTools: ['Bash(curl:*)'],
      systemPromptText: 'Responda sempre em inglês.',
    } as never)
    const cc = ccOf(spawned.id)
    writeTranscript(cc)
    const before = launchOf(spawned.id)
    const oldSettingsPath = spawnOf(spawned.id).settingsPath

    const h = realHibernator(persistToDb)
    setIdleHibernator(h)
    expect(await h.hibernate({ sessionId: spawned.id, ccSessionId: cc }, 'pane-1')).toBe(true)
    // Gravado antes do exit: uma queda de energia aqui não perde o estado.
    expect(hibernatedAt(spawned.id)).not.toBeNull()
    seam.live.delete(spawned.id)
    for (const fn of seam.exitHandlers) fn({ sessionId: spawned.id, exitCode: 0 })
    setIdleHibernator(null)

    // Restart: nada em memória sobre a hibernação; o app.db é reaberto do disco.
    seam.db.close()
    seam.db = openDb(join(HOME, 'app.db'))
    // Depois do restart a pane volta dormant sem dormantReason: fromHibernation false.
    const woke = resume(cc, false)
    expect(launchOf(woke)).toEqual(before)
    // Regressão: o wake reusava o --settings da sessão anterior, apagado no exit
    // dela ("Settings file not found"), e punha a denylist de volta no argv.
    const wokeSpawn = spawnOf(woke)
    expect(oldSettingsPath).not.toBeNull()
    expect(wokeSpawn.settingsPath).not.toBeNull()
    expect(wokeSpawn.settingsPath).not.toBe(oldSettingsPath)
    expect(wokeSpawn.settings).not.toBeNull()
    expect(settingsOf(woke)?.permissions?.deny).toEqual(
      expect.arrayContaining(['Bash(curl:*)', 'Bash(pkill:*)', 'Bash(killall:*)']),
    )
    expect(wokeSpawn.argv).not.toContain('{')
    expect(wokeSpawn.argv).not.toContain('Bash(')
    expect(wokeSpawn.argv).toContain(`--model '${MODEL}'`)
    expect(wokeSpawn.argv).toContain("--effort 'high'")
    expect(wokeSpawn.argv).toContain("--permission-mode 'acceptEdits'")
    expect(systemPromptOf(argvOf(woke))).toContain('Responda sempre em inglês.')
    // Consumido pelo wake; a linha nova copia as flags para a próxima hibernação.
    expect(hibernatedAt(spawned.id)).toBeNull()
    expect(parseSpawnArgs(
      (seam.db.prepare('SELECT spawn_args FROM sessions WHERE id = ?').get(woke) as {
        spawn_args: string
      }).spawn_args,
    )).toMatchObject({ permissionMode: 'acceptEdits', model: MODEL })

    // Resume manual depois do wake: sem flags no argv, mas o registro continua com elas.
    seam.live.delete(woke)
    for (const fn of seam.exitHandlers) fn({ sessionId: woke, exitCode: 0 })
    const manual = resume(cc)
    expect(relevantFlags(argvOf(manual))).toEqual([])
    const row = seam.db.prepare('SELECT spawn_args FROM sessions WHERE id = ?').get(manual) as {
      spawn_args: string
    }
    expect(parseSpawnArgs(row.spawn_args)).toMatchObject({
      permissionMode: 'acceptEdits',
      model: MODEL,
      effort: 'high',
      disallowedTools: expect.arrayContaining(['Bash(curl:*)']),
    })
  })

  it('banco recusa gravar o estado: o /exit não sai e a sessão segue viva', async () => {
    const spawned = spawnSession({ repoId: 'r1', name: 'sem-banco' } as never)
    const cc = ccOf(spawned.id)
    const h = realHibernator(() => {
      throw new Error('SQLITE_FULL')
    })
    expect(await h.hibernate({ sessionId: spawned.id, ccSessionId: cc }, 'pane-1')).toBe(false)
    expect(h.isHibernating(spawned.id)).toBe(false)
    expect(h.getStats().refused['guard-held']).toBe(1)
  })
})
