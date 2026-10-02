import { describe, expect, it } from 'vitest'
import { reuseUnchanged } from './reuse-unchanged'

type N = {
  id: string
  position: { x: number; y: number }
  data: { title: string }
  selected?: boolean
  measured?: { width: number }
}

const n = (id: string, title = id, x = 0): N => ({ id, position: { x, y: 0 }, data: { title } })

describe('reuseUnchanged', () => {
  it('push do grafo sem mudança devolve o MESMO array (memo dos nós não re-renderiza)', () => {
    const prev = [{ ...n('a'), measured: { width: 10 } }, n('b')]
    const next = [n('a'), n('b')]
    expect(reuseUnchanged(next, prev)).toBe(prev)
  })

  it('só o nó que mudou vira objeto novo; os outros são os de antes', () => {
    const prev = [n('a'), n('b')]
    const out = reuseUnchanged([n('a'), n('b', 'novo')], prev)
    expect(out[0]).toBe(prev[0])
    expect(out[1]).not.toBe(prev[1])
    expect(out[1].data.title).toBe('novo')
  })

  it('nó sendo redimensionado não volta ao tamanho do layout no meio do gesto', () => {
    // O NodeResizer escreve width/height com resizing: true; um push (~300ms com
    // sessão trabalhando) traria a vaga do layout e o cartão pularia de volta.
    const prev = [{ ...n('a'), width: 560, height: 472, resizing: true }, n('b')]
    const next = [{ ...n('a', 'novo'), width: 400, height: 212 }, n('b')]
    const out = reuseUnchanged(next as typeof prev, prev)
    expect(out[0]).toBe(prev[0])
    const after = reuseUnchanged(next as typeof prev, [{ ...prev[0], resizing: false }, prev[1]])
    expect(after[0]).toMatchObject({ width: 400, height: 212 })
  })

  it('a seleção do React Flow sobrevive ao push', () => {
    const prev = [{ ...n('a'), selected: true }]
    expect(reuseUnchanged([n('a', 'x')], prev)[0]).toMatchObject({ selected: true })
    expect(reuseUnchanged([n('a')], prev)[0]).toBe(prev[0])
  })

  it('campo que sumiu do nó novo conta como mudança', () => {
    const prev = [{ ...n('a'), className: 'alerta' }]
    const out = reuseUnchanged([n('a')], prev as N[])
    expect(out[0]).not.toBe(prev[0])
    expect('className' in out[0]).toBe(false)
  })

  it('posição diferente (arrasto salvo) troca o nó; nó removido sai', () => {
    const prev = [n('a'), n('b')]
    const out = reuseUnchanged([n('a', 'a', 50)], prev)
    expect(out).toHaveLength(1)
    expect(out[0].position.x).toBe(50)
  })
})
