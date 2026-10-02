import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({
  prefsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
}))

import { useLeaveMapOnSessionFocus } from './useLeaveMapOnSessionFocus'
import { useProjectsViewStore } from './projects-view-store'
import { useAppStore, type ActivePane } from '@/store/appStore'
import { useTerminalLease } from '@/features/sessions/terminal-lease'

const pane = (id: string) => ({ paneId: id }) as unknown as ActivePane

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
