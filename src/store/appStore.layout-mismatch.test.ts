import { describe, expect, it } from 'vitest'

// Kill -9 entre o save do open_panes (imediato) e o do dock_layout (do dockview):
// o boot acha um layout que não fala de nenhuma aba salva. Antes o pendingLayout
// ficava setado com ids que nunca voltariam e o workspace travava vazio.

const LIVE_B = {
  id: 'live-b',
  ccSessionId: '22222222-2222-4222-8222-222222222222',
  provider: 'claude',
  name: 'repo',
  title: null,
  repo: { id: 'r1', label: 'repo' },
  projectName: null,
  projectIcon: null,
  projectColor: null,
  lastActivityAt: 1,
}
const layoutOf = (...ids: string[]) =>
  JSON.stringify({ panels: Object.fromEntries(ids.map((id) => [id, { id }])) })
const bootState = {
  openPanes: [
    {
      ccSessionId: LIVE_B.ccSessionId,
      repo: LIVE_B.repo,
      projectName: null,
      projectIcon: null,
      paneId: 'pane-B',
    },
  ],
  cleanShutdown: true,
  restoreAttempts: 0,
  dockLayout: layoutOf('pane-A'),
}
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
                return () => Promise.resolve(bootState)
              if (ns === 'sessions' && prop === 'listLiveGlobal')
                return () => Promise.resolve([LIVE_B])
              if (ns === 'sessions' && prop === 'isResumable') return () => Promise.resolve(false)
              if (typeof prop === 'string' && prop.startsWith('on')) return () => () => {}
              return () => Promise.resolve()
            },
          },
        ),
    },
  ),
})

const { useAppStore } = await import('./appStore')

describe('restore com dock_layout descasado do open_panes', () => {
  it('layout sem paneId em comum: descarta o layout e a aba salva volta', async () => {
    await useAppStore.getState().restoreWorkspace()
    const s = useAppStore.getState()
    expect(s.pendingLayout).toBeNull()
    expect(s.panes.map((p) => p.paneId)).toEqual(['pane-B'])
    expect(s.restoreComplete).toBe(true)
  })

  it('layout com paneId em comum: segue como pendingLayout (retry do banner)', async () => {
    useAppStore.setState({ panes: [], pendingLayout: null })
    bootState.dockLayout = layoutOf('pane-A', 'pane-B')
    await useAppStore.getState().retryRestore()
    expect(useAppStore.getState().pendingLayout).toBe(bootState.dockLayout)
  })
})
