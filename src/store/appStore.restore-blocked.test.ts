import { beforeEach, expect, it, vi } from 'vitest'

// Crash-loop (>=2 tentativas sem shutdown limpo): o restore não roda e o banner
// oferece restaurar. O open_panes é o que o banner restaura: não pode ser perdido.

const repo = { id: 'r1', label: 'infra', path: '/tmp/infra' }
const bootSnaps = ['a', 'b', 'c'].map((k) => ({
  ccSessionId: `cc-${k}`,
  repo,
  projectName: 'Infra',
  projectIcon: null,
  projectColor: null,
  paneId: `pane-${k}`,
}))

let savePanes: { paneId: string; ccSessionId: string }[][] = []
let resumes: string[] = []

Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: (_t, ns) =>
        new Proxy(
          {},
          {
            get: (_t2, prop) => {
              if (ns === 'workspace' && prop === 'getBootState')
                return () =>
                  Promise.resolve({
                    openPanes: bootSnaps,
                    cleanShutdown: false,
                    restoreAttempts: 2,
                    dockLayout: null,
                  })
              if (ns === 'workspace' && prop === 'savePanes')
                return (snaps: { paneId: string; ccSessionId: string }[]) => {
                  savePanes.push(snaps)
                  return Promise.resolve()
                }
              if (ns === 'sessions' && prop === 'listLiveGlobal') return () => Promise.resolve([])
              if (ns === 'sessions' && prop === 'isResumable') return () => Promise.resolve(true)
              if (ns === 'sessions' && prop === 'resume')
                return (input: { ccSessionId: string }) => {
                  resumes.push(input.ccSessionId)
                  return Promise.resolve({
                    session: {
                      id: `sess-${input.ccSessionId}`,
                      ccSessionId: input.ccSessionId,
                      repoId: 'r1',
                      title: null,
                      status: 'running',
                      paneId: null,
                      startedAt: 1,
                    },
                    reattached: false,
                  })
                }
              if (ns === 'sessions' && prop === 'spawn')
                return () =>
                  Promise.resolve({ id: 'sess-user', ccSessionId: 'cc-user', status: 'running' })
              if (typeof prop === 'string' && prop.startsWith('on')) return () => () => {}
              return () => Promise.resolve()
            },
          },
        ),
    },
  ),
})

const waitPersist = () => new Promise((r) => setTimeout(r, 600))

// restoreWorkspace roda uma vez por módulo: cada teste carrega um store novo.
async function freshStore() {
  vi.resetModules()
  return (await import('./appStore')).useAppStore
}

beforeEach(() => {
  savePanes = []
  resumes = []
})

it('restore bloqueado não toca o open_panes', async () => {
  const store = await freshStore()
  await store.getState().restoreWorkspace()
  await waitPersist()

  expect(store.getState().restoreBlocked).toBe(true)
  expect(resumes).toEqual([])
  expect(savePanes).toEqual([])
})

it('aba aberta com o restore bloqueado é gravada junto das que o banner restaura', async () => {
  const store = await freshStore()
  await store.getState().restoreWorkspace()
  await store.getState().openSession(null, null, null, null, 'pane-user')
  await waitPersist()

  expect(savePanes.length).toBeGreaterThan(0)
  for (const saved of savePanes)
    expect(saved.map((s) => s.paneId).sort()).toEqual(
      [...bootSnaps.map((s) => s.paneId), 'pane-user'].sort(),
    )
})

it('Restaurar sessões grava o conjunto final uma vez', async () => {
  const store = await freshStore()
  await store.getState().restoreWorkspace()
  await store.getState().retryRestore()
  await waitPersist()

  expect(resumes.sort()).toEqual(bootSnaps.map((s) => s.ccSessionId))
  expect(savePanes).toHaveLength(1)
  expect(savePanes[0].map((s) => s.paneId).sort()).toEqual(bootSnaps.map((s) => s.paneId))
})
