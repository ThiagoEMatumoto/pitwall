/** @vitest-environment node */
// O vínculo sessão↔feature nos DOIS caminhos de spawn:
//  - `sessions:resume` herda o feature_id e recebe o MESMO bloco de contexto do
//    spawn (pulso/vitalidade/ponteiro do loop) — antes o resume nascia mudo;
//  - `sessions:list-by-feature` devolve o histórico de sessões da feature;
//  - `sessions:list-by-repo` carrega id interno + feature_id (a marca da frente
//    nas listas por repo), colapsando as várias linhas de uma mesma cc_session_id;
//  - o cwd respeita o worktree registrado em feature_repos (com fallback pro repo).
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted: as fábricas de vi.mock rodam antes de qualquer const do módulo.
const { REPO_PATH, WORKTREE_PATH, CC_SESSION_ID } = vi.hoisted(() => ({
  REPO_PATH: '/repos/pitwall',
  WORKTREE_PATH: '/repos/pitwall/.worktrees/loop',
  CC_SESSION_ID: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
}))

const seam = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: never[]) => unknown>(),
  spawns: [] as Array<{ sessionId: string; innerCmd: string; cwd: string }>,
  // Args do INSERT INTO sessions, na ordem do statement.
  inserted: [] as unknown[][],
  // path → conteúdo escrito (system-prompt temporário).
  writtenFiles: new Map<string, string>(),
  // Diretórios que "existem" no disco pro statSync falso.
  existingDirs: new Set<string>(),
  // feature_id devolvido pelo lookup do resume (null = sessão sem feature).
  resumeFeatureId: null as string | null,
  // worktree_path registrado em feature_repos (null = nenhum).
  worktreePath: null as string | null,
  featureSessionRows: [] as Record<string, unknown>[],
  repoSessionRows: [] as Record<string, unknown>[],
  lastFeatureSessionsSql: '',
  runningIds: [] as string[],
  feature: null as Record<string, unknown> | null,
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cm-test-userdata' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: never[]) => unknown) => {
      seam.handlers.set(channel, fn)
    },
  },
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    mkdirSync: () => undefined,
    readdirSync: () => [],
    unlinkSync: () => undefined,
    writeFileSync: (path: string, content: string) => {
      seam.writtenFiles.set(path, String(content))
    },
    statSync: (path: string) => {
      if (!seam.existingDirs.has(path)) throw new Error(`ENOENT: ${path}`)
      return { isDirectory: () => true, mtimeMs: 0 }
    },
  }
})

vi.mock('../services/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO sessions')) seam.inserted.push(args)
        return { changes: 1 }
      },
      get: (..._args: unknown[]) => {
        if (sql.includes('SELECT feature_id FROM sessions')) {
          return seam.resumeFeatureId ? { feature_id: seam.resumeFeatureId } : undefined
        }
        if (sql.includes('FROM feature_repos')) {
          return seam.worktreePath ? { worktree_path: seam.worktreePath } : undefined
        }
        if (sql.includes('SELECT path, label FROM repos')) {
          return { path: REPO_PATH, label: 'Pitwall' }
        }
        return undefined
      },
      all: (..._args: unknown[]) => {
        if (sql.includes('FROM sessions WHERE feature_id = ?')) {
          seam.lastFeatureSessionsSql = sql
          return seam.featureSessionRows
        }
        if (sql.includes('WHERE repo_id = ?')) return seam.repoSessionRows
        return []
      },
    }),
  }),
}))

vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    on: () => {},
    off: () => {},
    write: () => {},
    isRunning: (id: string) => seam.runningIds.includes(id),
    runningIds: () => seam.runningIds,
    spawn: (opts: { sessionId: string; args: string[]; cwd: string }) => {
      seam.spawns.push({ sessionId: opts.sessionId, innerCmd: opts.args.join(' '), cwd: opts.cwd })
    },
  },
}))
vi.mock('../services/custom-env', () => ({ sessionSpawnEnv: () => ({}) }))
vi.mock('../services/feature-store', () => ({
  get: () => seam.feature,
  linkedObjectiveTitles: () => [],
}))
vi.mock('../services/loop-snapshot', () => ({
  loopSnapshot: () => ({
    liveness: 'quente',
    pulse: { body: 'fechando o vínculo do resume' },
    ledger: [{ title: 'IPC list-by-feature', createdAt: 1_700_000_000_000 }],
  }),
}))
vi.mock('../services/repo-dependency-store', () => ({ listByRepo: () => [] }))
vi.mock('../services/feature-memory', () => ({ featureMemory: { onSessionExit: () => {} } }))
vi.mock('../services/loop-export', () => ({ exportLoopDoc: () => Promise.resolve() }))
vi.mock('../services/handoff-store', () => ({
  get: () => null,
  markRunning: () => null,
  getByChildSession: () => null,
  failIfRunning: () => null,
}))
vi.mock('../services/mcp/server', () => ({ getMcpRuntime: () => null }))
vi.mock('../services/mcp/config', () => ({
  mcpClientConfigPath: () => '/tmp/mcp.json',
  writeSessionMcpClientConfig: () => '/tmp/mcp-session.json',
  removeSessionMcpConfig: () => {},
}))
vi.mock('../services/session-activity', () => ({
  sessionActivityService: {},
  findTranscriptPath: () => '/tmp/transcript.jsonl',
  buildSessionsFileIndex: () => new Map(),
  readTranscriptTitle: () => null,
  readTail: () => null,
  deriveEnrichment: () => ({}),
  isPidAlive: () => false,
  mapStatus: () => 'idle',
}))

import { registerSessionIpc, spawnSession } from './sessions'
import type { FeatureSessionSummary, SessionSummary } from '../../../shared/types/ipc'

const FEATURE = {
  id: 'feat-1',
  projectId: 'proj-1',
  slug: 'feature-loop-integration',
  title: 'Integração do loop',
  status: 'in_progress',
  objective: 'Fazer o loop chegar na sessão',
  docPath: '/docs/feature.md',
  synthMode: 'threshold',
  model: null,
  repos: [{ repoId: 'r1', branch: null, worktreePath: WORKTREE_PATH }],
  origin: 'app',
  objectiveLinkCount: 0,
  isAppDev: false,
  createdAt: 1,
  updatedAt: 2,
  completedAt: null,
  archivedAt: null,
}

function handler(channel: string): (event: unknown, ...args: never[]) => unknown {
  const fn = seam.handlers.get(channel)
  if (!fn) throw new Error(`handler não registrado: ${channel}`)
  return fn
}

function resume(): { id: string } {
  return handler('sessions:resume')(null, {
    repoId: 'r1',
    ccSessionId: CC_SESSION_ID,
  } as never) as { id: string }
}

// Conteúdo do arquivo apontado pelo --append-system-prompt-file do último spawn.
function injectedSystemPrompt(): string | null {
  const match = /--append-system-prompt-file '([^']+)'/.exec(seam.spawns.at(-1)!.innerCmd)
  return match ? (seam.writtenFiles.get(match[1]) ?? null) : null
}

beforeEach(() => {
  seam.handlers.clear()
  seam.spawns.length = 0
  seam.inserted.length = 0
  seam.writtenFiles.clear()
  seam.existingDirs = new Set([REPO_PATH])
  seam.resumeFeatureId = null
  seam.worktreePath = null
  seam.featureSessionRows = []
  seam.repoSessionRows = []
  seam.lastFeatureSessionsSql = ''
  seam.runningIds = []
  seam.feature = FEATURE
  registerSessionIpc()
})

// Índices do INSERT INTO sessions (id, repo_id, cc_session_id, title, pane_id,
// status, started_at, ended_at, feature_id).
const INSERTED_FEATURE_ID = 8

describe('sessions:resume preserva o vínculo com a feature', () => {
  it('herda o feature_id da sessão retomada (sem isso a nova linha nasce NULL)', () => {
    seam.resumeFeatureId = 'feat-1'
    resume()
    expect(seam.inserted).toHaveLength(1)
    expect(seam.inserted[0][INSERTED_FEATURE_ID]).toBe('feat-1')
  })

  it('anexa o MESMO bloco de contexto do spawn: pulso, vitalidade e ponteiro do loop', () => {
    seam.resumeFeatureId = 'feat-1'
    resume()
    const prompt = injectedSystemPrompt()
    expect(prompt).not.toBeNull()
    expect(prompt).toContain('vitalidade: quente')
    expect(prompt).toContain('Pulso vigente: fechando o vínculo do resume')
    expect(prompt).toContain(`${WORKTREE_PATH}/.pitwall/loop-feature-loop-integration.md`)
    expect(prompt).toContain('feature id is feat-1')
  })

  it('sessão sem feature continua sem system-prompt-file (nada inventado)', () => {
    resume()
    expect(seam.inserted[0][INSERTED_FEATURE_ID]).toBeNull()
    expect(seam.spawns[0].innerCmd).not.toContain('--append-system-prompt-file')
  })

  it('mantém o --resume <cc_session_id> do comando', () => {
    seam.resumeFeatureId = 'feat-1'
    resume()
    expect(seam.spawns[0].innerCmd).toContain(`--resume ${CC_SESSION_ID}`)
  })
})

describe('cwd respeita o worktree registrado da feature', () => {
  it('spawn com worktree existente no disco roda no worktree', () => {
    seam.worktreePath = WORKTREE_PATH
    seam.existingDirs.add(WORKTREE_PATH)
    spawnSession({ repoId: 'r1', featureId: 'feat-1' })
    expect(seam.spawns[0].cwd).toBe(WORKTREE_PATH)
  })

  it('worktree removido do disco cai pro path do repo (não falha)', () => {
    seam.worktreePath = WORKTREE_PATH // registrado, mas ausente de existingDirs
    spawnSession({ repoId: 'r1', featureId: 'feat-1' })
    expect(seam.spawns[0].cwd).toBe(REPO_PATH)
  })

  it('sessão sem feature roda no path do repo', () => {
    spawnSession({ repoId: 'r1' })
    expect(seam.spawns[0].cwd).toBe(REPO_PATH)
  })

  it('resume da sessão com feature também herda o worktree', () => {
    seam.resumeFeatureId = 'feat-1'
    seam.worktreePath = WORKTREE_PATH
    seam.existingDirs.add(WORKTREE_PATH)
    resume()
    expect(seam.spawns[0].cwd).toBe(WORKTREE_PATH)
  })
})

describe('sessions:list-by-feature', () => {
  it('projeta as sessões da feature e marca as que têm PTY viva', () => {
    seam.featureSessionRows = [
      {
        id: 's2',
        repo_id: 'r1',
        cc_session_id: CC_SESSION_ID,
        title: 'Fechar o loop',
        title_source: 'manual',
        status: 'running',
        started_at: 200,
        ended_at: null,
      },
      {
        id: 's1',
        repo_id: 'r1',
        cc_session_id: null,
        title: null,
        title_source: null,
        status: 'exited',
        started_at: 100,
        ended_at: 150,
      },
    ]
    seam.runningIds = ['s2']

    const out = handler('sessions:list-by-feature')(null, 'feat-1' as never) as FeatureSessionSummary[]

    expect(out).toEqual([
      {
        id: 's2',
        ccSessionId: CC_SESSION_ID,
        repoId: 'r1',
        title: 'Fechar o loop',
        titleSource: 'manual',
        status: 'running',
        startedAt: 200,
        endedAt: null,
        isLive: true,
      },
      {
        id: 's1',
        ccSessionId: null,
        repoId: 'r1',
        title: null,
        titleSource: null,
        status: 'exited',
        startedAt: 100,
        endedAt: 150,
        isLive: false,
      },
    ])
  })

  it('pede ao banco a ordem decrescente por início', () => {
    handler('sessions:list-by-feature')(null, 'feat-1' as never)
    expect(seam.lastFeatureSessionsSql).toContain('ORDER BY started_at DESC')
  })

  it('feature sem sessão devolve lista vazia', () => {
    expect(handler('sessions:list-by-feature')(null, 'feat-vazia' as never)).toEqual([])
  })
})

describe('sessions:list-by-repo', () => {
  it('devolve o id interno e o feature_id de cada sessão', () => {
    seam.repoSessionRows = [
      { id: 's2', cc_session_id: CC_SESSION_ID, title: 'Fechar o loop', feature_id: 'feat-1' },
    ]

    const out = handler('sessions:list-by-repo')(null, 'r1' as never) as SessionSummary[]

    expect(out).toEqual([
      {
        id: 's2',
        ccSessionId: CC_SESSION_ID,
        featureId: 'feat-1',
        name: 'Fechar o loop',
        title: 'Fechar o loop',
        status: 'ended',
        lastActivityAt: null,
        isLive: false,
      },
    ])
  })

  it('colapsa as linhas da mesma cc_session_id herdando vínculo e título das antigas', () => {
    // Cada resume abre outra linha; a mais nova nasce sem título nem feature.
    seam.repoSessionRows = [
      { id: 's3', cc_session_id: CC_SESSION_ID, title: null, feature_id: null },
      { id: 's2', cc_session_id: CC_SESSION_ID, title: 'Fechar o loop', feature_id: 'feat-1' },
    ]

    const out = handler('sessions:list-by-repo')(null, 'r1' as never) as SessionSummary[]

    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('s3')
    expect(out[0].featureId).toBe('feat-1')
    expect(out[0].title).toBe('Fechar o loop')
  })
})
