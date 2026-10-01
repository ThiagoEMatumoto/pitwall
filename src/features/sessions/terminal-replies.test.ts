import { describe, expect, it } from 'vitest'
import { stripQueryReplies } from './terminal-replies'

describe('stripQueryReplies', () => {
  it('descarta as respostas que o xterm gera a queries do backlog', () => {
    for (const reply of [
      '\x1b[?1;2c',
      '\x1b[>0;276;0c',
      '\x1b[0n',
      '\x1b[12;40R',
      '\x1b[?2004;1$y',
      '\x1b]11;rgb:1e1e/1e1e/1e1e\x07',
      '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
      '\x1bP>|xterm.js(5.5.0)\x1b\\',
    ]) {
      expect(stripQueryReplies(reply)).toBe('')
    }
  })

  // Regressão: o guard de replay descartava TODO o onData até o backlog terminar
  // de parsear — as primeiras teclas digitadas ao abrir a modal sumiam.
  it('deixa passar teclas, paste, setas e cliques de mouse', () => {
    for (const input of [
      'ls -la\r',
      '\x1b[200~texto colado\x1b[201~',
      '\x1b[A',
      '\x1b[1;5C',
      '\x1b[<0;10;5M',
      '\x7f',
      '\x1b',
      'c',
    ]) {
      expect(stripQueryReplies(input)).toBe(input)
    }
  })

  it('separa resposta e tecla que chegam no mesmo evento', () => {
    expect(stripQueryReplies('\x1b[?1;2ca')).toBe('a')
  })
})
