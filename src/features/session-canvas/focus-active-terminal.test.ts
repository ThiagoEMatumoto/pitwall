// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { focusActiveTerminal } from './focus-active-terminal'

function panel(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

describe('focusActiveTerminal', () => {
  it('foca o textarea do xterm do painel ativo', () => {
    const el = panel('<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>')
    expect(focusActiveTerminal(el)).toBe(true)
    expect(document.activeElement).toBe(el.querySelector('textarea'))
  })

  it('não rouba o foco do xterm escondido sob o chat', () => {
    const el = panel(
      '<div class="invisible"><textarea class="xterm-helper-textarea"></textarea></div>',
    )
    expect(focusActiveTerminal(el)).toBe(false)
  })

  it('sem painel ativo não faz nada', () => {
    expect(focusActiveTerminal(null)).toBe(false)
  })
})
