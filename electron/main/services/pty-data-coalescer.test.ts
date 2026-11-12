/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPtyDataCoalescer, PTY_DATA_WINDOW_MS } from './pty-data-coalescer'
import type { PtyDataEvent } from './pty-manager'

function setup() {
  const sent: PtyDataEvent[] = []
  const coalescer = createPtyDataCoalescer((e) => sent.push(e))
  const of = (sessionId: string) => sent.filter((e) => e.sessionId === sessionId).map((e) => e.data)
  return { sent, coalescer, of }
}

describe('createPtyDataCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('envia o chunk isolado de forma síncrona e fecha a janela vazia', () => {
    const { sent, coalescer } = setup()

    coalescer.push('a', 'x')
    expect(sent).toEqual([{ sessionId: 'a', data: 'x' }])

    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS)
    expect(vi.getTimerCount()).toBe(0)

    // Ociosa de novo: o próximo eco também não espera.
    coalescer.push('a', 'y')
    expect(sent).toEqual([
      { sessionId: 'a', data: 'x' },
      { sessionId: 'a', data: 'y' },
    ])
  })

  it('junta 100 chunks da mesma janela em 2 envios, sem perder nem reordenar bytes', () => {
    const { coalescer, of } = setup()
    // Sequência ANSI e par substituto cortados no meio de um chunk para o outro.
    const chunks = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0 ? `\x1b[3${i % 8}mlinha ${i} \ud83d` : `\ude80\x1b[0m\r\n`,
    )

    for (const chunk of chunks) coalescer.push('a', chunk)
    expect(of('a')).toEqual([chunks[0]])

    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS)
    expect(of('a')).toHaveLength(2)
    expect(of('a').join('')).toBe(chunks.join(''))
  })

  it('em streaming contínuo segura cada chunk por no máximo uma janela', () => {
    const { coalescer, of } = setup()
    const chunks = Array.from({ length: 80 }, (_, i) => `c${i};`)

    for (const chunk of chunks) {
      coalescer.push('a', chunk)
      const before = of('a').join('')
      vi.advanceTimersByTime(1)
      // Nada do que já saiu muda; só entra cauda nova.
      expect(of('a').join('').startsWith(before)).toBe(true)
    }
    expect(of('a').length).toBeLessThanOrEqual(1 + 80 / PTY_DATA_WINDOW_MS)

    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS)
    expect(of('a').join('')).toBe(chunks.join(''))

    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('mantém ordem e isolamento entre duas sessões intercaladas', () => {
    const { sent, coalescer, of } = setup()

    coalescer.push('a', 'a1')
    coalescer.push('b', 'b1')
    coalescer.push('a', 'a2')
    coalescer.push('b', 'b2')
    coalescer.push('a', 'a3')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS)

    expect(of('a')).toEqual(['a1', 'a2a3'])
    expect(of('b')).toEqual(['b1', 'b2'])
    expect(sent).toHaveLength(4)
  })

  it('flush envia o pendente na hora e ele não sai de novo no fim da janela', () => {
    const { coalescer, of } = setup()

    coalescer.push('a', 'a1')
    coalescer.push('a', 'a2')
    coalescer.push('b', 'b1')
    coalescer.push('b', 'b2')
    coalescer.flush('a')
    expect(of('a')).toEqual(['a1', 'a2'])
    expect(of('b')).toEqual(['b1'])

    coalescer.flush('a')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 3)
    expect(of('a')).toEqual(['a1', 'a2'])
    expect(of('b')).toEqual(['b1', 'b2'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flush de sessão sem nada pendente não envia', () => {
    const { sent, coalescer } = setup()
    coalescer.flush('nunca-vista')
    expect(sent).toEqual([])
  })

  it('drop descarta o pendente e não deixa timer', () => {
    const { coalescer, of } = setup()

    coalescer.push('a', 'a1')
    coalescer.push('a', 'a2')
    coalescer.drop('a')
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS * 3)
    expect(of('a')).toEqual(['a1'])
  })

  it('flush seguido de drop (saída da PTY) entrega a cauda e encerra a sessão', () => {
    const { coalescer, of } = setup()

    coalescer.push('a', 'a1')
    coalescer.push('a', 'cauda')
    coalescer.flush('a')
    coalescer.drop('a')

    expect(of('a')).toEqual(['a1', 'cauda'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('um envio que lança não trava a sessão: o chunk seguinte ainda sai', () => {
    const sent: string[] = []
    let failing = true
    const coalescer = createPtyDataCoalescer((e) => {
      if (failing) throw new Error('Object has been destroyed')
      sent.push(e.data)
    })

    expect(() => coalescer.push('a', 'perdido')).toThrow()
    coalescer.push('a', 'pendente')
    expect(() => vi.advanceTimersByTime(PTY_DATA_WINDOW_MS)).toThrow()

    failing = false
    coalescer.push('a', 'depois')
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS)
    expect(sent).toEqual(['depois'])
    vi.advanceTimersByTime(PTY_DATA_WINDOW_MS)
    expect(vi.getTimerCount()).toBe(0)
  })
})
