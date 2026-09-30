/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
// HOME inexistente: o índice nasce vazio em vez de ler o ~/.claude/sessions real.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => '/nonexistent-cm-session-activity-test' }
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

import { onBroadcast } from './notify'
import { sessionActivityService } from './session-activity'
import { tuiMenuWatch } from './tui-menu-watch'

// O batch global é o que o grafo de sessões escuta pelo onBroadcast do notify —
// um broadcast local (webContents.send direto) chegaria só no renderer.
describe('sessionActivityService — batch global', () => {
  let heard: unknown[] = []
  let off: () => void = () => {}
  beforeEach(() => {
    vi.useFakeTimers()
    heard = []
    off = onBroadcast('session:activity:global', (_c, payload) => heard.push(payload))
  })
  afterEach(() => {
    off()
    sessionActivityService.closeAll()
    vi.useRealTimers()
  })

  it('passa pelos ouvintes do main', async () => {
    sessionActivityService.watchGlobal()
    await vi.waitFor(() => expect(heard).toHaveLength(1))
  })

  it("rajada de 'change' do TuiMenuWatch vira um batch só", async () => {
    sessionActivityService.watchGlobal()
    await vi.waitFor(() => expect(heard).toHaveLength(1))
    for (let i = 0; i < 5; i++) tuiMenuWatch.emit('change', `pty-${i}`)
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => expect(heard).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(600)
    expect(heard).toHaveLength(2)
  })
})
