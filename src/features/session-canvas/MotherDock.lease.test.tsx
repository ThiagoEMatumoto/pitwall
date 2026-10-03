import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Só importa QUEM segura a PTY: o xterm real não monta no jsdom.
// O baton precisa de algo focável no lugar do xterm: o textarea que o xterm põe.
vi.mock('@/features/sessions/Terminal', () => ({
  Terminal: ({ session }: { session: { id: string } }) => (
    <textarea className="xterm-helper-textarea" data-sid={session.id} />
  ),
}))
// Os stores importados leem window.api no load: toda chamada devolve algo que é
// ao mesmo tempo um unsubscribe e uma promessa que nunca resolve.
vi.hoisted(() => {
  const pending = new Promise<never>(() => undefined)
  const ret = () =>
    Object.assign(() => undefined, {
      then: pending.then.bind(pending),
      catch: pending.catch.bind(pending),
    })
  const ns = new Proxy({}, { get: () => ret })
  ;(globalThis as { window: { api?: unknown } }).window.api = new Proxy({}, { get: () => ns })
})

import { MotherDock } from './MotherDock'
import { useMotherDockStore } from './mother-dock'
import { useTerminalLease } from '@/features/sessions/terminal-lease'
import { useAppStore } from '@/store/appStore'
import type { LiveSessionInfo } from '../../../shared/types/ipc'
import type { SessionGraph } from '../../../shared/types/session-graph'

const live = { id: 's1', status: 'running', provider: 'claude' } as unknown as LiveSessionInfo
const graph = {
  nodes: [{ sessionId: 's1', isMother: true, childCount: 1, status: 'running', title: 'M1' }],
  edges: [],
} as unknown as SessionGraph

describe('MotherDock × lease', () => {
  beforeEach(() => {
    useTerminalLease.setState({ leases: {}, stacks: {} })
    useAppStore.setState({ liveSessions: [live] })
    useMotherDockStore.setState({ pinnedId: 's1' })
  })

  // O painel mora dentro do Mapa: trocar Mapa → Terminais desmonta o Mapa, e a
  // aba da mãe tem de voltar a montar o xterm (não ficar em "Aberta no Mapa").
  it('o Mapa desmontando solta a lease do painel', () => {
    const { unmount } = render(
      <MotherDock
        graph={graph}
        inUse={new Set(['s1'])}
        onOpenModal={vi.fn()}
        onOpenTab={vi.fn()}
        onCenter={vi.fn()}
      />,
    )
    expect(useTerminalLease.getState().leases.s1).toBe('dock')
    unmount()
    expect(useTerminalLease.getState().leases.s1).toBeUndefined()
    expect(useTerminalLease.getState().stacks.s1).toBeUndefined()
  })

  // O debounce da troca separa as duas mudanças (a trava muda já, o painel 300ms
  // depois): o foco tem de voltar ao xterm da sucessora mesmo assim.
  it('bastão com o foco no painel: o foco vai para o xterm da sucessora', () => {
    vi.useFakeTimers()
    try {
      const two = {
        nodes: [
          { sessionId: 's1', isMother: true, childCount: 1, status: 'running', title: 'M1' },
          { sessionId: 's2', isMother: true, childCount: 1, status: 'running', title: 'M2' },
        ],
        edges: [],
      } as unknown as SessionGraph
      useAppStore.setState({ liveSessions: [live, { ...live, id: 's2' } as LiveSessionInfo] })
      const { container } = render(
        <MotherDock
          graph={two}
          inUse={new Set(['s1', 's2'])}
          autoId={null}
          onOpenModal={vi.fn()}
          onOpenTab={vi.fn()}
          onCenter={vi.fn()}
        />,
      )
      act(() => container.querySelector<HTMLTextAreaElement>('[data-sid="s1"]')!.focus())
      act(() => useMotherDockStore.setState({ pinnedId: 's2' }))
      act(() => void vi.advanceTimersByTime(350))
      act(() => void vi.advanceTimersByTime(50))
      expect(document.activeElement?.getAttribute('data-sid')).toBe('s2')
    } finally {
      vi.useRealTimers()
    }
  })
})
