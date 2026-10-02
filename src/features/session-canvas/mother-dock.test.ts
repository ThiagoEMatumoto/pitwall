import { beforeEach, describe, expect, it } from 'vitest'
import {
  DOCK_DEFAULT_W,
  DOCK_MIN_W,
  PANEL_MAX_SHARE,
  PANEL_MIN_SHARE,
  PANEL_SHARE,
  clampShare,
  effectiveMotherId,
  keepLastMother,
  followBaton,
  motherOfFocus,
  panelWidth,
  shareOfWidth,
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

describe('clampShare', () => {
  it('limita a fração da linha e cai no padrão quando inválida', () => {
    expect(clampShare(0.05)).toBe(PANEL_MIN_SHARE)
    expect(clampShare(0.99)).toBe(PANEL_MAX_SHARE)
    expect(clampShare(Number.NaN)).toBe(PANEL_SHARE)
    expect(clampShare(0.6)).toBe(0.6)
  })
})

// Regressão: clicar num cartão de uma feature sem mãe fechava o painel na hora
// (e reenquadrava a câmera); voltar à feature com mãe reabria e remontava o xterm.
describe('keepLastMother', () => {
  it('a feature em foco sem mãe mantém a última mostrada enquanto ela está em uso', () => {
    expect(keepLastMother(null, 'm1', new Set(['m1']))).toBe('m1')
  })
  it('a última que saiu de uso não volta', () => {
    expect(keepLastMother(null, 'm1', new Set(['m2']))).toBeNull()
    expect(keepLastMother(null, null, new Set(['m1']))).toBeNull()
  })
  it('uma mãe da feature em foco sempre vence', () => {
    expect(keepLastMother('m2', 'm1', new Set(['m1', 'm2']))).toBe('m2')
  })
})

describe('effectiveMotherId', () => {
  it('fixada vence a mãe da feature em foco', () => {
    expect(effectiveMotherId({ pinnedId: 'm1', mode: 'focus', autoId: 'm2' })).toBe('m1')
  })
  it('sem fixar, segue a mãe da feature em foco', () => {
    expect(effectiveMotherId({ pinnedId: null, mode: 'focus', autoId: 'm2' })).toBe('m2')
    expect(effectiveMotherId({ pinnedId: null, mode: 'focus', autoId: null })).toBeNull()
  })
  // Escondido pelo atalho: nem a fixada aparece (a trava fica guardada para quando voltar).
  it('painel escondido não mostra nenhuma', () => {
    expect(effectiveMotherId({ pinnedId: 'm1', mode: 'off', autoId: 'm2' })).toBeNull()
    expect(effectiveMotherId({ pinnedId: null, mode: 'off', autoId: 'm2' })).toBeNull()
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
  // O painel segue a feature em foco: feature sem mãe não empresta a de outra.
  it('strict: feature em foco sem mãe → null (sem fallback para outra feature)', () => {
    expect(motherOfFocus(nodes, edges, inUse, { featureId: 'f9' })).toBe('m')
    expect(motherOfFocus(nodes, edges, inUse, { featureId: 'f9' }, { strict: true })).toBeNull()
    expect(motherOfFocus(nodes, edges, inUse, { featureId: 'f2' }, { strict: true })).toBe('m2')
    expect(motherOfFocus(nodes, edges, inUse, {}, { strict: true })).toBe('m')
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
    useMotherDockStore.setState({ pinnedId: null, mode: 'focus', share: PANEL_SHARE })
    useTerminalLease.setState({ leases: {}, stacks: {} })
    localStorage.clear()
  })

  it('fixar e desafixar persistem no localStorage', () => {
    useMotherDockStore.getState().pin('m')
    expect(JSON.parse(localStorage.getItem('cm:mother-dock')!)).toMatchObject({ pinnedId: 'm' })
    useMotherDockStore.getState().setShare(0.6)
    expect(JSON.parse(localStorage.getItem('cm:mother-dock')!)).toMatchObject({ share: 0.6 })
    useMotherDockStore.getState().unpin()
    expect(JSON.parse(localStorage.getItem('cm:mother-dock')!)).toMatchObject({ pinnedId: null })
  })

  it('o atalho alterna o painel e o modo persiste', () => {
    const s = useMotherDockStore.getState()
    s.togglePanel()
    expect(useMotherDockStore.getState().mode).toBe('off')
    expect(JSON.parse(localStorage.getItem('cm:mother-dock')!)).toMatchObject({ mode: 'off' })
    useMotherDockStore.getState().togglePanel()
    expect(useMotherDockStore.getState().mode).toBe('focus')
  })

  // Fixar com o painel escondido mostra o painel: o clique é "quero ela ali".
  it('fixar com o painel escondido volta a mostrá-lo', () => {
    useMotherDockStore.getState().hide()
    useMotherDockStore.getState().pin('m')
    expect(useMotherDockStore.getState().mode).toBe('focus')
  })

  it('o bastão passa a coluna para a sucessora', () => {
    useMotherDockStore.getState().pin('m1')
    useMotherDockStore.getState().follow([baton('m1', 'm2')], new Set(['m1', 'm2']))
    expect(useMotherDockStore.getState().pinnedId).toBe('m2')
  })

  // Pedido de foco é de uso único: um remount da coluna (voltar ao mapa) ou a
  // troca de PTY pelo bastão não podem roubar o foco de novo. Fixar não pede
  // foco: só o atalho (Ctrl+Shift+O) leva o teclado ao painel.
  it('o pedido de foco é consumido uma vez só', () => {
    useMotherDockStore.setState({ focusPending: false })
    expect(useMotherDockStore.getState().takeFocus()).toBe(false)
    useMotherDockStore.getState().pin('m')
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
    expect(useMotherDockStore.getState().takePendingFromOutside()).toEqual({
      sessionId: 'aba-filha',
    })
    expect(useMotherDockStore.getState().takePendingFromOutside()).toBeNull()
  })
})

describe('panelWidth', () => {
  it('padrão: 55% da linha', () => {
    expect(panelWidth(PANEL_SHARE, 2000)).toBe(1100)
  })
  it('o mapa ao lado nunca fica abaixo do mínimo', () => {
    expect(1100 - panelWidth(PANEL_SHARE, 1100)).toBeGreaterThanOrEqual(MAP_MIN_W)
    expect(panelWidth(0.75, 1400)).toBe(1400 - MAP_MIN_W)
  })
  it('linha estreita demais para os dois mínimos: o painel fica com 40%', () => {
    expect(panelWidth(PANEL_SHARE, 700)).toBe(280)
  })
  it('nunca abaixo do mínimo de leitura quando cabe', () => {
    expect(panelWidth(0.3, 1000)).toBe(DOCK_MIN_W)
  })
  it('linha ainda não medida: a largura padrão', () => {
    expect(panelWidth(PANEL_SHARE, null)).toBe(DOCK_DEFAULT_W)
  })
})

describe('shareOfWidth', () => {
  it('converte a largura arrastada em fração limitada da linha', () => {
    expect(shareOfWidth(1200, 2000)).toBe(0.6)
    expect(shareOfWidth(100, 2000)).toBe(PANEL_MIN_SHARE)
    expect(shareOfWidth(1200, null)).toBe(PANEL_SHARE)
  })
})
