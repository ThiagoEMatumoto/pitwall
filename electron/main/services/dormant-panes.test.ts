import { describe, expect, it, vi } from 'vitest'
import { DormantPanes, type DormantPanesDeps } from './dormant-panes'
import type { LiveStatus, ScreenScan } from '../../../shared/tui/attention-reason'
import type { DormantPaneInfo, WakeRequest } from '../../../shared/types/ipc'

const PANE: DormantPaneInfo = {
  ccSessionId: 'cc-1',
  paneId: 'pane-1',
  title: 'Api-Contrato',
  repoId: 'r-api',
}
const SCAN = { menu: null, inputPrompt: true, inputDirty: false } as unknown as ScreenScan

// O "renderer": responde o pedido de wake com o sessions.id da sessão retomada e
// a PTY sobe; a tela/status ficam prontos quando o teste mandar.
function harness(over: Partial<DormantPanesDeps> & { answer?: 'ok' | 'error' | 'silent' } = {}) {
  const running = new Set<string>()
  const status = new Map<string, LiveStatus>()
  const screens = new Map<string, ScreenScan | null>()
  const requests: WakeRequest[] = []
  const warns: Array<Record<string, unknown>> = []
  let n = 0
  const panes: DormantPanes = new DormantPanes({
    requestWake: (req) => {
      requests.push(req)
      const answer = over.answer ?? 'ok'
      if (answer === 'silent') return true
      queueMicrotask(() => {
        if (answer === 'error') {
          panes.onWakeResult({ requestId: req.requestId, sessionId: null, error: 'resume-threw' })
          return
        }
        const id = `s-${++n}`
        running.add(id)
        panes.onWakeResult({ requestId: req.requestId, sessionId: id })
      })
      return true
    },
    isRunning: (id) => running.has(id),
    screen: async (id) => screens.get(id) ?? null,
    status: (id) => status.get(id) ?? null,
    warn: (e) => warns.push(e),
    resultTimeoutMs: 50,
    readyTimeoutMs: 80,
    readyPollMs: 5,
    ...over,
  })
  panes.setDormant([PANE])
  const ready = (id: string) => {
    screens.set(id, SCAN)
    status.set(id, 'idle')
  }
  return { panes, requests, warns, running, ready, status, screens }
}

describe('DormantPanes registry', () => {
  it('acha por cc, por alias (case-insensitive, como o resolveAlias) e por repo', () => {
    const { panes } = harness()
    expect(panes.findDormantByCc('cc-1')).toEqual(PANE)
    expect(panes.findDormantByAlias('  api-contrato ')).toEqual([PANE])
    expect(panes.findDormantByAlias('outra')).toEqual([])
    expect(panes.findDormantByRepo('r-api')).toEqual([PANE])
    panes.setDormant([])
    expect(panes.findDormantByCc('cc-1')).toBeNull()
  })
})

describe('wakeDormant', () => {
  it('sucesso: pede o resume, espera a tela e devolve o sessions.id novo', async () => {
    const h = harness()
    const p = h.panes.wakeDormant('cc-1', 'agent-bus')
    // Sobe sem tela espelhada ainda: não está pronta.
    await vi.waitFor(() => expect(h.running.has('s-1')).toBe(true))
    setTimeout(() => h.screens.set('s-1', SCAN), 20)

    expect(await p).toEqual({ ok: true, sessionId: 's-1' })
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].ccSessionId).toBe('cc-1')
    // Acordou: sai do registro antes do próximo sync do renderer.
    expect(h.panes.findDormantByCc('cc-1')).toBeNull()
    expect(h.warns).toEqual([
      expect.objectContaining({ event: 'dormant_woke', ccSessionId: 'cc-1', sessionId: 's-1' }),
    ])
  })

  it('coalesce: dois wakes do mesmo cc ao mesmo tempo = um resume só', async () => {
    const h = harness()
    const a = h.panes.wakeDormant('cc-1', 'agent-bus')
    const b = h.panes.wakeDormant('cc-1', 'handoff-wake')
    await vi.waitFor(() => expect(h.running.has('s-1')).toBe(true))
    h.ready('s-1')

    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toEqual({ ok: true, sessionId: 's-1' })
    expect(rb).toEqual(ra)
    expect(h.requests).toHaveLength(1)
  })

  it('renderer não responde: falha por timeout do resultado', async () => {
    const h = harness({ answer: 'silent' })
    expect(await h.panes.wakeDormant('cc-1', 'send-prompt')).toEqual({
      ok: false,
      error: 'wake-result-timeout',
      sessionId: null,
    })
    expect(h.warns[0]).toMatchObject({ event: 'dormant_wake_failed', error: 'wake-result-timeout' })
    // Falhou: continua dormindo, um próximo wake tenta de novo.
    expect(h.panes.findDormantByCc('cc-1')).toEqual(PANE)
  })

  it('pronta = TUI reconhecida, mesmo com o turno do --resume ainda trabalhando', async () => {
    const h = harness()
    const p = h.panes.wakeDormant('cc-1', 'agent-bus')
    await vi.waitFor(() => expect(h.running.has('s-1')).toBe(true))
    h.screens.set('s-1', SCAN)
    h.status.set('s-1', 'working')

    // A fila on-idle de quem entrega é que espera o idle.
    expect(await p).toEqual({ ok: true, sessionId: 's-1' })
  })

  it('PTY viva sem tela no teto: sucesso degradado com o id e warn', async () => {
    const h = harness()
    const out = await h.panes.wakeDormant('cc-1', 'agent-bus')
    expect(out).toEqual({ ok: true, sessionId: 's-1' })
    expect(h.warns).toContainEqual({ event: 'dormant_ready_timeout', sessionId: 's-1' })
  })

  it('PTY morreu antes de ficar pronta: falha com o id', async () => {
    const h = harness()
    const p = h.panes.wakeDormant('cc-1', 'agent-bus')
    await vi.waitFor(() => expect(h.running.has('s-1')).toBe(true))
    h.running.delete('s-1')
    expect(await p).toEqual({ ok: false, error: 'exited-before-ready', sessionId: 's-1' })
  })

  it('requestWake lança: o inflight é limpo e o próximo wake do cc tenta de novo', async () => {
    let calls = 0
    const h = harness({
      requestWake: () => {
        calls++
        throw new Error('janela destruída')
      },
    })
    await expect(h.panes.wakeDormant('cc-1', 'agent-bus')).rejects.toThrow('janela destruída')
    await expect(h.panes.wakeDormant('cc-1', 'agent-bus')).rejects.toThrow('janela destruída')
    expect(calls).toBe(2)
  })

  it('depois de um wake falho, o cc falha na hora por 60s e depois tenta de novo', async () => {
    let clock = 1_000
    const h = harness({ answer: 'error', now: () => clock })

    expect(await h.panes.wakeDormant('cc-1', 'agent-bus')).toMatchObject({
      ok: false,
      error: 'resume-threw',
    })
    clock += 59_999
    expect(await h.panes.wakeDormant('cc-1', 'agent-bus')).toEqual({
      ok: false,
      error: 'wake-cooldown',
      sessionId: null,
    })
    expect(h.requests).toHaveLength(1)

    clock += 1
    expect(await h.panes.wakeDormant('cc-1', 'agent-bus')).toMatchObject({
      error: 'resume-threw',
    })
    expect(h.requests).toHaveLength(2)
  })

  it('resume falhou no renderer', async () => {
    const h = harness({ answer: 'error' })
    expect(await h.panes.wakeDormant('cc-1', 'agent-bus')).toEqual({
      ok: false,
      error: 'resume-threw',
      sessionId: null,
    })
  })

  it('sem janela: falha na hora, sem esperar o timeout', async () => {
    const h = harness({ requestWake: () => false, resultTimeoutMs: 60_000 })
    expect(await h.panes.wakeDormant('cc-1', 'agent-bus')).toEqual({
      ok: false,
      error: 'no-window',
      sessionId: null,
    })
  })

  it('cc que não está dormindo não pede resume', async () => {
    const h = harness()
    expect(await h.panes.wakeDormant('cc-x', 'agent-bus')).toMatchObject({
      ok: false,
      error: 'not-dormant',
    })
    expect(h.requests).toHaveLength(0)
  })
})
