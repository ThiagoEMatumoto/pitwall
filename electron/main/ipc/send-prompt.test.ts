/** @vitest-environment node */
// Wiring da fila com o mundo real: uma PTY sem espelho headless (Codex, tracked só
// pelo status da PTY) não tem tela que prove caixa de input livre. O Codex abre
// overlay de aprovação (-a on-request) e a tela fica parada = 'idle'; um \r ali
// aprovaria o comando. 'quando terminar' tem de recusar, nunca escrever.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  writes: [] as Array<{ id: string; text: string }>,
  mirrored: new Set<string>(),
  tracked: new Set<string>(),
  ptyStatus: 'idle' as string,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  webContents: { fromId: () => null },
}))
vi.mock('../services/db', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined }) }),
}))
vi.mock('../services/pty-manager', () => ({
  ptyManager: { isRunning: () => true, on: () => {} },
}))
vi.mock('../services/handoff/inject', () => ({
  injectIntoSession: (id: string, text: string) => seam.writes.push({ id, text }),
}))
vi.mock('../services/handoff-store', () => ({ getByChildSession: () => null }))
vi.mock('../services/notify', () => ({ broadcast: () => {} }))
vi.mock('../services/notifications', () => ({ notify: () => {} }))
vi.mock('../services/tui-menu-watch', () => ({
  tuiMenuWatch: {
    has: (id: string) => seam.mirrored.has(id),
    rescan: async () => ({ menu: null, inputPrompt: true, inputDirty: false, nonBlankLines: 3 }),
    ptyForCc: () => null,
  },
}))
vi.mock('../services/session-activity', () => ({
  buildSessionsFileIndex: () => new Map(),
  isPidAlive: () => true,
  mapStatus: () => 'idle',
  ptyStatusFor: () => seam.ptyStatus,
  sessionActivityService: { isPtyTracked: (id: string) => seam.tracked.has(id) },
  setPromptQueueTurnHook: () => {},
}))

import { promptQueue } from './send-prompt'

const CODEX = 'codex-pty'

beforeEach(() => {
  seam.writes.length = 0
  seam.mirrored.clear()
  seam.tracked = new Set([CODEX])
  seam.ptyStatus = 'idle'
})

describe('promptQueue wiring — PTY sem espelho (Codex)', () => {
  it('quando terminar com a tela parada (overlay de aprovação) recusa sem escrever', async () => {
    const res = await promptQueue.send({ sessionId: CODEX, text: 'segue', when: 'on-idle' })
    expect(res).toEqual({ ok: false, error: 'no-screen' })
    expect(seam.writes).toHaveLength(0)
    expect(promptQueue.snapshot().items).toHaveLength(0)
  })

  it('quando terminar com o Codex trabalhando também não enfileira', async () => {
    seam.ptyStatus = 'working'
    const res = await promptQueue.send({ sessionId: CODEX, text: 'segue', when: 'on-idle' })
    expect(res).toEqual({ ok: false, error: 'no-screen' })
    expect(promptQueue.snapshot().items).toHaveLength(0)
  })

  it('"enviar agora" também recusa: o \\r cairia no overlay de aprovação parado', async () => {
    const res = await promptQueue.send({ sessionId: CODEX, text: 'continue', when: 'now' })
    expect(res).toEqual({ ok: false, error: 'no-screen' })
    expect(seam.writes).toHaveLength(0)
  })

  it('"enviar agora" para claude sem espelho (status nativo) segue escrevendo', async () => {
    seam.tracked.clear()
    const res = await promptQueue.send({ sessionId: 'claude-pty', text: 'agora', when: 'now' })
    expect(res).toEqual({ ok: true, delivered: true })
    expect(seam.writes).toEqual([{ id: 'claude-pty', text: 'agora' }])
  })
})
