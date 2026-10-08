import { describe, expect, it } from 'vitest'
import { orderTiles, pinKey } from './all-mothers-model'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

// orderTiles só lê sessionId, ccSessionId e lastActivityAt; o grafo real que
// alimenta allMothers/needYouFor está em all-mothers-model.integration.test.ts.
type OrderNode = Pick<SessionGraphNode, 'sessionId' | 'ccSessionId' | 'lastActivityAt'>
const node = (sessionId: string, lastActivityAt: number): OrderNode => ({
  sessionId,
  ccSessionId: `cc-${sessionId}`,
  lastActivityAt,
})
const ids = (ns: OrderNode[]) => ns.map((n) => n.sessionId)
const order = (
  ms: OrderNode[],
  need: Record<string, number>,
  pins: string[],
  frozen: string[] | null = null,
) => ids(orderTiles(ms as SessionGraphNode[], (id) => need[id] ?? 0, pins, frozen))

describe('orderTiles', () => {
  const a = node('a', 100)
  const b = node('b', 300)
  const c = node('c', 200)
  const d = node('d', 50)

  it('fixadas, depois precisa de você, depois atividade', () => {
    expect(order([a, b, c, d], { d: 1 }, [pinKey(a)])).toEqual(['a', 'd', 'b', 'c'])
  })

  it('fixadas na ordem em que foram fixadas, mesmo sem pedido', () => {
    expect(order([a, b, c, d], { b: 2 }, [pinKey(c), pinKey(a)])).toEqual(['c', 'a', 'b', 'd'])
  })

  it('o pin vale pelo ccSessionId: a mãe retomada (sessions.id novo) continua fixada', () => {
    const resumed = { ...d, sessionId: 'd-resumed' }
    expect(order([a, b, resumed], {}, [pinKey(d)])).toEqual(['d-resumed', 'b', 'a'])
  })

  it('pin de mãe que não está na lista não ocupa posição', () => {
    expect(order([a, b], {}, ['cc-sumiu', pinKey(a)])).toEqual(['a', 'b'])
  })

  it('congelada: needCount mudando não reordena; mãe nova entra no fim; a que sumiu sai', () => {
    const frozen = ['b', 'c', 'a']
    expect(order([a, b, c], { a: 3 }, [pinKey(a)], frozen)).toEqual(['b', 'c', 'a'])
    expect(order([a, b, c, d], { d: 1 }, [], frozen)).toEqual(['b', 'c', 'a', 'd'])
    expect(order([a, c], {}, [], frozen)).toEqual(['c', 'a'])
  })

  it('empate de atividade decide pelo id (ordem estável)', () => {
    expect(order([node('y', 1), node('x', 1)], {}, [])).toEqual(['x', 'y'])
  })
})
