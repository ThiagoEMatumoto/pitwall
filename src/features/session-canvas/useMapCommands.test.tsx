import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({ canvasApi: {} }))

import { useMapCommands } from './useMapCommands'
import { useCrewDockStore } from '@/features/handoffs/crew-dock-store'
import { useHandoffsStore } from '@/store/handoffsStore'
import { useAppStore } from '@/store/appStore'
import type { Handoff } from '../../../shared/types/ipc'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import type { MapInput } from './graph-to-flow'

const node = (sessionId: string, extra: Partial<SessionGraphNode> = {}) =>
  ({
    sessionId,
    projectId: 'p1',
    repoLabel: 'api',
    lastActivityAt: 1,
    provider: 'claude',
    childOfHandoffId: null,
    ...extra,
  }) as SessionGraphNode

describe('useMapCommands.peek', () => {
  beforeEach(() => {
    useCrewDockStore.setState({ peekTarget: null, peekId: null, peekOrigin: 'dock' })
  })

  // Regressão: a filha do dock abria o peek com origin 'dock' (sem lift, e o
  // "Ver o terminal" levava pra aba) — o mesmo cartão abria duas modais.
  it('filha do dock abre o peek do handoff como lift do mapa, com a faixa', () => {
    useHandoffsStore.setState({
      handoffs: [
        { id: 'h1', status: 'running', childSessionId: 'c1', dismissedAt: null } as Handoff,
      ],
    })
    const nodes = [node('m'), node('c1', { childOfHandoffId: 'h1' })]
    const input = () =>
      ({ graph: { nodes }, inUse: new Set(['m', 'c1']) }) as unknown as MapInput
    const { result } = renderHook(() => useMapCommands({ kind: 'all' } as never, input))
    result.current.peek(nodes[1]!)
    expect(useCrewDockStore.getState()).toMatchObject({
      peekTarget: { kind: 'handoff', id: 'h1' },
      peekOrigin: 'map',
      peekMode: 'chat',
    })
    expect(useCrewDockStore.getState().peekSiblings).toEqual(expect.arrayContaining(['m', 'c1']))
  })

  // Regressão: Terminal/Enter/duplo clique abriam a filha do dock como sessão
  // avulsa — sem a pergunta pendente nem a resposta pelo canal do handoff.
  it('interact numa filha do dock abre o peek do handoff em terminal', () => {
    useHandoffsStore.setState({
      handoffs: [
        { id: 'h1', status: 'needs_input', childSessionId: 'c1', dismissedAt: null } as Handoff,
      ],
    })
    useAppStore.setState({ liveSessions: [{ id: 'c1', status: 'waiting' }] as never })
    const nodes = [node('m'), node('c1', { childOfHandoffId: 'h1' })]
    const input = () =>
      ({ graph: { nodes }, inUse: new Set(['m', 'c1']) }) as unknown as MapInput
    const { result } = renderHook(() => useMapCommands({ kind: 'all' } as never, input))
    result.current.interact('c1')
    expect(useCrewDockStore.getState()).toMatchObject({
      peekTarget: { kind: 'handoff', id: 'h1' },
      peekOrigin: 'map',
      peekMode: 'terminal',
    })
  })
})

describe('crew-dock-store.openPeek sem origin', () => {
  it('com o lift aberto continua lift (sem faixa); sem lift é peek do dock', () => {
    useCrewDockStore.getState().openSessionPeek('m', 'chat', { origin: 'map', siblings: ['m'] })
    useCrewDockStore.getState().openPeek('h2')
    expect(useCrewDockStore.getState()).toMatchObject({
      peekTarget: { kind: 'handoff', id: 'h2' },
      peekOrigin: 'map',
      peekSiblings: [],
    })
    useCrewDockStore.getState().closePeek()
    useCrewDockStore.getState().openPeek('h2')
    expect(useCrewDockStore.getState().peekOrigin).toBe('dock')
  })
})
