import { afterEach, describe, expect, it, vi } from 'vitest'

const sent: Array<[string, unknown]> = []
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (c: string, p: unknown) => sent.push([c, p]) } }],
  },
}))
vi.mock('./task-store', () => ({ affectedObjectiveIds: () => [] }))

import { broadcast, onBroadcast } from './notify'

describe('onBroadcast', () => {
  const offs: Array<() => void> = []
  afterEach(() => {
    for (const off of offs.splice(0)) off()
    sent.length = 0
  })

  it('entrega ao ouvinte do main os canais que casam o prefixo, além da janela', () => {
    const seen: string[] = []
    offs.push(onBroadcast('handoff:', (channel) => seen.push(channel)))

    broadcast('handoff:updated', { id: 'h1' })
    broadcast('task:updated', { id: 't1' })

    expect(seen).toEqual(['handoff:updated'])
    expect(sent.map(([c]) => c)).toEqual(['handoff:updated', 'task:updated'])
  })

  it('o unsubscribe para a entrega', () => {
    const fn = vi.fn()
    const off = onBroadcast('repo-deps:', fn)
    off()
    broadcast('repo-deps:updated', {})
    expect(fn).not.toHaveBeenCalled()
  })

  it('um ouvinte que lança não derruba o broadcast nem os outros ouvintes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = vi.fn()
    offs.push(
      onBroadcast('session:', () => {
        throw new Error('boom')
      }),
    )
    offs.push(onBroadcast('session:', ok))

    expect(() => broadcast('session:activity:global', [])).not.toThrow()
    expect(ok).toHaveBeenCalledWith('session:activity:global', [])
    expect(sent).toHaveLength(1)
    spy.mockRestore()
  })
})
