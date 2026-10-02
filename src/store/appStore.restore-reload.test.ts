import { describe, expect, it, vi } from 'vitest'

// Recarregar o renderer (botão "Recarregar" do ErrorBoundary, page.reload) roda o
// restoreWorkspace de novo, mas as PTYs do main seguem vivas. Antes, cada aba salva
// em open_panes virava spawn (ou --resume) — um claude a mais por reload, a PTY
// antiga órfã em background. A aba cuja sessão ainda está viva tem que re-attachar.

// appStore lê window.api no module-eval: o mock precisa existir antes do import.
const calls = { spawn: 0, resume: 0 }
const liveItem = {
  id: 'live-1',
  ccSessionId: '11111111-1111-4111-8111-111111111111',
  provider: 'claude',
  name: 'infrastructure',
  title: null,
  repo: { id: 'r1', label: 'infrastructure' },
  projectName: 'Infra',
  projectIcon: null,
  projectColor: null,
  lastActivityAt: 1,
}
const bootState = {
  openPanes: [
    {
      ccSessionId: liveItem.ccSessionId,
      repo: liveItem.repo,
      projectName: 'Infra',
      projectIcon: null,
      paneId: 'pane-saved',
    },
  ],
  cleanShutdown: true,
  restoreAttempts: 0,
  dockLayout: null,
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
                return () => Promise.resolve([liveItem])
              if (ns === 'sessions' && prop === 'isResumable') return () => Promise.resolve(false)
              if (ns === 'sessions' && (prop === 'spawn' || prop === 'resume'))
                return () => {
                  calls[prop] += 1
                  return Promise.resolve({ id: `new-${prop}`, ccSessionId: null })
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

describe('restoreWorkspace após reload do renderer', () => {
  it('re-attacha à PTY viva da aba salva em vez de subir outro claude', async () => {
    await useAppStore.getState().restoreWorkspace()

    expect(calls).toEqual({ spawn: 0, resume: 0 })
    const panes = useAppStore.getState().panes
    expect(panes).toHaveLength(1)
    expect(panes[0].session.id).toBe('live-1')
    expect(panes[0].paneId).toBe('pane-saved')
    expect(useAppStore.getState().restoreComplete).toBe(true)
  })
})
