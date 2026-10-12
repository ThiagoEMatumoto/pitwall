import { beforeEach, expect, it } from 'vitest'

// O open_panes é o que o próximo boot reabre. Mudança estrutural (abrir/fechar
// aba) tem que chegar ao main no mesmo tick, sem o debounce de 500ms: um kill -9
// logo depois do Ctrl+T não pode perder a aba.

const saved: { paneId: string; ccSessionId: string }[][] = []
let spawned = 0

Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: (_t, ns) =>
        new Proxy(
          {},
          {
            get: (_t2, prop) => {
              if (ns === 'sessions' && prop === 'spawn')
                return () => {
                  spawned += 1
                  return Promise.resolve({
                    id: `sess-${spawned}`,
                    ccSessionId: `cc-${spawned}`,
                    status: 'running',
                  })
                }
              if (ns === 'workspace' && prop === 'savePanes')
                return (snaps: { paneId: string; ccSessionId: string }[]) => {
                  saved.push(snaps)
                  return Promise.resolve()
                }
              if (typeof prop === 'string' && prop.startsWith('on')) return () => () => {}
              return () => Promise.resolve()
            },
          },
        ),
    },
  ),
})

const { useAppStore } = await import('./appStore')

const nextTick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  saved.length = 0
  useAppStore.setState({ panes: [] })
})

it('abrir uma pane dispara savePanes imediato, sem esperar o debounce', async () => {
  await useAppStore.getState().openSession(null, null, null, null, 'pane-open')
  await nextTick()
  expect(saved.at(-1)?.map((s) => s.paneId)).toContain('pane-open')
})

it('fechar uma pane também grava na hora', async () => {
  await useAppStore.getState().openSession(null, null, null, null, 'pane-x')
  await nextTick()
  const before = saved.length
  useAppStore.getState().closePane('pane-x')
  await nextTick()
  expect(saved.length).toBe(before + 1)
  expect(saved.at(-1)?.map((s) => s.paneId)).not.toContain('pane-x')
})
