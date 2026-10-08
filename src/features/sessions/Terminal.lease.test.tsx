import { act, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// O xterm real precisa de canvas; aqui só importa QUEM monta. Se o host montasse
// com a lease em outro lugar, useSession seria chamado e o resize iria pra PTY.
const { resize, useSession } = vi.hoisted(() => {
  const resize = vi.fn()
  return {
    resize,
    useSession: vi.fn(() => ({
      exited: false,
      exitCode: null,
      error: null,
      write: vi.fn(),
      kill: vi.fn(),
      resize,
      setDataHandler: vi.fn(),
    })),
  }
})
vi.mock('./useSession', () => ({ useSession }))
const { exitListeners } = vi.hoisted(() => ({
  exitListeners: new Set<(e: { sessionId: string; exitCode: number | null }) => void>(),
}))
vi.mock('@/lib/ipc', () => ({
  sessionsApi: {
    getBacklog: vi.fn(() => new Promise(() => undefined)),
    resize: vi.fn(),
    onExit: vi.fn((cb: (e: { sessionId: string; exitCode: number | null }) => void) => {
      exitListeners.add(cb)
      return () => exitListeners.delete(cb)
    }),
  },
  gpuApi: { onResumed: vi.fn(() => () => undefined) },
  prefsApi: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
}))

import { LeasedPlaceholder, Terminal } from './Terminal'
import { useTerminalLease } from './terminal-lease'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useProjectsViewStore } from '@/features/session-canvas/projects-view-store'
import type { Session } from '../../../shared/types/ipc'

const session = { id: 's1', repoId: 'r1', ccSessionId: 'cc1', provider: 'claude' } as Session

function tab(onClose = vi.fn()) {
  return render(
    <Terminal
      session={session}
      repoLabel="web"
      repoPath="/tmp"
      projectName="p"
      onClose={onClose}
    />,
  )
}

describe('Terminal × lease da modal', () => {
  beforeEach(() => {
    useTerminalLease.setState({ leases: {}, stacks: {} })
    resize.mockClear()
    useSession.mockClear()
    exitListeners.clear()
  })

  it('com a lease na modal, a aba não monta o xterm nem manda resize', () => {
    useTerminalLease.getState().acquire('s1', 'modal')
    tab()
    expect(screen.getByTestId('terminal-leased')).toHaveTextContent('Aberta na janela do mapa')
    expect(useSession).not.toHaveBeenCalled()
    expect(resize).not.toHaveBeenCalled()
  })

  it('"Trazer para cá" com a modal: só fecha a modal, nenhuma lease nova', () => {
    useTerminalLease.getState().acquire('s1', 'modal')
    useCrewDockStore.setState({ peekTarget: { kind: 'session', id: 's1' } })
    render(<LeasedPlaceholder host={undefined} owner="modal" />)
    act(() => screen.getByText('Trazer para cá').click())
    expect(useCrewDockStore.getState().peekTarget).toBeNull()
    expect(useTerminalLease.getState().stacks.s1).toEqual(['modal'])
  })

  it('aba com o painel da mãe segurando: "Abrir aqui" vai para Terminais sem pegar lease', () => {
    useTerminalLease.getState().acquire('s1', 'dock')
    useProjectsViewStore.setState({ view: 'map' })
    tab()
    const ph = screen.getByTestId('terminal-leased')
    expect(ph).toHaveAttribute('data-owner', 'dock')
    expect(ph).toHaveTextContent('Aberta no Mapa')
    act(() => screen.getByText('Abrir aqui').click())
    // Sair do mapa desmonta o painel, que solta a lease (MotherDock.lease.test).
    expect(useProjectsViewStore.getState().view).toBe('terminals')
    expect(useTerminalLease.getState().stacks.s1).toEqual(['dock'])
  })

  // Regressão: o painel bloqueado pela modal mostrava o texto e o botão da aba
  // ("Abrir aqui"), e o clique criava uma lease da aba que prendia o painel.
  it('painel da mãe com a modal por cima: texto do painel e "Trazer para cá" fecha a modal', () => {
    useTerminalLease.getState().acquire('s1', 'dock')
    useTerminalLease.getState().acquire('s1', 'modal')
    useCrewDockStore.setState({ peekTarget: { kind: 'session', id: 's1' } })
    render(
      <Terminal
        session={session}
        repoLabel="web"
        repoPath="/tmp"
        projectName="p"
        leaseHost="dock"
        onClose={vi.fn()}
      />,
    )
    const ph = screen.getByTestId('terminal-leased')
    expect(ph).toHaveTextContent('Ele volta para o painel')
    expect(screen.queryByText('Abrir aqui')).toBeNull()
    expect(useSession).not.toHaveBeenCalled()
    act(() => screen.getByText('Trazer para cá').click())
    expect(useCrewDockStore.getState().peekTarget).toBeNull()
    expect(useTerminalLease.getState().stacks.s1).toEqual(['dock', 'modal'])
  })

  // Sem xterm montado a aba não ouve o exit; ao remontar nasceria exited=false e
  // ficaria como pane morta. O placeholder fecha a aba quando a PTY sai.
  it('a PTY sai com a lease na modal: a aba fecha', () => {
    useTerminalLease.getState().acquire('s1', 'modal')
    const onClose = vi.fn()
    tab(onClose)
    for (const cb of exitListeners) cb({ sessionId: 'other', exitCode: 0 })
    expect(onClose).not.toHaveBeenCalled()
    for (const cb of exitListeners) cb({ sessionId: 's1', exitCode: 0 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('aba com a Room segurando: "Aberta na Room", sem botão nem xterm', () => {
    useTerminalLease.getState().acquire('s1', 'room')
    tab()
    const ph = screen.getByTestId('terminal-leased')
    expect(ph).toHaveAttribute('data-owner', 'room')
    expect(ph).toHaveTextContent('Aberta na Room')
    expect(screen.queryByRole('button')).toBeNull()
    expect(useSession).not.toHaveBeenCalled()
  })
})
