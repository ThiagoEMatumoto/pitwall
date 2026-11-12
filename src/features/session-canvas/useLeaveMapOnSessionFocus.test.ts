import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  prefsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
  sessionsApi: { adoptDraft: vi.fn().mockResolvedValue(null) },
  workspaceApi: { savePanes: vi.fn().mockResolvedValue(undefined) },
}))

import { useLeaveMapOnSessionFocus } from './useLeaveMapOnSessionFocus'
import { useProjectsViewStore } from './projects-view-store'
import { useAppStore, type ActivePane } from '@/store/appStore'
import { useTerminalLease } from '@/features/sessions/terminal-lease'
import type { LiveSessionInfo } from '../../../shared/types/ipc'

const pane = (id: string) => ({ paneId: id }) as unknown as ActivePane

const liveOf = (id: string): LiveSessionInfo => ({
  id,
  ccSessionId: `cc-${id}`,
  name: null,
  title: null,
  status: 'working',
  repo: null,
  projectName: null,
  projectIcon: null,
  projectColor: null,
  lastActivityAt: null,
  lastText: null,
})

describe('useLeaveMapOnSessionFocus', () => {
  beforeEach(() => {
    localStorage.clear()
    useProjectsViewStore.setState({ view: 'map', scopeMode: 'all' })
    useAppStore.setState({ focusPaneId: null, panes: [], restoreComplete: true })
    useTerminalLease.setState({ leases: {}, stacks: {} })
  })

  it('com a modal do mapa segurando a PTY, o foco de aba não tira o mapa da frente', () => {
    useTerminalLease.getState().acquire('s1', 'modal')
    renderHook(() => useLeaveMapOnSessionFocus())
    act(() => useAppStore.setState({ focusPaneId: 'pane-1' }))
    expect(useProjectsViewStore.getState().view).toBe('map')
  })

  it('focar uma aba existente (sidebar, strip, toast) sai do mapa', () => {
    renderHook(() => useLeaveMapOnSessionFocus())
    act(() => useAppStore.setState({ focusPaneId: 'pane-1' }))
    expect(useProjectsViewStore.getState().view).toBe('terminals')
  })

  it('uma aba nova (nova sessão) sai do mapa', () => {
    renderHook(() => useLeaveMapOnSessionFocus())
    act(() => useAppStore.setState({ panes: [pane('pane-1')] }))
    expect(useProjectsViewStore.getState().view).toBe('terminals')
  })

  // As panes abaixo saem do próprio store (focusOrOpenSession), não de um molde:
  // é ele quem decide se a aba nasce em segundo plano.
  describe('aba aberta pelo store', () => {
    const open = (id: string, opts?: { background: boolean }) =>
      act(() => useAppStore.getState().focusOrOpenSession(liveOf(id), opts))

    // Nasce inativa: não há xterm recebendo teclas atrás do mapa.
    it('em segundo plano, ao lado de outra aba: o mapa fica na frente', async () => {
      await open('s-mae')
      // O AppShell limpa o pedido de foco depois de ativar o painel.
      useAppStore.setState({ focusPaneId: null })
      renderHook(() => useLeaveMapOnSessionFocus())

      await open('s-child', { background: true })

      expect(useAppStore.getState().panes).toHaveLength(2)
      expect(useProjectsViewStore.getState().view).toBe('map')
    })

    // O mapa aparece mesmo sem aba: quem escreve no cartão de uma filha em segundo
    // plano tem de continuar nele para ver o aviso do envio.
    it('em segundo plano sem nenhuma aba: o mapa fica na frente', async () => {
      renderHook(() => useLeaveMapOnSessionFocus())

      await open('s-child', { background: true })

      expect(useAppStore.getState().panes).toHaveLength(1)
      expect(useProjectsViewStore.getState().view).toBe('map')
    })

    // O Terminal apaga a marca ao montar: a aba passa a contar, mas não chegou agora.
    it('em segundo plano, depois de o terminal montar: o mapa fica na frente', async () => {
      renderHook(() => useLeaveMapOnSessionFocus())
      await open('s-child', { background: true })

      act(() => {
        const { panes, clearPaneBackground } = useAppStore.getState()
        clearPaneBackground(panes[0].paneId)
      })

      expect(useProjectsViewStore.getState().view).toBe('map')
    })

    it('aba nova depois de uma em segundo plano já montada: o mapa cede', async () => {
      renderHook(() => useLeaveMapOnSessionFocus())
      await open('s-child', { background: true })
      act(() => {
        const { panes, clearPaneBackground } = useAppStore.getState()
        clearPaneBackground(panes[0].paneId)
      })

      act(() => useAppStore.setState((s) => ({ panes: [...s.panes, pane('pane-nova')] })))

      expect(useProjectsViewStore.getState().view).toBe('terminals')
    })

    it('com foco: o mapa cede', async () => {
      await open('s-mae')
      useAppStore.setState({ focusPaneId: null })
      renderHook(() => useLeaveMapOnSessionFocus())

      await open('s-child')

      expect(useProjectsViewStore.getState().view).toBe('terminals')
    })
  })

  it('as panes do restore do boot não tiram o mapa da frente', () => {
    useAppStore.setState({ restoreComplete: false })
    renderHook(() => useLeaveMapOnSessionFocus())
    act(() => useAppStore.setState({ panes: [pane('a'), pane('b')] }))
    act(() => useAppStore.setState({ restoreComplete: true }))
    expect(useProjectsViewStore.getState().view).toBe('map')
  })

  it('fechar uma aba não sai do mapa', () => {
    useAppStore.setState({ panes: [pane('a'), pane('b')] })
    renderHook(() => useLeaveMapOnSessionFocus())
    act(() => useAppStore.setState({ panes: [pane('a')] }))
    expect(useProjectsViewStore.getState().view).toBe('map')
  })
})
