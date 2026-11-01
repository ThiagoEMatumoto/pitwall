import { describe, expect, it } from 'vitest'
import { isTailChrome, stripTailChrome } from './tail-chrome'

describe('isTailChrome', () => {
  it('réguas, separador do menu e prompt vazio são moldura', () => {
    for (const l of ['────────', '  ╌╌╌╌  ', '╭──╮', '›', ' ❯ ', '>'])
      expect(isTailChrome(l)).toBe(true)
  })
  it('régua de sessão nomeada (claude 2.1.295) é moldura', () => {
    expect(isTailChrome(`${'─'.repeat(28)} kzprobe-b-7731 ─`)).toBe(true)
  })
  it('texto com régua no meio ou prompt com conteúdo é conteúdo', () => {
    for (const l of ['── Resumo ──', '❯ Try "fix it"', '› ok', '- item'])
      expect(isTailChrome(l)).toBe(false)
  })
})

describe('stripTailChrome', () => {
  it('junta brancos seguidos e apara as pontas', () => {
    const lines = ['', 'a', '', '', '────', '', 'b', '', '']
    expect(stripTailChrome(lines, (l) => l, '')).toEqual(['a', '', 'b'])
  })
})
