import { afterEach, describe, expect, it } from 'vitest'
import { isTypingTarget, mapKeysOwnedElsewhere } from './typing-target'

function el(html: string, sel: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host.querySelector(sel)!
}

describe('isTypingTarget', () => {
  it('campos editáveis', () => {
    expect(isTypingTarget(el('<input />', 'input'))).toBe(true)
    expect(isTypingTarget(el('<textarea></textarea>', 'textarea'))).toBe(true)
    expect(isTypingTarget(el('<select></select>', 'select'))).toBe(true)
    expect(isTypingTarget(el('<div contenteditable="true"><span>x</span></div>', 'span'))).toBe(
      true,
    )
  })

  it('qualquer coisa dentro de um .xterm (o textarea auxiliar ou a tela)', () => {
    expect(
      isTypingTarget(
        el('<div class="xterm"><div class="xterm-screen"></div></div>', '.xterm-screen'),
      ),
    ).toBe(true)
  })

  it('o mapa e seus cartões não são alvo de digitação', () => {
    expect(
      isTypingTarget(el('<div class="react-flow__node"><button>b</button></div>', 'button')),
    ).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(window)).toBe(false)
  })
})

describe('mapKeysOwnedElsewhere', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('botão dentro do painel da feature não é do mapa', () => {
    const btn = el('<aside data-testid="feature-panel"><button>x</button></aside>', 'button')
    expect(mapKeysOwnedElsewhere(btn)).toBe(true)
  })

  it('com o menu de contexto aberto, nem o body é do mapa', () => {
    el('<div role="menu"><button role="menuitem">a</button></div>', 'div')
    expect(mapKeysOwnedElsewhere(document.body)).toBe(true)
  })

  it('cartão do mapa sem camada por cima é do mapa', () => {
    const card = el('<div class="react-flow__node"><button>c</button></div>', 'button')
    expect(mapKeysOwnedElsewhere(card)).toBe(false)
  })
})
