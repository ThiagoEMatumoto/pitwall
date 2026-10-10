/** @vitest-environment node */
// H3 com a PromptQueue REAL: o /exit passa pela mesma guarda do agent-bus (tela
// relida pelo espelho headless real, telas capturadas do claude 2.1.286). Fakes só
// na borda: status, escrita no PTY e o relógio.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture, scanOf } from '../test-support/screen-scans'
import { PromptQueue } from '../prompt-queue'
import { EXIT_TIMEOUT_MS, IdleHibernator, type IdleHibernatorDeps } from './idle-hibernator'
import type { LiveStatus, ScreenScan } from '../../../../shared/tui/attention-reason'
import type { PromptQueueSnapshot } from '../../../../shared/types/send-prompt'

const PTY = 'pty-1'
const CC = '74f13261-5b8e-4f43-9d0e-2c5a2b1f7c11'
const CANDIDATE = { sessionId: PTY, ccSessionId: CC }

type Screen = 'idle' | 'permission' | 'unparsed' | 'dirty'
const SCANS = {} as Record<Screen, ScreenScan>

beforeAll(async () => {
  SCANS.idle = await scanOf(fixture('claude-2.1.286-idle-prompt.ansi'))
  SCANS.permission = await scanOf(fixture('claude-2.1.286-permission-bash.ansi'))
  SCANS.unparsed = await scanOf(fixture('claude-2.1.286-trust-unnumbered.ansi'))
  SCANS.dirty = await scanOf(fixture('claude-2.1.286-input-dirty.ansi'))
})

function setup(opts: { screen?: Screen | null; status?: LiveStatus } = {}) {
  const state = {
    status: (opts.status ?? 'idle') as LiveStatus | null,
    scan: opts.screen === null ? null : SCANS[opts.screen ?? 'idle'],
    now: 1_000_000,
  }
  const writes: string[] = []
  const snapshots: PromptQueueSnapshot[] = []
  const queue = new PromptQueue({
    isRunning: () => true,
    status: () => state.status,
    screen: async () => state.scan,
    nativeStatus: () => true,
    handoffAsking: () => false,
    write: (id, text) => writes.push(`${id}:${text}`),
    emit: (s) => snapshots.push(s),
    warn: () => {},
    now: () => state.now,
  })
  const warnings: Array<Record<string, unknown>> = []
  const unused = (): never => {
    throw new Error('gate não faz parte do H3')
  }
  const deps: IdleHibernatorDeps = {
    lazyRestore: () => true,
    afterMin: () => 30,
    candidates: unused,
    hasPane: unused,
    lastIoAt: unused,
    sessionFile: unused,
    isPidAlive: unused,
    aliveSessionId: unused,
    activeHandoffCcSessionIds: unused,
    queueHas: unused,
    agentMessageSince: unused,
    transcriptPath: unused,
    usedScheduling: unused,
    procTree: unused,
    send: (input) => queue.send(input),
    cancel: (id) => {
      queue.cancel(id)
    },
    warn: (e) => warnings.push(e),
    now: () => state.now,
  }
  const hibernator = new IdleHibernator(deps)
  return { queue, hibernator, writes, snapshots, warnings, state }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('H3: guarda segura → cancela e não hiberna', () => {
  it.each([
    ['menu de permissão na tela (held menu-open)', { screen: 'permission' as const }],
    ['tela não reconhecida (held unparsed)', { screen: 'unparsed' as const }],
    ['rascunho do usuário na caixa (held input-dirty)', { screen: 'dirty' as const }],
    ['claude trabalhando (queued, espera o fim do turno)', { status: 'working' as const }],
  ])('%s', async (_name, opts) => {
    const { queue, hibernator, writes, snapshots } = setup(opts)
    expect(await hibernator.hibernate(CANDIDATE)).toBe(false)
    expect(writes).toEqual([])
    // O item saiu da fila como cancelado: nada fica para ser entregue depois.
    expect(queue.snapshot().items).toEqual([])
    expect(snapshots.at(-1)?.lastEvent).toMatchObject({ kind: 'cancelled', text: '/exit' })
    expect(hibernator.isHibernating(PTY)).toBe(false)
    expect(hibernator.getStats().refused['guard-held']).toBe(1)
    expect(hibernator.getStats().hibernated).toBe(0)
    // O fim do turno depois não ressuscita o /exit cancelado.
    queue.onTurnEnded(PTY)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(writes).toEqual([])
    expect(hibernator.onExit(PTY)).toBeNull()
    queue.dispose()
  })

  it('sem espelho da tela (refused no-screen) → nada enfileirado, guard-held', async () => {
    const { queue, hibernator, writes } = setup({ screen: null })
    expect(await hibernator.hibernate(CANDIDATE)).toBe(false)
    expect(writes).toEqual([])
    expect(queue.snapshot().items).toEqual([])
    expect(hibernator.getStats().refused['guard-held']).toBe(1)
    expect(hibernator.isHibernating(PTY)).toBe(false)
  })
})

describe('H3: entregue', () => {
  it('escreve só o /exit, espera o exit e conta hibernated', async () => {
    const { queue, hibernator, writes } = setup()
    expect(await hibernator.hibernate(CANDIDATE)).toBe(true)
    expect(writes).toEqual([`${PTY}:/exit`])
    expect(queue.snapshot().counters.delivered).toBe(1)
    expect(hibernator.isHibernating(PTY)).toBe(true)
    await vi.advanceTimersByTimeAsync(EXIT_TIMEOUT_MS - 1)
    expect(hibernator.onExit(PTY)).toEqual({ sessionId: PTY, ccSessionId: CC })
    expect(hibernator.getStats().hibernated).toBe(1)
    expect(hibernator.getStats().refused['exit-timeout']).toBe(0)
    expect(hibernator.isHibernating(PTY)).toBe(false)
    // O timer de 30s foi desarmado: não vira exit-timeout depois.
    await vi.advanceTimersByTimeAsync(EXIT_TIMEOUT_MS)
    expect(hibernator.getStats().refused['exit-timeout']).toBe(0)
  })

  it('sem exit em 30s → exit-timeout, desmarca, nunca kill nem Ctrl-U', async () => {
    const { hibernator, writes, warnings } = setup()
    expect(await hibernator.hibernate(CANDIDATE)).toBe(true)
    await vi.advanceTimersByTimeAsync(EXIT_TIMEOUT_MS - 1)
    expect(hibernator.isHibernating(PTY)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(hibernator.isHibernating(PTY)).toBe(false)
    expect(hibernator.getStats().refused['exit-timeout']).toBe(1)
    expect(hibernator.getStats().hibernated).toBe(0)
    expect(warnings).toContainEqual({ event: 'hibernate_exit_timeout', sessionId: PTY })
    // A única escrita foi o /exit: nem \x15 (Ctrl-U), nem \x03, nem limpeza de input.
    // O hibernador não tem dep de kill: a sessão segue viva.
    expect(writes).toEqual([`${PTY}:/exit`])
    // Um exit tardio (o usuário saiu à mão) não vira hibernada: a pane fecha normal.
    expect(hibernator.onExit(PTY)).toBeNull()
    expect(hibernator.getStats().hibernated).toBe(0)
  })
})
