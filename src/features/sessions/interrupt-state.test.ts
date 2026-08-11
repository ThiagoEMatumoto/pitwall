import { describe, expect, it } from 'vitest'
import {
  interruptEnabled,
  interruptLabel,
  interruptState,
  interruptTitle,
  type InterruptState,
} from './interrupt-state'

describe('interruptState', () => {
  it("'working' arma o botão (há o que interromper agora)", () => {
    expect(interruptState({ status: 'working', sent: false })).toBe('armed')
  })

  it("'idle' e 'ended' desabilitam — nada em andamento", () => {
    expect(interruptState({ status: 'idle', sent: false })).toBe('idle')
    expect(interruptState({ status: 'ended', sent: false })).toBe('idle')
  })

  it('estado incerto continua clicável (fail-open: cancelar é emergência)', () => {
    expect(interruptState({ status: 'waiting', sent: false })).toBe('available')
    expect(interruptState({ status: 'starting', sent: false })).toBe('available')
    expect(interruptState({ status: undefined, sent: false })).toBe('available')
  })

  it('sent vence qualquer status — o feedback do clique não pode ser engolido', () => {
    expect(interruptState({ status: 'working', sent: true })).toBe('sent')
    expect(interruptState({ status: 'idle', sent: true })).toBe('sent')
  })
})

describe('interruptEnabled / rótulos', () => {
  it('só armed e available são clicáveis', () => {
    expect(interruptEnabled('armed')).toBe(true)
    expect(interruptEnabled('available')).toBe(true)
    expect(interruptEnabled('idle')).toBe(false)
    expect(interruptEnabled('sent')).toBe(false)
  })

  it('o rótulo muda apenas no estado sent', () => {
    expect(interruptLabel('armed')).toBe('Interromper')
    expect(interruptLabel('available')).toBe('Interromper')
    expect(interruptLabel('idle')).toBe('Interromper')
    expect(interruptLabel('sent')).toBe('Interrompendo…')
  })

  it('todo estado tem um title próprio (nenhum cai em vazio)', () => {
    const states: InterruptState[] = ['armed', 'available', 'idle', 'sent']
    const titles = states.map(interruptTitle)
    expect(titles.every((t) => t.length > 0)).toBe(true)
    expect(new Set(titles).size).toBe(states.length)
  })
})
