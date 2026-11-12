/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'

const sent: Array<{ channel: string; payload: unknown }> = []
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      },
    ],
  },
}))
// HOME inexistente: o índice nasce vazio em vez de ler o ~/.claude/sessions real.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => '/nonexistent-cm-perf-probe-wiring-test' }
})
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: () => {}, close: async () => {} }) } }))
vi.mock('./db', () => ({
  getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) }),
}))
vi.mock('./notifications', () => ({
  getNotifPrefs: () => ({}),
  getMainWindow: () => null,
  getRendererFocusedSession: () => null,
  notify: () => {},
}))
vi.mock('./usage-monitor', () => ({ notifyUsageConsumption: () => {} }))
vi.mock('./handoff-store', () => ({
  getByChildSession: () => null,
  isActiveCrewChild: () => false,
}))
vi.mock('./task-store', () => ({ affectedObjectiveIds: () => [] }))

// A flag é lida na carga do perf-probe: notify e session-activity têm de ser
// carregados depois dela, na mesma leva de módulos.
async function load(flag: string) {
  vi.resetModules()
  vi.stubEnv('CM_PERF', flag)
  const probe = await import('./perf-probe')
  const { broadcast } = await import('./notify')
  const { sessionActivityService } = await import('./session-activity')
  return { probe, broadcast, sessionActivityService }
}

describe('perf-probe ligada aos produtores reais', () => {
  afterEach(() => {
    sent.length = 0
    vi.unstubAllEnvs()
  })

  it('o broadcast() real conta out:<canal> e continua entregando', async () => {
    const { probe, broadcast } = await load('1')
    broadcast('pty:data', { sessionId: 's1', data: 'abc' })
    broadcast('pty:data', { sessionId: 's1', data: 'de' })
    broadcast('session-graph:updated', { nodes: [] })
    expect(probe.drainPerfWindow(10_000).ipcOut).toEqual({
      'pty:data': 2,
      'session-graph:updated': 1,
    })
    expect(sent.map((s) => s.channel)).toEqual(['pty:data', 'pty:data', 'session-graph:updated'])
  })

  it('com a flag desligada o broadcast() real não deixa rastro', async () => {
    const { probe, broadcast } = await load('')
    broadcast('pty:data', { sessionId: 's1', data: 'abc' })
    expect(probe.drainPerfWindow(10_000).ipcOut).toEqual({})
    expect(sent).toHaveLength(1)
  })

  it('o batch global real é cronometrado e conta as sessões processadas', async () => {
    const { probe, sessionActivityService } = await load('1')
    try {
      sessionActivityService.watchGlobal()
      await vi.waitFor(() =>
        expect(sent.some((s) => s.channel === 'session:activity:global')).toBe(true),
      )
      const window = probe.drainPerfWindow(10_000)
      expect(window.spans.broadcastGlobal.n).toBe(1)
      expect(window.counters['broadcastGlobal.sessions']).toBe(0)
      expect(window.ipcOut['session:activity:global']).toBe(1)
    } finally {
      sessionActivityService.closeAll()
    }
  })
})
