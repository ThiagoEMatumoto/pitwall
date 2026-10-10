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
  // PTYs mortas (o resto está viva) e o cc de cada sessions.id.
  dead: new Set<string>(),
  ccOf: new Map<string, string>(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  webContents: { fromId: () => null },
}))
vi.mock('../services/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (id: string) =>
        sql.includes('SELECT cc_session_id FROM sessions WHERE id = ?') && seam.ccOf.has(id)
          ? { cc_session_id: seam.ccOf.get(id) }
          : undefined,
    }),
  }),
}))
vi.mock('../services/pty-manager', () => ({
  ptyManager: { isRunning: (id: string) => !seam.dead.has(id), on: () => {} },
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

import { promptQueue, sendWakingDormant } from './send-prompt'
import { DormantPanes, setDormantPanes } from '../services/dormant-panes'

const CODEX = 'codex-pty'

beforeEach(() => {
  seam.writes.length = 0
  seam.mirrored.clear()
  seam.tracked = new Set([CODEX])
  seam.ptyStatus = 'idle'
  seam.dead.clear()
  seam.ccOf.clear()
  setDormantPanes(null)
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

describe('sessions:send-prompt — destino dormindo (lazy restore)', () => {
  function dormant(wakeTo: string | null, lazyRestore = true) {
    const requests: string[] = []
    const panes: DormantPanes = new DormantPanes({
      requestWake: (req) => {
        requests.push(req.ccSessionId)
        queueMicrotask(() =>
          panes.onWakeResult({
            requestId: req.requestId,
            sessionId: wakeTo,
            error: wakeTo ? undefined : 'resume-threw',
          }),
        )
        return true
      },
      isRunning: (id) => !seam.dead.has(id),
      screen: async () => ({ menu: null, inputPrompt: true, inputDirty: false }) as never,
      warn: () => {},
      readyPollMs: 1,
    })
    panes.setDormant([{ ccSessionId: 'cc-old', paneId: 'p1', title: 'api', repoId: null }])
    setDormantPanes(panes, () => lazyRestore)
    return requests
  }

  it('sessions.id sem PTY cuja conversa dorme: acorda e manda para o id novo', async () => {
    seam.dead.add('old-pty')
    seam.ccOf.set('old-pty', 'cc-old')
    seam.mirrored.add('new-pty')
    seam.tracked = new Set(['new-pty'])
    const requests = dormant('new-pty')

    const res = await sendWakingDormant({ sessionId: 'old-pty', text: 'segue', when: 'now' })

    expect(res).toEqual({ ok: true, delivered: true })
    expect(requests).toEqual(['cc-old'])
    expect(seam.writes.map((w) => w.id)).toEqual(['new-pty'])
  })

  it('recém-acordada ainda no turno do --resume: enfileira on-idle em vez de escrever', async () => {
    seam.dead.add('old-pty')
    seam.ccOf.set('old-pty', 'cc-old')
    seam.mirrored.add('new-pty')
    seam.tracked = new Set(['new-pty'])
    seam.ptyStatus = 'working'
    dormant('new-pty')

    const res = await sendWakingDormant({ sessionId: 'old-pty', text: 'segue', when: 'now' })

    expect(res).toMatchObject({ ok: true, delivered: false, queued: { sessionId: 'new-pty' } })
    expect(seam.writes).toEqual([])
    const queued = res.ok && !res.delivered ? res.queued.id : ''
    void promptQueue.cancel(queued)
  })

  it('wake falhou: devolve o not-running original sem escrever', async () => {
    seam.dead.add('old-pty')
    seam.ccOf.set('old-pty', 'cc-old')
    dormant(null)

    const res = await sendWakingDormant({ sessionId: 'old-pty', text: 'segue', when: 'now' })

    expect(res).toEqual({ ok: false, error: 'not-running' })
    expect(seam.writes).toEqual([])
  })

  it('sem pane dormindo para a conversa: not-running sem pedir wake', async () => {
    seam.dead.add('old-pty')
    seam.ccOf.set('old-pty', 'cc-outra')
    const requests = dormant('new-pty')

    const res = await sendWakingDormant({ sessionId: 'old-pty', text: 'segue', when: 'now' })

    expect(res).toEqual({ ok: false, error: 'not-running' })
    expect(requests).toEqual([])
  })

  it('pref sessions.lazyRestore desligada: not-running de antes, sem pedir wake', async () => {
    seam.dead.add('old-pty')
    seam.ccOf.set('old-pty', 'cc-old')
    const requests = dormant('new-pty', false)

    const res = await sendWakingDormant({ sessionId: 'old-pty', text: 'segue', when: 'now' })

    expect(res).toEqual({ ok: false, error: 'not-running' })
    expect(requests).toEqual([])
    expect(seam.writes).toEqual([])
  })
})
