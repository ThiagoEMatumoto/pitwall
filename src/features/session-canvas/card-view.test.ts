import { describe, expect, it } from 'vitest'
import {
  collapseAll,
  enterTerminal,
  hydrateViews,
  inheritViews,
  leaveTerminal,
  mustLeaveTerminal,
  openAll,
  terminalHostFor,
  terminalOf,
  toggleCollapsed,
  viewLineage,
  viewOf,
} from './card-view'

describe('card-view — estados do cartão', () => {
  it('default é aberto', () => {
    expect(viewOf({}, 's1')).toBe('open')
  })

  it('chevron alterna aberto ⇄ recolhido e devolve só o que mudou (o que gravar)', () => {
    const a = toggleCollapsed({}, 's1')
    expect(a.next).toEqual({ s1: 'collapsed' })
    expect(a.changed).toEqual([{ sessionId: 's1', viewState: 'collapsed' }])
    const b = toggleCollapsed(a.next, 's1')
    expect(b.next.s1).toBe('open')
    expect(toggleCollapsed({ s1: 'terminal' }, 's1').next.s1).toBe('collapsed')
  })

  it('"Abrir todos" abre os recolhidos e não derruba o terminal em uso', () => {
    const r = openAll({ a: 'collapsed', b: 'terminal' }, ['a', 'b', 'c'])
    expect(r.next).toEqual({ a: 'open', b: 'terminal' })
    expect(r.changed).toEqual([{ sessionId: 'a', viewState: 'open' }])
  })

  it('"Recolher todos" recolhe inclusive o terminal', () => {
    const r = collapseAll({ b: 'terminal' }, ['a', 'b'])
    expect(r.next).toEqual({ a: 'collapsed', b: 'collapsed' })
    expect(terminalOf(r.next)).toBeNull()
  })

  it('um terminal por vez: entrar num devolve o anterior a aberto', () => {
    const first = enterTerminal({}, 'a')
    expect(terminalOf(first.next)).toBe('a')
    const second = enterTerminal(first.next, 'b')
    expect(second.next).toEqual({ a: 'open', b: 'terminal' })
    expect(second.changed).toEqual([
      { sessionId: 'a', viewState: 'open' },
      { sessionId: 'b', viewState: 'terminal' },
    ])
  })

  it('sair do terminal volta a aberto; sem terminal é no-op sem gravação', () => {
    expect(leaveTerminal({ a: 'terminal' }, 'a').next.a).toBe('open')
    const noop = leaveTerminal({ a: 'collapsed' }, 'a')
    expect(noop.changed).toEqual([])
  })

  it('mudança nula não grava nada nem troca a referência', () => {
    const views = { a: 'collapsed' as const }
    const r = collapseAll(views, ['a'])
    expect(r.changed).toEqual([])
    expect(r.next).toBe(views)
  })

  it('persistência: do banco volta no máximo um terminal (os outros abrem e gravam)', () => {
    const r = hydrateViews([
      { sessionId: 'a', viewState: 'terminal' },
      { sessionId: 'b', viewState: 'collapsed' },
      { sessionId: 'c', viewState: 'terminal' },
    ])
    expect(r.next).toEqual({ a: 'terminal', b: 'collapsed', c: 'open' })
    expect(r.changed).toEqual([{ sessionId: 'c', viewState: 'open' }])
  })
})

describe('card-view — regra aba × cartão', () => {
  it('sessão com aba aberta: "Interagir" leva até a aba (dois xterms na mesma PTY brigam)', () => {
    expect(terminalHostFor({ live: true, hasPane: true })).toBe('tab')
    expect(terminalHostFor({ live: true, hasPane: false })).toBe('card')
    expect(terminalHostFor({ live: false, hasPane: false })).toBe('none')
  })

  it('o terminal do cartão cede à aba, ao peek em terminal, à PTY morta e ao zoom afastado', () => {
    const ok = { live: true, hasPane: false, peekedInTerminal: false, zoom: 1 }
    expect(mustLeaveTerminal(ok)).toBe(false)
    expect(mustLeaveTerminal({ ...ok, hasPane: true })).toBe(true)
    expect(mustLeaveTerminal({ ...ok, peekedInTerminal: true })).toBe(true)
    expect(mustLeaveTerminal({ ...ok, live: false })).toBe(true)
    expect(mustLeaveTerminal({ ...ok, zoom: 0.84 })).toBe(true)
    expect(mustLeaveTerminal({ ...ok, zoom: 0.85 })).toBe(false)
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
