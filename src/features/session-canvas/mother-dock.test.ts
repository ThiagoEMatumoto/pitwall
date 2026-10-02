import { beforeEach, describe, expect, it } from 'vitest'
import {
  DOCK_DEFAULT_W,
  DOCK_MAX_W,
  DOCK_MIN_W,
  clampDockWidth,
  followBaton,
  motherOfFocus,
  fitDockToRow,
  MAP_MIN_W,
  useMotherDockStore,
} from './mother-dock'
import { useTerminalLease, leaseBlocks } from '@/features/sessions/terminal-lease'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

const baton = (from: string, to: string) => ({ kind: 'baton', from, to })

describe('followBaton', () => {
  it('segue a cadeia do bastão até a sucessora em uso', () => {
    const edges = [baton('m1', 'm2'), baton('m2', 'm3')]
    expect(followBaton('m1', edges, new Set(['m1', 'm2', 'm3']))).toBe('m3')
  })

  it('sem bastão (ou sucessora fora de uso) fica onde está', () => {
    expect(followBaton('m1', [], new Set(['m1']))).toBe('m1')
    expect(followBaton('m1', [baton('m1', 'm2')], new Set(['m1']))).toBe('m1')
  })

  it('ciclo não trava', () => {
    expect(followBaton('a', [baton('a', 'b'), baton('b', 'a')], new Set(['a', 'b']))).toBe('b')
  })
})

describe('clampDockWidth', () => {
  it('limita e arredonda', () => {
    expect(clampDockWidth(100)).toBe(DOCK_MIN_W)
    expect(clampDockWidth(99_999)).toBe(DOCK_MAX_W)
    expect(clampDockWidth(Number.NaN)).toBe(DOCK_DEFAULT_W)
    expect(clampDockWidth(512.6)).toBe(513)
  })
})

function n(sessionId: string, patch: Partial<SessionGraphNode> = {}): SessionGraphNode {
  return {
    sessionId,
    ccSessionId: null,
    title: sessionId,
    projectId: 'p1',
    repoId: 'r1',
    repoLabel: 'r1',
    provider: 'claude',
    status: 'idle',
    attentionReason: null,
    lastActivityAt: 1,
    purposeHint: null,
    purpose: null,
    purposeSource: null,
    groupId: null,
    lastSummary: null,
    lastSummaryAt: null,
    childOfHandoffId: null,
    ...patch,
  }
}

describe('motherOfFocus', () => {
  const nodes = [
    n('m', { isMother: true, childCount: 2, featureId: 'f1' }),
    n('c1', { featureId: 'f1', childOfHandoffId: 'h1' }),
    n('m2', { isMother: true, childCount: 1, featureId: 'f2' }),
    n('solo', { featureId: null }),
  ]
  const edges = [{ kind: 'handoff', from: 'm', to: 'c1' }]
  const inUse = new Set(nodes.map((x) => x.sessionId))

  it('sessão selecionada filha → a mãe dela', () => {
    expect(motherOfFocus(nodes, edges, inUse, { sessionId: 'c1' })).toBe('m')
  })
  it('a própria mãe selecionada → ela', () => {
    expect(motherOfFocus(nodes, edges, inUse, { sessionId: 'm2' })).toBe('m2')
  })
  it('sem seleção: a mãe da feature em foco', () => {
    expect(motherOfFocus(nodes, edges, inUse, { featureId: 'f2' })).toBe('m2')
  })
  it('sem nada: a mãe mais recente do mapa; sem mãe, null', () => {
    expect(motherOfFocus(nodes, edges, inUse, {})).toBe('m')
    expect(motherOfFocus([n('x')], [], new Set(['x']), {})).toBeNull()
  })

  // Cadeia de 3 níveis: M (1 filha C) e C (2 netas). C tem mais filhas, mas o
  // destaque, o enquadrar e o atalho sem seleção são da mãe do topo.
  it('cadeia mãe→filha→netas: sem seleção é a mãe do topo, não a intermediária', () => {
    const chain = [
      n('M', { isMother: true, childCount: 1, featureId: 'f1' }),
      n('C', { isMother: true, childCount: 2, featureId: 'f1', lastActivityAt: 9 }),
      n('g1', { featureId: 'f1' }),
      n('g2', { featureId: 'f1' }),
    ]
    const chainEdges = [
      { kind: 'handoff', from: 'M', to: 'C' },
      { kind: 'handoff', from: 'C', to: 'g1' },
      { kind: 'handoff', from: 'C', to: 'g2' },
    ]
    const all = new Set(chain.map((x) => x.sessionId))
    expect(motherOfFocus(chain, chainEdges, all, {})).toBe('M')
    expect(motherOfFocus(chain, chainEdges, all, { featureId: 'f1' })).toBe('M')
    // Neta selecionada: a mãe dela (a intermediária) continua valendo.
    expect(motherOfFocus(chain, chainEdges, all, { sessionId: 'g1' })).toBe('C')
    // Mãe do topo encerrada (fora de uso): a intermediária vira o topo.
    expect(motherOfFocus(chain, chainEdges, new Set(['C', 'g1', 'g2']), {})).toBe('C')
  })
})

describe('useMotherDockStore', () => {
  beforeEach(() => {
    useMotherDockStore.setState({ pinnedId: null, width: DOCK_DEFAULT_W })
    useTerminalLease.setState({ leases: {}, stacks: {} })
    localStorage.clear()
  })

  it('fixar e desafixar persistem no localStorage', () => {
    useMotherDockStore.getState().pin('m')
    expect(JSON.parse(localStorage.getItem('cm:mother-dock')!)).toMatchObject({ pinnedId: 'm' })
    useMotherDockStore.getState().setWidth(600)
    expect(JSON.parse(localStorage.getItem('cm:mother-dock')!)).toMatchObject({ width: 600 })
    useMotherDockStore.getState().unpin()
    expect(JSON.parse(localStorage.getItem('cm:mother-dock')!)).toMatchObject({ pinnedId: null })
  })

  it('o bastão passa a coluna para a sucessora', () => {
    useMotherDockStore.getState().pin('m1')
    useMotherDockStore.getState().follow([baton('m1', 'm2')], new Set(['m1', 'm2']))
    expect(useMotherDockStore.getState().pinnedId).toBe('m2')
  })

  // Pedido de foco é de uso único: um remount da coluna (voltar ao mapa) ou a
  // troca de PTY pelo bastão não podem roubar o foco de novo.
  it('o pedido de foco é consumido uma vez só', () => {
    useMotherDockStore.setState({ focusPending: false })
    expect(useMotherDockStore.getState().takeFocus()).toBe(false)
    useMotherDockStore.getState().pin('m')
    expect(useMotherDockStore.getState().takeFocus()).toBe(true)
    expect(useMotherDockStore.getState().takeFocus()).toBe(false)
    useMotherDockStore.getState().requestFocus()
    expect(useMotherDockStore.getState().takeFocus()).toBe(true)
    expect(useMotherDockStore.getState().takeFocus()).toBe(false)
  })
})

// Regra de um xterm por PTY: a coluna segura a lease; a modal da MESMA sessão
// fica por cima e, ao fechar, devolve à coluna (nunca à aba no meio).
describe('lease coluna × aba × modal', () => {
  beforeEach(() => useTerminalLease.setState({ leases: {}, stacks: {} }))

  it('a coluna tira o xterm da aba', () => {
    useTerminalLease.getState().acquire('m', 'dock')
    const owner = useTerminalLease.getState().leases.m
    expect(leaseBlocks(owner, undefined)).toBe(true)
    expect(leaseBlocks(owner, 'dock')).toBe(false)
  })

  it('modal por cima da coluna: só a modal desenha; ao fechar volta à coluna', () => {
    const lease = useTerminalLease.getState()
    lease.acquire('m', 'dock')
    lease.acquire('m', 'modal')
    let owner = useTerminalLease.getState().leases.m
    expect(leaseBlocks(owner, 'dock')).toBe(true)
    expect(leaseBlocks(owner, 'modal')).toBe(false)
    expect(leaseBlocks(owner, undefined)).toBe(true)
    useTerminalLease.getState().release('m', 'modal')
    owner = useTerminalLease.getState().leases.m
    expect(owner).toBe('dock')
    expect(leaseBlocks(owner, undefined)).toBe(true)
  })

  it('desafixar com a modal aberta mantém a modal; fechar tudo devolve à aba', () => {
    const lease = useTerminalLease.getState()
    lease.acquire('m', 'dock')
    lease.acquire('m', 'modal')
    useTerminalLease.getState().release('m', 'dock')
    expect(useTerminalLease.getState().leases.m).toBe('modal')
    useTerminalLease.getState().release('m', 'modal')
    expect(useTerminalLease.getState().leases.m).toBeUndefined()
  })
})

describe('pedido de ir à mãe feito fora do mapa', () => {
  it('fica guardado até o mapa consumir, uma vez só', () => {
    const s = useMotherDockStore.getState()
    s.requestFromOutside('aba-filha')
    expect(useMotherDockStore.getState().takePendingFromOutside()).toEqual({ sessionId: 'aba-filha' })
    expect(useMotherDockStore.getState().takePendingFromOutside()).toBeNull()
  })
})

describe('fitDockToRow', () => {
  it('largura salva num monitor grande não espreme o mapa numa janela menor', () => {
    // 960 salvos; linha de 1100px (laptop 1366 com sidebar): o mapa fica com o mínimo.
    expect(fitDockToRow(960, 1100)).toBe(1100 - MAP_MIN_W)
    expect(1100 - fitDockToRow(960, 1100)).toBeGreaterThanOrEqual(MAP_MIN_W)
  })
  it('com espaço sobrando, vale a largura escolhida', () => {
    expect(fitDockToRow(520, 2400)).toBe(520)
  })
  it('linha estreita demais para os dois mínimos: a coluna fica com 40%', () => {
    expect(fitDockToRow(520, 700)).toBe(280)
  })
  it('linha ainda não medida: a largura escolhida', () => {
    expect(fitDockToRow(700, null)).toBe(700)
  })
})
