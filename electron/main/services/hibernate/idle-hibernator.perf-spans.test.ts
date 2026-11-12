/** @vitest-environment node */
// O que a sonda (CM_PERF=1) registra da hibernação. spans['hibernate.tick'] é o
// número que a integração compara com 50 ms: só pode conter o gate. A espera do
// renderer (pane-check), a do /exit pela fila e a leitura de transcript em
// segundo plano têm span próprio.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const perfBefore = vi.hoisted(() => {
  // A sonda lê a flag uma vez, no import.
  const before = process.env.CM_PERF
  process.env.CM_PERF = '1'
  return before
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainPerfWindow } from '../perf-probe'
import { IdleHibernator, type IdleHibernatorDeps } from './idle-hibernator'
import { PANE_CHECK_TIMEOUT_MS, PaneConfirmer } from './pane-confirm'
import { ScheduleScanner } from './schedule-scan'

const PTY = 'pty-child'
const CC = '74f13261-5b8e-4f43-9d0e-2c5a2b1f7c11'
const NOW = 10_000_000_000
const IDLE_SINCE = NOW - 2 * 60 * 60_000
const RENDERER_MS = 900
const QUEUE_MS = 400

// Filha de handoff concluído, em segundo plano, que passa por todos os gates.
function doneChildDeps(over: Partial<IdleHibernatorDeps>): IdleHibernatorDeps {
  return {
    lazyRestore: () => false,
    afterMin: () => 0,
    childAfterMin: () => 15,
    candidates: () => [{ sessionId: PTY, ccSessionId: CC }],
    hasPane: () => false,
    confirmPane: async () => null,
    registerDormant: () => {},
    persistHibernating: () => {},
    lastIoAt: () => IDLE_SINCE,
    sessionFile: () => ({
      pid: process.pid,
      procStart: null,
      status: 'idle',
      statusUpdatedAt: IDLE_SINCE,
    }),
    isPidAlive: () => true,
    aliveSessionId: () => PTY,
    activeHandoffCcSessionIds: () => [],
    handoffChildKind: () => 'done',
    queueHas: () => false,
    transcriptPath: () => '/dev/null',
    scanTranscript: async () => 'clear',
    procTree: () => ({ ok: true }),
    send: async () => ({ ok: true, delivered: true }),
    cancel: () => {},
    replaceText: () => false,
    warn: () => {},
    now: () => NOW,
    ...over,
  }
}

beforeEach(() => {
  drainPerfWindow(1)
})
afterEach(() => vi.useRealTimers())
afterAll(() => {
  if (perfBefore === undefined) delete process.env.CM_PERF
  else process.env.CM_PERF = perfBefore
})

describe('spans da hibernação na sonda', () => {
  it('a espera do renderer e a do /exit pela fila ficam fora de hibernate.tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    // A resposta é a de answerPaneCheck (appStore.ts) para a filha sem aba, mas
    // com o renderer ocupado: ela demora.
    const confirmer: PaneConfirmer = new PaneConfirmer({
      request: ({ requestId }) => {
        setTimeout(
          () =>
            confirmer.onResult({
              requestId,
              paneId: null,
              focused: false,
              composerHasText: false,
              composerFocused: false,
            }),
          RENDERER_MS,
        )
        return true
      },
    })
    const hibernator = new IdleHibernator(
      doneChildDeps({
        confirmPane: (sessionId, cc) => confirmer.confirm(sessionId, cc),
        // A fila on-idle relê a tela antes de escrever o /exit.
        send: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ ok: true, delivered: true }), QUEUE_MS),
          ),
      }),
    )

    const tick = hibernator.tick()
    await vi.advanceTimersByTimeAsync(RENDERER_MS + QUEUE_MS)
    await tick
    expect(hibernator.isHibernating(PTY)).toBe(true)
    hibernator.dispose()

    const { spans } = drainPerfWindow(1)
    expect(spans['hibernate.tick']?.n).toBe(1)
    expect(spans['hibernate.tick']?.maxMs).toBeLessThan(50)
    expect(spans['hibernate.confirm']).toEqual({ n: 1, totalMs: RENDERER_MS, maxMs: RENDERER_MS })
    expect(spans['hibernate.exit']).toEqual({ n: 1, totalMs: QUEUE_MS, maxMs: QUEUE_MS })
  })

  it('janela que não responde: o teto do pane-check também fica fora de hibernate.tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const confirmer = new PaneConfirmer({ request: () => true })
    const hibernator = new IdleHibernator(
      doneChildDeps({ confirmPane: (sessionId, cc) => confirmer.confirm(sessionId, cc) }),
    )

    const tick = hibernator.tick()
    await vi.advanceTimersByTimeAsync(PANE_CHECK_TIMEOUT_MS)
    await tick
    expect(hibernator.getStats().refused['no-pane']).toBe(1)

    const { spans } = drainPerfWindow(1)
    expect(spans['hibernate.tick']?.maxMs).toBeLessThan(50)
    expect(spans['hibernate.confirm']?.maxMs).toBe(PANE_CHECK_TIMEOUT_MS)
    expect(spans['hibernate.exit']).toBeUndefined()
  })

  describe('leitura de transcript em segundo plano', () => {
    let dir = ''
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'hibernate-perf-spans-'))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('sai em hibernate.scan, uma vez por leitura e nenhuma pelo cache', async () => {
      const path = join(dir, 't.jsonl')
      // Linha no formato que o claude grava (o mesmo de schedule-scan.test.ts).
      writeFileSync(
        path,
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'oi' } })}\n`,
      )
      const scanner = new ScheduleScanner()
      expect(await scanner.peek(path)).toBe('reading')
      await vi.waitFor(async () => expect(await scanner.peek(path)).toBe('clear'))
      expect(await scanner.peek(path)).toBe('clear')

      expect(drainPerfWindow(1).spans['hibernate.scan']?.n).toBe(1)
    })
  })
})
