/** @vitest-environment node */
// Aviso automático à mãe quando o bastão troca o endereço da filha. O que se
// trava aqui: (a) a nota chega no PTY da MÃE (não da filha) e nomeia os dois
// endereços; (b) mãe ausente/encerrada degrada em SILÊNCIO — é notificação, não
// parte do bastão, que já deu certo.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Handoff } from '../../../../shared/types/ipc'

let handoff: Handoff | null = null
vi.mock('../handoff-store', () => ({ get: () => handoff }))

let running = new Set<string>()
vi.mock('../pty-manager', () => ({
  ptyManager: { isRunning: (id: string) => running.has(id) },
}))

const injected: { sessionId: string; text: string }[] = []
let injectError: Error | null = null
vi.mock('./inject', () => ({
  injectIntoSession: (sessionId: string, text: string) => {
    if (injectError) throw injectError
    injected.push({ sessionId, text })
  },
}))

const { buildAliasChangeNote, notifyMotherOfAliasChange } = await import('./notify-mother-alias')

const notice = { handoffId: 'h-1', alias: 'bruno-auth', previousAlias: 'mauricio-auth' }

beforeEach(() => {
  injected.length = 0
  injectError = null
  running = new Set(['sess-mae'])
  handoff = { id: 'h-1', motherSessionId: 'sess-mae', childSessionId: 'sess-nova' } as Handoff
})

describe('buildAliasChangeNote', () => {
  it('nomeia o endereço velho, o novo e o handoff', () => {
    const note = buildAliasChangeNote(notice)
    expect(note).toContain('mauricio-auth')
    expect(note).toContain('bruno-auth')
    expect(note).toContain('h-1')
    expect(note).toContain('SendMessage')
  })

  it('avisa que mandar pro apelido velho NÃO dá erro (é isso que engana a mãe)', () => {
    expect(buildAliasChangeNote(notice)).toMatch(/não dá erro|NÃO dá erro/i)
  })

  it('sem apelido anterior, ainda diz qual é o endereço válido', () => {
    const note = buildAliasChangeNote({ handoffId: 'h-1', alias: 'bruno-auth' })
    expect(note).toContain('bruno-auth')
  })
})

describe('notifyMotherOfAliasChange', () => {
  it('escreve a nota no PTY da MÃE', () => {
    const res = notifyMotherOfAliasChange(notice)
    expect(res.delivered).toBe(true)
    expect(injected).toHaveLength(1)
    expect(injected[0]!.sessionId).toBe('sess-mae')
    expect(injected[0]!.text).toContain('bruno-auth')
  })

  it('mãe não viva: não entrega e NÃO é erro', () => {
    running = new Set()
    expect(notifyMotherOfAliasChange(notice)).toEqual({
      delivered: false,
      reason: 'mother-not-running',
    })
    expect(injected).toHaveLength(0)
  })

  it('handoff sem mãe (filha criada na mão sem orquestrador): silêncio', () => {
    handoff = { id: 'h-1', motherSessionId: null } as Handoff
    expect(notifyMotherOfAliasChange(notice).delivered).toBe(false)
  })

  it('handoff inexistente: silêncio', () => {
    handoff = null
    expect(notifyMotherOfAliasChange(notice).delivered).toBe(false)
  })

  it('PTY que morre entre o isRunning e o write não vira exceção', () => {
    injectError = new Error('session not running')
    expect(notifyMotherOfAliasChange(notice)).toEqual({
      delivered: false,
      reason: 'inject-failed',
    })
  })
})
