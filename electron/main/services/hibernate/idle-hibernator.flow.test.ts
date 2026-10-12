/** @vitest-environment node */
// H3 com a PromptQueue REAL: o /exit passa pela mesma guarda do agent-bus (tela
// relida pelo espelho headless real, telas capturadas do claude 2.1.286). Fakes só
// na borda: status, escrita no PTY e o relógio. A fila liga isHibernating e
// beforeWrite ao hibernador como o ipc/send-prompt.ts.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture, scanOf } from '../test-support/screen-scans'
import { PromptQueue } from '../prompt-queue'
import { DormantPanes } from '../dormant-panes'
import { EXIT_TIMEOUT_MS, IdleHibernator, type IdleHibernatorDeps } from './idle-hibernator'
import { hibernateExitRedirect } from './hibernate-redirect'
import type { LiveStatus, ScreenScan } from '../../../../shared/tui/attention-reason'
import type { PromptQueueSnapshot } from '../../../../shared/types/send-prompt'

const PTY = 'pty-1'
const CC = '74f13261-5b8e-4f43-9d0e-2c5a2b1f7c11'
const CANDIDATE = { sessionId: PTY, ccSessionId: CC }
const WOKEN = 'pty-woken'
const PANE = 'pane-1'

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
    running: new Set([PTY]),
    // input-dirty do espelho no instante do write (o eco chegou depois da releitura).
    inputDirtyNow: false,
    // Roda durante a releitura da tela da fila (o await do rescan).
    duringScreen: null as (() => void) | null,
  }
  const writes: string[] = []
  const snapshots: PromptQueueSnapshot[] = []
  const registered: Array<{ cc: string; paneId: string }> = []
  const wakeFailures: string[] = []
  // O registro real das dormant; a janela (renderer) responde ao wake com o id novo.
  const wakeRequests: string[] = []
  const panes = new DormantPanes({
    requestWake: (request) => {
      wakeRequests.push(request.ccSessionId)
      state.running.add(WOKEN)
      queueMicrotask(() => panes.onWakeResult({ requestId: request.requestId, sessionId: WOKEN }))
      return true
    },
    isRunning: (id) => state.running.has(id),
    screen: async () => state.scan,
    warn: () => {},
    readyPollMs: 1,
  })
  // Declarada antes da fila: o redirect lê o hibernador no exit.
  let hibernator: IdleHibernator | null = null
  const queue: PromptQueue = new PromptQueue({
    isRunning: (id) => state.running.has(id),
    redirectOnExit: (id) =>
      hibernateExitRedirect({
        wasHibernatedExit: (sid) => hibernator?.wasHibernatedExit(sid) ?? false,
        panes: () => panes,
        ccOf: (sid) => (sid === PTY ? CC : null),
        wakeFailed: (_sid, error) => wakeFailures.push(error),
      })(id),
    status: () => state.status,
    screen: async () => {
      const during = state.duringScreen
      state.duringScreen = null
      during?.()
      return state.scan
    },
    nativeStatus: () => true,
    handoffAsking: () => false,
    // A conversa da PTY velha e da acordada é a mesma (o índice vivo do main).
    liveCcOf: (id) => (id === PTY || id === WOKEN ? CC : null),
    write: (id, text, raw) => writes.push(`${id}:${raw ? 'raw:' : ''}${text}`),
    emit: (s) => snapshots.push(s),
    warn: () => {},
    now: () => state.now,
    isHibernating: (id) => hibernator?.isHibernating(id) ?? false,
    beforeWrite: (id, text) => hibernator?.beforeWrite(id, text, state.inputDirtyNow) ?? true,
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
    isHandoffChild: unused,
    queueHas: unused,
    agentMessageSince: unused,
    transcriptPath: unused,
    scanTranscript: unused,
    procTree: unused,
    confirmPane: unused,
    registerDormant: (cc, paneId) => {
      registered.push({ cc, paneId })
      panes.add({ ccSessionId: cc, paneId, title: null, repoId: null })
    },
    persistHibernating: () => {},
    send: (input) => queue.send(input),
    cancel: (id) => {
      queue.cancel(id)
    },
    replaceText: (id, text) => queue.replaceText(id, text),
    warn: (e) => warnings.push(e),
    now: () => state.now,
  }
  hibernator = new IdleHibernator(deps)
  // O exit da PTY chega aos dois ouvintes, na ordem do main (sessions antes da fila).
  const exit = () => {
    state.running.delete(PTY)
    const event = hibernator!.onExit(PTY)
    queue.onSessionExit(PTY)
    return event
  }
  return {
    queue,
    hibernator,
    writes,
    snapshots,
    warnings,
    state,
    exit,
    registered,
    wakeRequests,
    wakeFailures,
  }
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
    expect(hibernator.onExit(PTY)).toEqual({ sessionId: PTY, ccSessionId: CC, paneId: null })
    expect(hibernator.getStats().hibernated).toBe(1)
    expect(hibernator.getStats().refused['exit-timeout']).toBe(0)
    expect(hibernator.isHibernating(PTY)).toBe(false)
    // O timer do exit-timeout foi desarmado: não vira exit-timeout depois.
    await vi.advanceTimersByTimeAsync(EXIT_TIMEOUT_MS)
    expect(hibernator.getStats().refused['exit-timeout']).toBe(0)
  })

  it('sem exit em EXIT_TIMEOUT_MS → exit-timeout e o marcador cai; nunca kill nem Ctrl-U', async () => {
    const { hibernator, writes, warnings } = setup()
    expect(await hibernator.hibernate(CANDIDATE)).toBe(true)
    await vi.advanceTimersByTimeAsync(EXIT_TIMEOUT_MS)
    expect(hibernator.getStats().refused['exit-timeout']).toBe(1)
    expect(hibernator.getStats().hibernated).toBe(0)
    expect(warnings).toContainEqual({ event: 'hibernate_exit_timeout', sessionId: PTY })
    expect(hibernator.isHibernating(PTY)).toBe(false)
    expect(hibernator.wasHibernatedExit(PTY)).toBe(false)
    // A única escrita foi o /exit: nem \x15 (Ctrl-U), nem \x03, nem limpeza de input.
    // O hibernador não tem dep de kill: a sessão segue viva.
    expect(writes).toEqual([`${PTY}:/exit`])
  })

  it('hook SessionEnd de 60s: o exit que chega aos 60s ainda é hibernação', async () => {
    const { hibernator } = setup()
    expect(await hibernator.hibernate(CANDIDATE)).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hibernator.onExit(PTY)).toEqual({ sessionId: PTY, ccSessionId: CC, paneId: null })
    expect(hibernator.getStats().hibernated).toBe(1)
    expect(hibernator.getStats().refused['exit-timeout']).toBe(0)
  })

  it('claude lento: exit depois do exit-timeout → exit comum', async () => {
    const { hibernator, exit, registered } = setup()
    expect(await hibernator.hibernate(CANDIDATE, PANE)).toBe(true)
    await vi.advanceTimersByTimeAsync(EXIT_TIMEOUT_MS + 15_000)
    expect(hibernator.getStats().refused['exit-timeout']).toBe(1)
    expect(exit()).toBeNull()
    expect(hibernator.getStats().hibernated).toBe(0)
    expect(registered).toEqual([])
  })

  it('aba fechada pelo X com o /exit em curso → exit comum, sem dormant', async () => {
    const { hibernator, exit, registered, warnings } = setup()
    expect(await hibernator.hibernate(CANDIDATE, PANE)).toBe(true)
    hibernator.onPaneClosed(PTY)
    expect(warnings).toContainEqual({ event: 'hibernate_cancelled_by_close', sessionId: PTY })
    expect(exit()).toBeNull()
    expect(hibernator.getStats().hibernated).toBe(0)
    expect(registered).toEqual([])
  })

  it('input depois do exit-timeout vai direto ao PTY (a sessão está viva)', async () => {
    const { hibernator, exit } = setup()
    expect(await hibernator.hibernate(CANDIDATE, PANE)).toBe(true)
    await vi.advanceTimersByTimeAsync(EXIT_TIMEOUT_MS + 10_000)
    expect(hibernator.onUserInput(PTY, 'oi\r')).toBe(false)
    expect(exit()).toBeNull()
    expect(hibernator.getStats().hibernated).toBe(0)
  })
})

describe('input do app depois do /exit entregue (sessions:write)', () => {
  it('não chega ao PTY que sai; a sessão hiberna e o texto chega cru na acordada', async () => {
    const { queue, hibernator, writes, exit, registered, wakeRequests } = setup()
    expect(await hibernator.hibernate(CANDIDATE, PANE)).toBe(true)
    // Foco/relatórios do terminal não são o usuário: passam e o marcador fica.
    expect(hibernator.onUserInput(PTY, '\x1b[I')).toBe(false)
    expect(hibernator.onUserInput(PTY, '\x1b[O\x1b[12;40R')).toBe(false)
    // O envio do Composer: bracketed-paste do texto, depois o \r que submete.
    const composer = '\x1b[200~revisa o PR\x1b[201~'
    expect(hibernator.onUserInput(PTY, composer)).toBe(true)
    expect(hibernator.onUserInput(PTY, '\r')).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(hibernator.isHibernating(PTY)).toBe(true)
    expect(writes).toEqual([`${PTY}:/exit`])
    // Um item só, com o texto acumulado.
    expect(queue.snapshot().items.map((i) => i.text)).toEqual([`${composer}\r`])

    expect(exit()).toEqual({ sessionId: PTY, ccSessionId: CC, paneId: PANE })
    expect(hibernator.getStats().hibernated).toBe(1)
    expect(registered).toEqual([{ cc: CC, paneId: PANE }])
    await vi.advanceTimersByTimeAsync(100)
    expect(wakeRequests).toEqual([CC])
    expect(writes).toEqual([`${PTY}:/exit`, `${WOKEN}:raw:${composer}\r`])
    expect(queue.snapshot().counters.sessionGone).toBe(0)
    queue.dispose()
  })

  it('write que chega enquanto o item segurado ainda está sendo criado entra no mesmo item', async () => {
    const { queue, hibernator, writes, exit } = setup()
    expect(await hibernator.hibernate(CANDIDATE, PANE)).toBe(true)
    // Os dois na mesma volta do event loop: o send do primeiro ainda relê a tela.
    hibernator.onUserInput(PTY, 'a')
    hibernator.onUserInput(PTY, 'b')
    await vi.advanceTimersByTimeAsync(0)
    hibernator.onUserInput(PTY, 'c')
    expect(queue.snapshot().items.map((i) => i.text)).toEqual(['abc'])
    exit()
    await vi.advanceTimersByTimeAsync(100)
    expect(writes).toEqual([`${PTY}:/exit`, `${WOKEN}:raw:abc`])
    queue.dispose()
  })

  it('exit-timeout com input segurado → o texto é entregue na própria sessão viva', async () => {
    const { queue, hibernator, writes, state } = setup()
    expect(await hibernator.hibernate(CANDIDATE, PANE)).toBe(true)
    hibernator.onUserInput(PTY, 'oi\r')
    await vi.advanceTimersByTimeAsync(EXIT_TIMEOUT_MS)
    expect(hibernator.isHibernating(PTY)).toBe(false)
    // O poll da fila acha a sessão ociosa (o fim de turno do /exit nunca veio).
    state.now += EXIT_TIMEOUT_MS
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes).toEqual([`${PTY}:/exit`, `${PTY}:raw:oi\r`])
    queue.dispose()
  })
})

describe('corrida entre tecla e /exit', () => {
  it('tecla digitada durante a releitura da tela → aborta o /exit, guard-held', async () => {
    const { queue, hibernator, writes, state, warnings } = setup()
    // O eco ainda não voltou: a tela relida mostra a caixa limpa.
    state.duringScreen = () => {
      expect(hibernator.onUserInput(PTY, 'a')).toBe(false)
    }
    expect(await hibernator.hibernate(CANDIDATE, PANE)).toBe(false)
    expect(writes).toEqual([])
    expect(queue.snapshot().items).toEqual([])
    expect(hibernator.getStats().refused['guard-held']).toBe(1)
    expect(hibernator.isHibernating(PTY)).toBe(false)
    expect(warnings).toContainEqual({ event: 'hibernate_exit_aborted_by_input', sessionId: PTY })
    expect(hibernator.onExit(PTY)).toBeNull()
  })

  it('o espelho mostra input-dirty no instante do write → aborta o /exit', async () => {
    const { hibernator, writes, state } = setup()
    state.duringScreen = () => {
      state.inputDirtyNow = true
    }
    expect(await hibernator.hibernate(CANDIDATE, PANE)).toBe(false)
    expect(writes).toEqual([])
    expect(hibernator.getStats().refused['guard-held']).toBe(1)
  })
})

describe('mensagem que chega com o /exit em voo', () => {
  it.each([
    ['claude saindo (working)', 'working' as const, 'on-idle' as const],
    // O arquivo de status ainda diz idle: sem isHibernating a fila entregaria.
    ['status ainda idle', 'idle' as const, 'on-idle' as const],
    ['"enviar agora"', 'idle' as const, 'now' as const],
  ])('agent_ask entre a entrega e a saída (%s) → reentregue na acordada', async (_n, st, when) => {
    const { queue, hibernator, writes, snapshots, state, exit, wakeRequests, wakeFailures } =
      setup()
    expect(await hibernator.hibernate(CANDIDATE, PANE)).toBe(true)
    state.status = st
    const sent = await queue.send({ sessionId: PTY, text: 'pergunta do agente', when })
    expect(sent).toMatchObject({ ok: true, delivered: false })
    expect(writes).toEqual([`${PTY}:/exit`])
    const queuedId = sent.ok && !sent.delivered ? sent.queued.id : ''
    expect(exit()).toMatchObject({ sessionId: PTY, ccSessionId: CC })
    // A sessão acordada fica ociosa: a fila entrega o MESMO item nela.
    state.status = 'idle'
    await vi.advanceTimersByTimeAsync(100)
    expect(wakeRequests).toEqual([CC])
    expect(wakeFailures).toEqual([])
    expect(writes).toEqual([`${PTY}:/exit`, `${WOKEN}:pergunta do agente`])
    const kinds = snapshots.map((s) => s.lastEvent?.kind)
    expect(kinds).not.toContain('session-gone')
    expect(snapshots.at(-1)?.lastEvent).toMatchObject({
      kind: 'delivered',
      id: queuedId,
      sessionId: WOKEN,
    })
    expect(queue.snapshot().counters.sessionGone).toBe(0)
    queue.dispose()
  })

  it('exit comum (não hibernado) com item na fila → espera a conversa voltar, sem wake', async () => {
    const { queue, state, exit, writes, wakeRequests } = setup()
    state.status = 'working'
    await queue.send({ sessionId: PTY, text: 'pergunta', when: 'on-idle' })
    expect(exit()).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(wakeRequests).toEqual([])
    expect(queue.snapshot().counters.sessionGone).toBe(0)
    expect(queue.snapshot().items).toEqual([
      expect.objectContaining({ text: 'pergunta', recovery: 'awaiting-session' }),
    ])
    expect(writes).toEqual([])

    // A conversa volta (resume) numa PTY nova: o item sai uma vez só, nela.
    state.running.add(WOKEN)
    state.status = 'idle'
    queue.onSessionLive(WOKEN)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes).toEqual([`${WOKEN}:pergunta`])
    expect(wakeRequests).toEqual([])
    queue.dispose()
  })
})
