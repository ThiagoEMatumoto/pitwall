/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import {
  PTY_IDLE_MS,
  derivePtyStatus,
  nextPtySample,
  tailSignature,
  visibleTail,
  type PtySample,
} from './pty-status'

// Simula o PtyManager: alimenta chunks num backlog e atualiza a amostra a cada um.
function feed(chunks: Array<{ at: number; data: string }>): PtySample {
  let backlog = ''
  let sample: PtySample = { lastByteAt: null, tailHash: null, hashChangedAt: null }
  for (const { at, data } of chunks) {
    backlog += data
    sample = nextPtySample(sample, backlog, at)
  }
  return sample
}

// Banner no formato do stub e2e (o Codex real desenha moldura parecida).
const BANNER = '\x1b[1m╭──────╮\x1b[0m\r\n│ >_ OpenAI Codex │\r\n╰──────╯\r\n\r\n› '

describe('visibleTail', () => {
  it('remove escapes ANSI e colapsa o \\r (redesenho na mesma linha)', () => {
    const raw = '\x1b[32mok\x1b[0m\r\n\x1b[2K\r⠋ Working\r⠙ Working\r⠹ Working'
    expect(visibleTail(raw)).toBe('ok\n⠹ Working')
  })

  it('fica só com as últimas linhas não vazias', () => {
    const raw = Array.from({ length: 40 }, (_, i) => `linha ${i}`).join('\n')
    const tail = visibleTail(raw).split('\n')
    expect(tail.at(-1)).toBe('linha 39')
    expect(tail.length).toBeLessThan(40)
  })
})

describe('tailSignature', () => {
  it('spinner que só troca um glifo dá a mesma assinatura', () => {
    expect(tailSignature('ok\n⠋ Thinking')).toBe(tailSignature('ok\n⠙ Thinking'))
    expect(tailSignature('ok\n◐ Thinking')).toBe(tailSignature('ok\n◓ Thinking'))
    expect(tailSignature('ok\n✶ Thinking')).toBe(tailSignature('ok\n✻ Thinking'))
  })

  it('texto novo muda a assinatura (inclusive o contador de segundos do working)', () => {
    expect(tailSignature('• Working (3s)')).not.toBe(tailSignature('• Working (4s)'))
    expect(tailSignature('a')).not.toBe(tailSignature('b'))
  })
})

describe('derivePtyStatus', () => {
  it('sem nenhum byte ainda é starting', () => {
    const sample: PtySample = { lastByteAt: null, tailHash: null, hashChangedAt: null }
    expect(derivePtyStatus(sample, 10_000)).toBe('starting')
  })

  it('tela estável por mais que a janela vira idle', () => {
    const sample = feed([{ at: 1_000, data: BANNER }])
    expect(derivePtyStatus(sample, 1_000 + PTY_IDLE_MS - 1)).toBe('working')
    expect(derivePtyStatus(sample, 1_000 + PTY_IDLE_MS)).toBe('idle')
  })

  it('spinner girando sozinho não conta como trabalho', () => {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    const chunks = [{ at: 0, data: `${BANNER}\r\n` }]
    for (let i = 0; i < 60; i++) {
      chunks.push({ at: 100 + i * 100, data: `\r\x1b[2K${frames[i % frames.length]} Thinking` })
    }
    const sample = feed(chunks)
    // Último frame em t=6000; a tela "mudou" de verdade só no 1º frame (t=100).
    expect(sample.lastByteAt).toBe(6_000)
    expect(derivePtyStatus(sample, 6_000)).toBe('idle')
  })

  it('saída contínua de texto novo segue working', () => {
    const chunks = [{ at: 0, data: BANNER }]
    for (let i = 1; i <= 30; i++) chunks.push({ at: i * 500, data: `\r\npassou ${i}` })
    const sample = feed(chunks)
    expect(derivePtyStatus(sample, 15_000 + PTY_IDLE_MS - 1)).toBe('working')
    expect(derivePtyStatus(sample, 15_000 + PTY_IDLE_MS)).toBe('idle')
  })

  it('o contador do working (que muda a cada segundo) mantém working', () => {
    const chunks = [{ at: 0, data: `${BANNER}\r\n` }]
    for (let s = 1; s <= 8; s++) {
      chunks.push({ at: s * 1_000, data: `\r\x1b[2K• Working (${s}s • esc to interrupt)` })
    }
    const sample = feed(chunks)
    expect(derivePtyStatus(sample, 8_500)).toBe('working')
  })
})

describe('nextPtySample — eco de input do app', () => {
  // O usuário digita no composer do Codex: o eco muda o tail, mas não é turno.
  it('eco da tecla (echo) atualiza o hash sem mover hashChangedAt', () => {
    const idle = feed([{ at: 0, data: BANNER }])
    const typed = nextPtySample(idle, BANNER + 'o', 5_000, { echo: true })
    expect(typed.tailHash).not.toBe(idle.tailHash)
    expect(typed.hashChangedAt).toBe(0)
    expect(derivePtyStatus(typed, 5_100)).toBe('idle')
  })

  it('a saída depois do eco volta a contar como trabalho', () => {
    const idle = feed([{ at: 0, data: BANNER }])
    const typed = nextPtySample(idle, BANNER + 'o', 5_000, { echo: true })
    const out = nextPtySample(typed, BANNER + 'o\r\nWorking (1s)', 5_600)
    expect(derivePtyStatus(out, 5_700)).toBe('working')
  })
})
