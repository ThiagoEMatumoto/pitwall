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
const guarded: { sessionId: string; text: string }[] = []
let guardedError: Error | null = null
vi.mock('./guarded-inject', () => ({
  injectIntoChildGuarded: async (sessionId: string, text: string) => {
    if (guardedError) throw guardedError
    guarded.push({ sessionId, text })
  },
}))

vi.mock('./inject', () => ({
  injectIntoSession: (sessionId: string, text: string) => {
    if (injectError) throw injectError
    injected.push({ sessionId, text })
  },
}))

const {
  buildAliasChangeNote,
  buildChildMotherNote,
  notifyChildrenOfNewMother,
  notifyMotherOfAliasChange,
} = await import('./notify-mother-alias')

const notice = { handoffId: 'h-1', alias: 'bruno-auth', previousAlias: 'mauricio-auth' }

beforeEach(() => {
  injected.length = 0
  injectError = null
  guarded.length = 0
  guardedError = null
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

describe('buildChildMotherNote', () => {
  const note = buildChildMotherNote({
    handoffId: 'h-9',
    alias: 'ana-mc-v2',
    previousAlias: 'mae-mc-v2',
  })

  it('cita o endereço antigo, o novo e o handoff', () => {
    expect(note).toContain('[Pitwall]')
    expect(note).toContain('"ana-mc-v2"')
    expect(note).toContain('"mae-mc-v2"')
    expect(note).toContain('h-9')
    expect(note).toContain('SendMessage({ to: "ana-mc-v2" })')
  })

  it('é puro: mesma entrada, mesma saída', () => {
    expect(
      buildChildMotherNote({ handoffId: 'h-9', alias: 'ana-mc-v2', previousAlias: 'mae-mc-v2' }),
    ).toBe(note)
  })

  // Regressão: a nota mandava reportar por SendMessage já, mas sai antes de a
  // sucessora subir — a resposta imediata da filha não tinha a quem chegar.
  it('manda esperar a primeira mensagem da nova mãe e usar as tools do handoff até lá', () => {
    expect(note).toContain('espere essa mensagem e só então use SendMessage')
    expect(note).toContain('até lá, reporte por handoff_progress')
    expect(note).not.toContain('daqui pra frente')
  })

  it('sem endereço antigo ainda diz o novo', () => {
    const n = buildChildMotherNote({ handoffId: 'h-9', alias: 'ana-mc-v2' })
    expect(n).toContain('"ana-mc-v2"')
    expect(n).not.toContain('antes')
  })
})

describe('notifyChildrenOfNewMother', () => {
  const kids = [
    { id: 'h-1', childSessionId: 'c1' },
    { id: 'h-2', childSessionId: 'c2' },
    { id: 'h-3', childSessionId: null },
  ] as Handoff[]

  it('entrega pelo guarded-inject só às filhas vivas', async () => {
    running = new Set(['c1'])
    const res = await notifyChildrenOfNewMother({
      handoffs: kids,
      alias: 'ana-mc-v2',
      previousAlias: 'mae-mc-v2',
    })
    expect(guarded.map((g) => g.sessionId)).toEqual(['c1'])
    expect(guarded[0]!.text).toContain('ana-mc-v2')
    expect(guarded[0]!.text).toContain('h-1')
    expect(injected).toHaveLength(0)
    expect(res).toEqual([
      { handoffId: 'h-1', delivered: true },
      { handoffId: 'h-2', delivered: false, reason: 'child-not-running' },
      { handoffId: 'h-3', delivered: false, reason: 'no-child' },
    ])
  })

  it('recusa do guard (menu aberto) não vira exceção', async () => {
    running = new Set(['c1', 'c2'])
    guardedError = new Error('menu-open')
    const res = await notifyChildrenOfNewMother({ handoffs: kids.slice(0, 2), alias: 'ana' })
    expect(res.every((r) => !r.delivered && r.reason === 'inject-refused')).toBe(true)
  })
})
