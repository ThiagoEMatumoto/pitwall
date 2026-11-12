import { describe, expect, it } from 'vitest'
import { formatRelative, sameActivity, shortenAgentName, statusDotView } from './status-view'
import type { SessionActivity } from '../../../shared/types/ipc'

describe('statusDotView', () => {
  it('working → accent label with pulse', () => {
    expect(statusDotView('working')).toEqual({
      label: 'Trabalhando',
      className: 'text-[var(--color-accent)]',
      pulse: true,
    })
  })

  it('waiting → warning label', () => {
    expect(statusDotView('waiting')).toEqual({
      label: 'Aguardando você',
      className: 'text-[var(--color-warning)]',
    })
  })

  it('idle/starting/ended → dim label', () => {
    expect(statusDotView('idle').label).toBe('Ocioso')
    expect(statusDotView('starting')).toMatchObject({ label: 'Iniciando', pulse: true })
    expect(statusDotView('ended').label).toBe('Encerrada')
    for (const s of ['idle', 'starting', 'ended'] as const) {
      expect(statusDotView(s).className).toBe('text-[var(--color-text-dim)]')
    }
  })

  it('undefined → generic Running (success)', () => {
    expect(statusDotView(undefined)).toEqual({
      label: 'Running',
      className: 'text-[var(--color-success)]',
    })
  })
})

describe('formatRelative', () => {
  it('seconds under a minute', () => {
    expect(formatRelative(5_000)).toBe('há 5s')
    expect(formatRelative(0)).toBe('há 0s')
    expect(formatRelative(-2_000)).toBe('há 0s')
  })

  it('minutes under an hour', () => {
    expect(formatRelative(90_000)).toBe('há 2min')
    expect(formatRelative(60_000)).toBe('há 1min')
  })

  it('hours beyond that', () => {
    expect(formatRelative(3 * 3600_000)).toBe('há 3h')
  })
})

describe('shortenAgentName', () => {
  it('strips plugin prefix', () => {
    expect(shortenAgentName('kaizen-workflow:kz-implementer')).toBe('kz-implementer')
  })

  it('keeps plain names', () => {
    expect(shortenAgentName('Explore')).toBe('Explore')
    expect(shortenAgentName('general-purpose')).toBe('general-purpose')
  })

  it('falls back to the full name when the suffix is empty', () => {
    expect(shortenAgentName('weird:')).toBe('weird:')
  })
})

// Os nove campos que o produtor escreve (emitFor em session-activity.ts).
const ACTIVITY: SessionActivity = {
  ccSessionId: 'cc-1',
  status: 'working',
  name: 'mae',
  title: 'Destravar a interface',
  lastText: 'lendo o arquivo',
  lastActivityAt: 1_000,
  tokens: { output: 10, context: 200 },
  model: 'claude-opus-4-7',
  subagents: [{ name: 'Explore', description: 'mapeia o chat', state: 'running' }],
}

describe('sameActivity', () => {
  it('a new object with the same content is the same activity', () => {
    const copy: SessionActivity = {
      ...ACTIVITY,
      tokens: { ...ACTIVITY.tokens! },
      subagents: ACTIVITY.subagents!.map((s) => ({ ...s })),
    }
    expect(sameActivity(ACTIVITY, copy)).toBe(true)
  })

  it.each<[string, Partial<SessionActivity>]>([
    ['ccSessionId', { ccSessionId: 'cc-2' }],
    ['status', { status: 'idle' }],
    ['name', { name: null }],
    ['title', { title: 'outro' }],
    ['lastText', { lastText: 'rodando os testes' }],
    ['lastActivityAt', { lastActivityAt: 2_000 }],
    ['tokens.output', { tokens: { output: 11, context: 200 } }],
    ['tokens.context', { tokens: { output: 10, context: 201 } }],
    ['tokens missing', { tokens: undefined }],
    ['model', { model: 'claude-haiku-4-5' }],
    ['subagents missing', { subagents: undefined }],
    ['subagent added', { subagents: [...ACTIVITY.subagents!, ...ACTIVITY.subagents!] }],
    ['subagent name', { subagents: [{ ...ACTIVITY.subagents![0], name: 'Plan' }] }],
    ['subagent description', { subagents: [{ ...ACTIVITY.subagents![0], description: 'x' }] }],
    ['subagent state', { subagents: [{ ...ACTIVITY.subagents![0], state: 'ok' }] }],
  ])('a different %s is a different activity', (_field, change) => {
    expect(sameActivity(ACTIVITY, { ...ACTIVITY, ...change })).toBe(false)
  })
})
