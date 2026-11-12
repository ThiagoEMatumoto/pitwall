/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { createBacklogRequests } from './backlog-request'

type Reply = { requestId: number; backlog?: string; error?: string }

function fakeIpc() {
  const listeners: Array<{ channel: string; fn: (event: unknown, reply: Reply) => void }> = []
  const requests: Array<{ channel: string; requestId: number; sessionId: string }> = []
  return {
    listeners,
    requests,
    on: (channel: string, fn: (event: unknown, reply: Reply) => void) => {
      listeners.push({ channel, fn })
    },
    send: (channel: string, requestId: number, sessionId: string) => {
      requests.push({ channel, requestId, sessionId })
    },
    reply: (reply: Reply) => {
      for (const l of listeners) l.fn({}, reply)
    },
  }
}

describe('pedido de backlog por evento', () => {
  it('manda o pedido com um id e resolve com a resposta desse id', async () => {
    const ipc = fakeIpc()
    const backlogs = createBacklogRequests(ipc)

    const pending = backlogs.get('s1')
    expect(ipc.requests).toEqual([
      { channel: 'sessions:get-backlog', requestId: ipc.requests[0].requestId, sessionId: 's1' },
    ])

    ipc.reply({ requestId: ipc.requests[0].requestId, backlog: 'abc' })
    await expect(pending).resolves.toBe('abc')
  })

  it('registra um listener só, por mais pedidos que saiam', () => {
    const ipc = fakeIpc()
    const backlogs = createBacklogRequests(ipc)

    void backlogs.get('s1')
    void backlogs.get('s2')
    void backlogs.get('s1')

    expect(ipc.listeners.map((l) => l.channel)).toEqual(['sessions:backlog'])
  })

  it('pedidos concorrentes não se cruzam, mesmo com as respostas fora de ordem', async () => {
    const ipc = fakeIpc()
    const backlogs = createBacklogRequests(ipc)

    const first = backlogs.get('s1')
    const second = backlogs.get('s2')
    const [a, b] = ipc.requests
    expect(a.requestId).not.toBe(b.requestId)

    ipc.reply({ requestId: b.requestId, backlog: 'de s2' })
    ipc.reply({ requestId: a.requestId, backlog: 'de s1' })

    await expect(first).resolves.toBe('de s1')
    await expect(second).resolves.toBe('de s2')
  })

  it('resposta de erro rejeita só o pedido dela', async () => {
    const ipc = fakeIpc()
    const backlogs = createBacklogRequests(ipc)

    const failed = backlogs.get('s1')
    const fine = backlogs.get('s2')
    const [a, b] = ipc.requests

    ipc.reply({ requestId: a.requestId, error: 'pty sumiu' })
    ipc.reply({ requestId: b.requestId, backlog: 'ok' })

    await expect(failed).rejects.toThrow('pty sumiu')
    await expect(fine).resolves.toBe('ok')
  })

  it('não deixa pedido pendurado depois da resposta e ignora resposta sem pedido', async () => {
    const ipc = fakeIpc()
    const backlogs = createBacklogRequests(ipc)

    const ok = backlogs.get('s1')
    const failed = backlogs.get('s2')
    expect(backlogs.pendingCount()).toBe(2)
    const [a, b] = ipc.requests

    ipc.reply({ requestId: a.requestId, backlog: '' })
    ipc.reply({ requestId: b.requestId, error: 'x' })
    await expect(ok).resolves.toBe('')
    await expect(failed).rejects.toThrow('x')
    expect(backlogs.pendingCount()).toBe(0)

    // Repetida ou de um pedido que este renderer não fez.
    expect(() => ipc.reply({ requestId: a.requestId, backlog: 'de novo' })).not.toThrow()
    expect(() => ipc.reply({ requestId: 9999, backlog: 'alheia' })).not.toThrow()
    expect(backlogs.pendingCount()).toBe(0)
  })
})
