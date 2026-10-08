/** @vitest-environment node */
// Notas do bastão: o texto (puro) e a entrega às filhas pelo guarded-inject. A
// entrega à MÃE passa pela PromptQueue real em notify-mother-alias.queue.test.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Handoff } from '../../../../shared/types/ipc'

let handoff: Handoff | null = null
vi.mock('../handoff-store', () => ({ get: () => handoff }))

let running = new Set<string>()
vi.mock('../pty-manager', () => ({
  ptyManager: { isRunning: (id: string) => running.has(id) },
}))

const guarded: { sessionId: string; text: string }[] = []
let guardedError: Error | null = null
vi.mock('./guarded-inject', () => ({
  injectIntoChildGuarded: async (sessionId: string, text: string) => {
    if (guardedError) throw guardedError
    guarded.push({ sessionId, text })
  },
}))

const {
  buildAliasChangeNote,
  buildChildMotherNote,
  notifyChildrenOfNewMother,
} = await import('./notify-mother-alias')

const notice = { handoffId: 'h-1', alias: 'bruno-auth', previousAlias: 'mauricio-auth' }

beforeEach(() => {
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

describe('pulso no mapa das notas do bastão', () => {
  it('nota às filhas sai da nova mãe — só as entregues', async () => {
    const { onSessionLinkPulse } = await import('../session-link-pulse')
    const seen: string[] = []
    const off = onSessionLinkPulse((p) => seen.push(`${p.fromSessionId}>${p.toSessionId}:${p.kind}`))
    running = new Set(['k1', 'k2'])
    guardedError = null
    await notifyChildrenOfNewMother({
      handoffs: [
        { id: 'h-1', childSessionId: 'k1' },
        { id: 'h-2', childSessionId: 'k-morta' },
      ] as Handoff[],
      alias: 'ana-mc-v2',
      fromSessionId: 'nova-mae',
    })
    off()
    expect(seen).toEqual(['nova-mae>k1:note'])
  })
})
