import { describe, expect, it } from 'vitest'

// Depois de um reload do renderer o main ainda guarda o espelho de dormant do
// processo anterior. O primeiro sync deste processo sai sempre, mesmo vazio;
// os seguintes só quando a lista muda.
const synced: unknown[][] = []
Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: (_t, ns) =>
        new Proxy(
          {},
          {
            get: (_t2, prop) => (arg: unknown) => {
              if (ns === 'sessions' && prop === 'dormantSync') synced.push(arg as unknown[])
              if (ns === 'sessions' && prop === 'listLiveGlobal') return Promise.resolve([])
              if (typeof prop === 'string' && prop.startsWith('on')) return () => {}
              return Promise.resolve()
            },
          },
        ),
    },
  ),
})

const { useAppStore } = await import('./appStore')

describe('dormantSync', () => {
  it('boot sem panes: o primeiro sync sai vazio; repetir a lista não reenvia', async () => {
    await useAppStore.getState().startLiveWatch()
    expect(synced).toEqual([[]])

    useAppStore.setState({ panes: [] })
    expect(synced).toEqual([[]])
    useAppStore.getState().stopLiveWatch()
  })

  it('sem live-watch (ninguém escuta wake-request) não sincroniza', () => {
    synced.length = 0
    useAppStore.setState({ panes: [] })
    expect(synced).toEqual([])
  })
})
