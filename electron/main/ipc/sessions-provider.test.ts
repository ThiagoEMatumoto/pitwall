/** @vitest-environment node */
// Spawn e lista viva por provider: o Codex nasce sem cc_session_id, com o
// bearer do MCP no env (nunca no argv), status pela PTY, e aparece no
// list-live-global chaveado pelo sessions.id.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: never[]) => unknown>(),
  spawns: [] as Array<{ sessionId: string; innerCmd: string; env: Record<string, string> }>,
  inserts: [] as unknown[][],
  updates: [] as Array<{ sql: string; args: unknown[] }>,
  tracked: [] as string[],
  runningIds: [] as string[],
  liveRows: new Map<string, Record<string, unknown>>(),
  prefs: new Map<string, string>(),
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
vi.mock('../services/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO sessions')) seam.inserts.push(args)
        else seam.updates.push({ sql, args })
        return { changes: 1 }
      },
      get: (...args: unknown[]) => {
        if (sql.includes('FROM app_prefs')) {
          const value = seam.prefs.get(args[0] as string)
          return value === undefined ? undefined : { value }
        }
        if (sql.includes('FROM repos')) return { path: '/tmp', label: 'Repo X' }
        if (sql.includes('LEFT JOIN repos')) return seam.liveRows.get(args[0] as string)
        return undefined
      },
      all: () => [],
    }),
  }),
}))
vi.mock('../services/pty-manager', () => ({
  ptyManager: {
    on: () => {},
    off: () => {},
    write: () => {},
    isRunning: () => true,
    runningIds: () => seam.runningIds,
    getActivitySample: () => ({ lastByteAt: 1234, tailHash: 'h', hashChangedAt: 1000 }),
    spawn: (opts: { sessionId: string; args: string[]; env: Record<string, string> }) => {
      seam.spawns.push({ sessionId: opts.sessionId, innerCmd: opts.args.join(' '), env: opts.env })
    },
  },
}))
vi.mock('../services/custom-env', () => ({ sessionSpawnEnv: () => ({ BASE: '1' }) }))
vi.mock('../services/feature-store', () => ({ get: () => null, linkedObjectiveTitles: () => [] }))
vi.mock('../services/feature-memory', () => ({ featureMemory: { onSessionExit: () => {} } }))
vi.mock('../services/handoff-store', () => ({
  get: () => null,
  getByChildSession: () => null,
  failIfRunning: () => null,
}))
vi.mock('../services/mcp/server', () => ({
  getMcpRuntime: () => ({ url: 'http://127.0.0.1:47821/mcp', token: 'secret-token' }),
}))
vi.mock('../services/mcp/config', () => ({
  mcpClientConfigPath: () => '/tmp/mcp.json',
  writeSessionMcpClientConfig: (_info: unknown, id: string) => `/tmp/mcp-sessions/${id}.json`,
  removeSessionMcpConfig: () => {},
}))
vi.mock('../services/session-activity', () => ({
  sessionActivityService: { trackPty: (id: string) => seam.tracked.push(id) },
  ptyStatusFor: () => 'working',
  findTranscriptPath: () => null,
  buildSessionsFileIndex: () => new Map(),
  readTranscriptTitle: () => null,
  readTail: () => null,
  deriveEnrichment: () => ({}),
  isPidAlive: () => false,
  mapStatus: () => 'idle',
  attentionReasonForPty: () => undefined,
}))

import { registerSessionIpc, spawnSession } from './sessions'
import { CODEX_MCP_TOKEN_ENV } from '../services/providers/codex'

function liveRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    cc_session_id: null,
    provider: 'codex',
    session_title: 'Repo X',
    session_title_source: null,
    repo_id: null,
    ...over,
  }
}

beforeEach(() => {
  seam.spawns.length = 0
  seam.inserts.length = 0
  seam.updates.length = 0
  seam.tracked.length = 0
  seam.runningIds = []
  seam.liveRows.clear()
  seam.prefs.clear()
})

describe('spawnSession com provider codex', () => {
  it('usa codex_command, flags do Codex e nenhum resquício do claude', () => {
    seam.prefs.set('codex_command', '/fake/codex')
    spawnSession({ repoId: 'r1', provider: 'codex', permissionMode: 'plan' })
    const { innerCmd } = seam.spawns[0]
    expect(innerCmd).toContain("exec /fake/codex --no-alt-screen -s 'read-only' -a 'on-request'")
    expect(innerCmd).toMatch(
      /mcp_servers\.pitwall\.url="http:\/\/127\.0\.0\.1:47821\/mcp\?s=[0-9a-f-]{36}"/,
    )
    expect(innerCmd).not.toContain('--session-id')
    expect(innerCmd).not.toContain('--mcp-config')
  })

  it('o bearer vai no env da PTY e não aparece no argv', () => {
    spawnSession({ repoId: 'r1', provider: 'codex' })
    const { innerCmd, env } = seam.spawns[0]
    expect(env).toMatchObject({ BASE: '1', [CODEX_MCP_TOKEN_ENV]: 'secret-token' })
    expect(innerCmd).not.toContain('secret-token')
  })

  it("grava provider='codex' sem cc_session_id e liga o status por PTY", () => {
    const session = spawnSession({ repoId: 'r1', provider: 'codex', name: 'meu codex' })
    const insert = seam.inserts[0]
    expect(insert[2]).toBeNull() // cc_session_id
    expect(insert[9]).toBe('codex') // provider
    expect(seam.tracked).toEqual([session.id])
    expect(session).toMatchObject({ ccSessionId: null, provider: 'codex', title: 'meu codex' })
  })

  it('filha autônoma com edição no Codex é recusada antes de qualquer efeito', () => {
    expect(() =>
      spawnSession({
        repoId: 'r1',
        provider: 'codex',
        permissionMode: 'acceptEdits',
        handoffChild: true,
      }),
    ).toThrow(/Codex/)
    expect(seam.inserts).toHaveLength(0)
    expect(seam.spawns).toHaveLength(0)
  })

  it('claude continua com --session-id e sem tracking por PTY', () => {
    spawnSession({ repoId: 'r1', name: 'claude normal' })
    expect(seam.spawns[0].innerCmd).toContain('--session-id')
    expect(seam.inserts[0][9]).toBe('claude')
    expect(seam.tracked).toHaveLength(0)
  })
})

describe('sessions:list-live-global', () => {
  it('sessão sem id nativo aparece, chaveada pelo sessions.id, com status da PTY', async () => {
    registerSessionIpc()
    seam.runningIds = ['sess-codex']
    seam.liveRows.set('sess-codex', liveRow({}))
    const list = (await seam.handlers.get('sessions:list-live-global')!({})) as Array<
      Record<string, unknown>
    >
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'sess-codex',
      ccSessionId: 'sess-codex',
      provider: 'codex',
      status: 'working',
      name: 'Repo X',
      isResumable: false,
      lastActivityAt: 1234,
    })
  })

  it('sessão claude segue o caminho do índice nativo e vem marcada claude', async () => {
    registerSessionIpc()
    seam.runningIds = ['sess-claude']
    seam.liveRows.set('sess-claude', liveRow({ cc_session_id: 'cc-1', provider: 'claude' }))
    const list = (await seam.handlers.get('sessions:list-live-global')!({})) as Array<
      Record<string, unknown>
    >
    expect(list[0]).toMatchObject({ ccSessionId: 'cc-1', provider: 'claude', status: 'ended' })
  })
})
