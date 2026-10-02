import { describe, expect, it } from 'vitest'
import {
  collapseAll,
  doubleClickOpensTerminal,
  hydrateViews,
  inheritViews,
  liftGroup,
  openAll,
  stepLift,
  terminalHostFor,
  toggleCollapsed,
  viewLineage,
  viewOf,
} from './card-view'

describe('card-view — estados do cartão', () => {
  it('default é aberto; o terminal legado lê como aberto', () => {
    expect(viewOf({}, 's1')).toBe('open')
    expect(viewOf({ s1: 'terminal' }, 's1')).toBe('open')
  })

  it('chevron alterna aberto ⇄ recolhido e devolve só o que mudou (o que gravar)', () => {
    const a = toggleCollapsed({}, 's1')
    expect(a.next).toEqual({ s1: 'collapsed' })
    expect(a.changed).toEqual([{ sessionId: 's1', viewState: 'collapsed' }])
    const b = toggleCollapsed(a.next, 's1')
    expect(b.next.s1).toBe('open')
  })

  it('"Abrir todos" abre os recolhidos', () => {
    const r = openAll({ a: 'collapsed', b: 'open' }, ['a', 'b', 'c'])
    expect(r.next).toEqual({ a: 'open', b: 'open' })
    expect(r.changed).toEqual([{ sessionId: 'a', viewState: 'open' }])
  })

  it('"Recolher todos" recolhe todos', () => {
    const r = collapseAll({ b: 'open' }, ['a', 'b'])
    expect(r.next).toEqual({ a: 'collapsed', b: 'collapsed' })
  })

  it('mudança nula não grava nada nem troca a referência', () => {
    const views = { a: 'collapsed' as const }
    const r = collapseAll(views, ['a'])
    expect(r.changed).toEqual([])
    expect(r.next).toBe(views)
  })

  it('persistência: o terminal legado do banco volta como aberto e grava a correção', () => {
    const r = hydrateViews([
      { sessionId: 'a', viewState: 'terminal' },
      { sessionId: 'b', viewState: 'collapsed' },
      { sessionId: 'c', viewState: 'terminal' },
    ])
    expect(r.next).toEqual({ a: 'open', b: 'collapsed', c: 'open' })
    expect(r.changed).toEqual([
      { sessionId: 'a', viewState: 'open' },
      { sessionId: 'c', viewState: 'open' },
    ])
  })
})

describe('card-view — onde o terminal do mapa abre', () => {
  it('sempre na modal (nunca leva até a aba); sem PTY viva, em lugar nenhum', () => {
    expect(terminalHostFor({ status: 'working' })).toBe('modal')
    expect(terminalHostFor(undefined)).toBe('none')
    // Encerrada segue em liveSessions: o duplo clique não pode abrir PTY morta.
    expect(terminalHostFor({ status: 'ended' })).toBe('none')
  })
})

describe('card-view — faixa de troca da modal', () => {
  const n = (sessionId: string, projectId: string | null, repoLabel: string, at: number) => ({
    sessionId,
    projectId,
    repoLabel,
    lastActivityAt: at,
  })
  const nodes = [
    n('a', 'p1', 'web', 1),
    n('b', 'p1', 'api', 5),
    n('c', 'p2', 'web', 9),
    n('d', 'p1', 'web', 7),
    n('e', 'p1', 'web', 3),
  ]

  it('só as sessões em uso do mesmo agrupamento, na ordem do mapa', () => {
    expect(liftGroup(nodes, 'a', new Set(['a', 'b', 'c', 'd']))).toEqual(['b', 'd', 'a'])
  })

  it('sessão fora do grafo fica sozinha na faixa', () => {
    expect(liftGroup(nodes, 'zz', new Set())).toEqual(['zz'])
  })

  it('Alt+, / Alt+. dão a volta nas pontas', () => {
    expect(stepLift(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(stepLift(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(stepLift(['a'], 'x', 1)).toBe('x')
  })
})

describe('linhagem do estado do cartão', () => {
  it('a sucessora do bastão e a conversa retomada herdam o recolhido; terminal vira aberto', () => {
    const lineage = viewLineage(
      [
        { sessionId: 'old', ccSessionId: 'cc1' },
        { sessionId: 'new', ccSessionId: 'cc1' },
        { sessionId: 'pred', ccSessionId: 'cc2' },
        { sessionId: 'succ', ccSessionId: 'cc3' },
      ],
      [{ kind: 'baton', from: 'pred', to: 'succ' }],
      new Set(['new', 'succ']),
    )
    expect(lineage.sort()).toEqual([
      ['new', 'old'],
      ['succ', 'pred'],
    ])
    const r = inheritViews({ old: 'collapsed', pred: 'terminal' }, lineage)
    expect(viewOf(r.next, 'new')).toBe('collapsed')
    expect(viewOf(r.next, 'succ')).toBe('open')
  })

  it('quem já tem estado próprio não herda', () => {
    const r = inheritViews({ new: 'open', old: 'collapsed' }, [['new', 'old']])
    expect(r.changed).toEqual([])
  })
})

// Regressão: sem o stopPropagation do header, o duplo clique no chevron ou no
// chip da mãe também abria a modal do terminal.
describe('doubleClickOpensTerminal', () => {
  it('área vazia ou título abrem; controles do header não', () => {
    document.body.innerHTML =
      '<div id="card"><span id="title">t</span><button id="chev"><svg id="icon"></svg></button></div>'
    expect(doubleClickOpensTerminal(document.getElementById('card'))).toBe(true)
    expect(doubleClickOpensTerminal(document.getElementById('title'))).toBe(true)
    expect(doubleClickOpensTerminal(document.getElementById('chev'))).toBe(false)
    expect(doubleClickOpensTerminal(document.getElementById('icon'))).toBe(false)
    expect(doubleClickOpensTerminal(null)).toBe(true)
  })
})
