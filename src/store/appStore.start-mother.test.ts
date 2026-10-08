import { describe, expect, it, vi } from 'vitest'

// appStore lê window.api no module-eval: o mock precisa existir antes do import.
// O main de verdade só faz broadcast('room:changed') no start-mother; nenhum
// evento de sessão nova chega pelo stream. A lista viva só muda no snapshot.
const mainLive: Array<{ id: string; ccSessionId: string }> = [{ id: 'a', ccSessionId: 'cc-a' }]
const startMother = vi.fn(async () => {
  mainLive.push({ id: 'mae', ccSessionId: 'cc-mae' })
  return { sessionId: 'mae', ccSessionId: 'cc-mae', cwd: '/w', ccSessionIdReadyMs: 1 }
})
Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: (_t, ns) =>
        new Proxy(
          {},
          {
            get: (_t2, prop) => {
              if (ns === 'sessions' && prop === 'listLiveGlobal')
                return () => Promise.resolve([...mainLive])
              if (ns === 'room' && prop === 'startMother') return startMother
              if (typeof prop === 'string' && prop.startsWith('on')) return () => () => {}
              return () => Promise.resolve()
            },
          },
        ),
    },
  ),
})

const { useAppStore } = await import('./appStore')

describe('startMother', () => {
  it('a mãe recém-criada já está em liveSessions quando a ação volta, sem reload', async () => {
    await useAppStore.getState().startLiveWatch()
    expect(useAppStore.getState().liveSessions.map((s) => s.id)).toEqual(['a'])

    const res = await useAppStore
      .getState()
      .startMother({ featureId: 'f1', repoId: 'r1', purpose: 'Fechar o PR' })

    expect(startMother).toHaveBeenCalledWith({ featureId: 'f1', repoId: 'r1', purpose: 'Fechar o PR' })
    expect(res.sessionId).toBe('mae')
    expect(useAppStore.getState().liveSessions.map((s) => s.id)).toContain('mae')
    useAppStore.getState().stopLiveWatch()
  })
})
