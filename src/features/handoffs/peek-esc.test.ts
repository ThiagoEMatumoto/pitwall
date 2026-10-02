import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => ({ sessionsApi: {}, handoffsApi: {}, agentBusApi: {} }))
const { escBelongsToUpperLayer } = await import('./CrewPeek')

afterEach(() => {
  document.body.innerHTML = ''
})

describe('escBelongsToUpperLayer — de quem é o Esc com a modal aberta', () => {
  it('campo da paleta por cima da modal: o Esc é da paleta', () => {
    document.body.innerHTML = '<div id="peek"><textarea id="mine"></textarea></div><input id="palette" />'
    const peek = document.getElementById('peek')!
    expect(escBelongsToUpperLayer(peek, document.getElementById('palette'))).toBe(true)
  })
  it('foco dentro da modal (xterm, compositor) ou no body: o Esc é da modal', () => {
    document.body.innerHTML = '<div id="peek"><textarea id="mine"></textarea></div>'
    const peek = document.getElementById('peek')!
    expect(escBelongsToUpperLayer(peek, document.getElementById('mine'))).toBe(false)
    expect(escBelongsToUpperLayer(peek, document.body)).toBe(false)
  })
})

describe('dicas da modal do terminal', () => {
  it('escritas por extenso, numa linha', async () => {
    const { escHintFor, LIFT_SWITCH_HINT } = await import('./CrewPeek')
    expect(escHintFor(false)).toBe('Esc vai à sessão · Shift+Esc fecha')
    expect(escHintFor(true)).toBe('Esc vai à filha · Shift+Esc fecha')
    expect(LIFT_SWITCH_HINT).toBe('Alt+, / Alt+. trocar')
  })
})
