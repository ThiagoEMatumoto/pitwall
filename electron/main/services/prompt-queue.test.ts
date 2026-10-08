import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture, scanOf } from './test-support/screen-scans'
import {
  AWAIT_WORK_MS,
  POLL_MS,
  PROMPT_TTL_MS,
  PromptQueue,
  SETTLE_MS,
  type PromptQueueDeps,
} from './prompt-queue'
import type { LiveStatus, ScreenScan } from '../../../shared/tui/attention-reason'
import type { PromptQueueSnapshot } from '../../../shared/types/send-prompt'

const PERMISSION = fixture('claude-2.1.286-permission-bash.ansi')
const IDLE_PROMPT = fixture('claude-2.1.286-idle-prompt.ansi')
// Menu real que o parser NÃO reconhece (trust sem numeração): sem menu e sem a
// caixa de input — o caso de drift da CLI em que o \r responderia às cegas.
const UNPARSED = fixture('claude-2.1.286-trust-unnumbered.ansi')
// Caixa de input vazia (placeholder esmaecido) × com rascunho digitado sem Enter:
// o texto puro das duas é "❯ <algo>"; só o atributo dim das células separa.
const PLACEHOLDER = fixture('claude-2.1.286-input-placeholder.ansi')
const DIRTY = fixture('claude-2.1.286-input-dirty.ansi')
const SID = 's1'

const SCANS: Record<'permission' | 'idle' | 'unparsed' | 'placeholder' | 'dirty', ScreenScan> =
  {} as never

beforeAll(async () => {
  SCANS.permission = await scanOf(PERMISSION)
  SCANS.idle = await scanOf(IDLE_PROMPT)
  SCANS.unparsed = await scanOf(UNPARSED)
  SCANS.placeholder = await scanOf(PLACEHOLDER)
  SCANS.dirty = await scanOf(DIRTY)
})

type Screen = keyof typeof SCANS

function setup(opts: { screen?: Screen; status?: LiveStatus; mirrored?: boolean } = {}) {
  const state = {
    status: (opts.status ?? 'idle') as LiveStatus | null,
    scan: opts.mirrored === false ? null : SCANS[opts.screen ?? 'idle'],
    running: true,
    asking: false,
    native: true,
    onScan: null as null | (() => void),
  }
  const writes: string[] = []
  const deliveries: Array<[string, string | undefined]> = []
  const snapshots: PromptQueueSnapshot[] = []
  const deps: PromptQueueDeps = {
    isRunning: () => state.running,
    status: () => state.status,
    screen: async () => {
      state.onScan?.()
      return state.scan
    },
    nativeStatus: () => state.native,
    handoffAsking: () => state.asking,
    write: (id, text) => writes.push(`${id}:${text}`),
    delivered: (id, from) => deliveries.push([id, from]),
    emit: (s) => snapshots.push(s),
    warn: () => {},
  }
  const queue = new PromptQueue(deps)
  const show = (screen: Screen) => {
    state.scan = SCANS[screen]
  }
  return { queue, state, writes, deliveries, snapshots, show }
}

it('as capturas reais dão o shape esperado pelo gate', () => {
  expect(SCANS.permission.menu?.kind).toBe('permission')
  expect(SCANS.idle.menu).toBeNull()
  expect(SCANS.idle.inputPrompt).toBe(true)
  expect(SCANS.unparsed.menu).toBeNull()
  expect(SCANS.unparsed.inputPrompt).toBe(false)
  expect(SCANS.idle.inputDirty).toBe(false)
  expect(SCANS.placeholder).toMatchObject({ menu: null, inputPrompt: true, inputDirty: false })
  expect(SCANS.dirty).toMatchObject({ menu: null, inputPrompt: true, inputDirty: true })
})

describe('PromptQueue — origem da mensagem (bolinha no mapa)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("'now' avisa a entrega com a sessão de origem", async () => {
    const { queue, deliveries } = setup()
    await queue.send({ sessionId: SID, text: 'oi', when: 'now', fromSessionId: 'mae' })
    expect(deliveries).toEqual([[SID, 'mae']])
  })

  it('na fila só avisa quando a mensagem sai, não ao enfileirar', async () => {
    const { queue, state, deliveries } = setup({ status: 'working' })
    await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle', fromSessionId: 'mae' })
    expect(deliveries).toEqual([])
    expect(queue.snapshot().items[0]).not.toHaveProperty('fromSessionId')

    state.status = 'idle'
    queue.onTurnEnded(SID)
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10)
    expect(deliveries).toEqual([[SID, 'mae']])
  })

  it('recusa não avisa entrega', async () => {
    const { queue, deliveries } = setup({ screen: 'permission', status: 'waiting' })
    await queue.send({ sessionId: SID, text: 'oi', when: 'now', fromSessionId: 'mae' })
    expect(deliveries).toEqual([])
  })
})

describe('PromptQueue.replaceText (coalescing)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('troca o texto do item na fila e a entrega sai UMA vez com o texto novo', async () => {
    const { queue, state, writes } = setup({ status: 'working' })
    const res = await queue.send({ sessionId: SID, text: 'velho', when: 'on-idle' })
    if (!res.ok || res.delivered) throw new Error('esperava enfileirar')
    expect(queue.replaceText(res.queued.id, 'novo')).toBe(true)
    expect(queue.snapshot().items[0].text).toBe('novo')

    state.status = 'idle'
    queue.onTurnEnded(SID)
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10)
    expect(writes).toEqual([`${SID}:novo`])
  })

  it('devolve false para um item que já saiu da fila', async () => {
    const { queue, state } = setup({ status: 'working' })
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    if (!res.ok || res.delivered) throw new Error('esperava enfileirar')
    state.status = 'idle'
    queue.onTurnEnded(SID)
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10)
    expect(queue.snapshot().lastEvent?.kind).toBe('delivered')
    expect(queue.replaceText(res.queued.id, 'tarde')).toBe(false)
  })
})

describe('PromptQueue — envio para qualquer sessão', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("'now' com a sessão ociosa escreve na hora", async () => {
    const { queue, writes } = setup()
    const res = await queue.send({ sessionId: SID, text: 'rode os testes', when: 'now' })
    expect(res).toEqual({ ok: true, delivered: true })
    expect(writes).toEqual([`${SID}:rode os testes`])
  })

  it("'now' recusa com o menu de permissão real na tela (o \\r aprovaria)", async () => {
    const { queue, writes } = setup({ screen: 'permission', status: 'waiting' })
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'now' })
    expect(res).toEqual({ ok: false, error: 'menu-open' })
    expect(writes).toEqual([])
    expect(queue.snapshot().counters.refusedMenuOpen).toBe(1)
  })

  it('sessão que não roda devolve not-running', async () => {
    const { queue, state } = setup()
    state.running = false
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    expect(res).toEqual({ ok: false, error: 'not-running' })
  })

  it("'on-idle' sem espelho da tela não enfileira: não há como provar que não há menu", async () => {
    const { queue } = setup({ mirrored: false })
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    expect(res).toEqual({ ok: false, error: 'no-screen' })
    expect(queue.snapshot().items).toEqual([])
  })

  it.each(['idle', 'waiting'] as const)(
    "'on-idle' já %s e sem menu entrega na hora",
    async (status) => {
      const { queue, writes } = setup({ status })
      const res = await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
      expect(res).toEqual({ ok: true, delivered: true })
      expect(writes).toHaveLength(1)
      expect(queue.snapshot().counters.delivered).toBe(1)
    },
  )

  it("'on-idle' trabalhando espera o fim do turno", async () => {
    const { queue, state, writes } = setup({ status: 'working' })
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    expect(res.ok && !res.delivered).toBe(true)
    expect(writes).toEqual([])
    expect(queue.snapshot().items).toHaveLength(1)

    state.status = 'idle'
    queue.onTurnEnded(SID)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10)
    expect(writes).toEqual([`${SID}:oi`])
    expect(queue.snapshot().items).toEqual([])
    expect(queue.snapshot().lastEvent?.kind).toBe('delivered')
  })

  it("status 'idle' atrasado com o menu de permissão real aberto: NÃO entrega e segura na fila", async () => {
    const { queue, state, writes, show } = setup({ status: 'working' })
    await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })

    show('permission')
    state.status = 'idle'
    queue.onTurnEnded(SID)
    await vi.advanceTimersByTimeAsync(SETTLE_MS + POLL_MS * 3)
    expect(writes).toEqual([])
    const snap = queue.snapshot()
    expect(snap.items).toHaveLength(1)
    expect(snap.items[0].heldByMenu).toBe(1)
    expect(snap.counters.refusedMenuOpen).toBe(1)

    show('idle')
    queue.onTurnEnded(SID)
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10)
    expect(writes).toEqual([`${SID}:oi`])
  })

  it("'on-idle' já idle mas com o menu real na tela vai pra fila em vez de entregar", async () => {
    const { queue, writes } = setup({ screen: 'permission', status: 'idle' })
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    expect(res.ok && !res.delivered).toBe(true)
    expect(writes).toEqual([])
    expect(queue.snapshot().counters.refusedMenuOpen).toBe(1)
  })

  it('filha de handoff com pergunta pendente não recebe a mensagem', async () => {
    const { queue, state, writes } = setup({ status: 'idle' })
    state.asking = true
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    expect(res.ok && !res.delivered).toBe(true)
    expect(writes).toEqual([])
  })

  it('entrega uma mensagem por turno, em ordem', async () => {
    const { queue, state, writes } = setup({ status: 'working' })
    await queue.send({ sessionId: SID, text: 'um', when: 'on-idle' })
    await queue.send({ sessionId: SID, text: 'dois', when: 'on-idle' })

    state.status = 'idle'
    queue.onTurnEnded(SID)
    await vi.advanceTimersByTimeAsync(SETTLE_MS + POLL_MS * 2)
    expect(writes).toEqual([`${SID}:um`])

    state.status = 'working'
    await vi.advanceTimersByTimeAsync(POLL_MS + 10)
    state.status = 'idle'
    queue.onTurnEnded(SID)
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10)
    expect(writes).toEqual([`${SID}:um`, `${SID}:dois`])
  })

  it('não trava se o claude nunca chega a trabalhar depois da entrega', async () => {
    const { queue, writes } = setup({ status: 'idle' })
    await queue.send({ sessionId: SID, text: 'um', when: 'now' })
    await queue.send({ sessionId: SID, text: 'dois', when: 'on-idle' })
    expect(writes).toEqual([`${SID}:um`])
    await vi.advanceTimersByTimeAsync(AWAIT_WORK_MS + POLL_MS * 2)
    expect(writes).toEqual([`${SID}:um`, `${SID}:dois`])
  })

  it('expira depois de 30 min na fila e conta', async () => {
    const { queue, writes } = setup({ status: 'working' })
    await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    await vi.advanceTimersByTimeAsync(PROMPT_TTL_MS + POLL_MS * 2)
    const snap = queue.snapshot()
    expect(snap.items).toEqual([])
    expect(snap.counters.expired).toBe(1)
    expect(snap.lastEvent?.kind).toBe('expired')
    expect(writes).toEqual([])
    expect(PROMPT_TTL_MS).toBe(30 * 60_000)
  })

  it('sessão que morreu com mensagem na fila marca e avisa', async () => {
    const { queue, state, snapshots } = setup({ status: 'working' })
    await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    state.running = false
    queue.onSessionExit(SID)
    const snap = queue.snapshot()
    expect(snap.items).toEqual([])
    expect(snap.counters.sessionGone).toBe(1)
    expect(snapshots.at(-1)?.lastEvent).toMatchObject({ kind: 'session-gone', text: 'oi' })
  })

  it('cancelar tira da fila e nunca entrega', async () => {
    const { queue, state, writes } = setup({ status: 'working' })
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    if (!res.ok || res.delivered) throw new Error('esperava enfileirar')
    expect(queue.cancel(res.queued.id)).toBe(true)
    state.status = 'idle'
    queue.onTurnEnded(SID)
    await vi.advanceTimersByTimeAsync(SETTLE_MS + POLL_MS)
    expect(writes).toEqual([])
    expect(queue.snapshot().lastEvent?.kind).toBe('cancelled')
  })

  it.each(['idle', 'waiting'] as const)(
    "'on-idle' %s com menu não reconhecido na tela real: segura, conta e não escreve",
    async (status) => {
      const { queue, writes, show } = setup({ screen: 'unparsed', status })
      const res = await queue.send({ sessionId: SID, text: 'rode 1 teste', when: 'on-idle' })
      expect(res.ok && !res.delivered).toBe(true)
      await vi.advanceTimersByTimeAsync(POLL_MS * 3)
      expect(writes).toEqual([])
      expect(queue.snapshot().counters.refusedUnparsed).toBe(1)

      show('idle')
      await vi.advanceTimersByTimeAsync(POLL_MS + 10)
      expect(writes).toEqual([`${SID}:rode 1 teste`])
    },
  )

  it("'now' com menu não reconhecido na tela real recusa em vez de escrever", async () => {
    const { queue, writes } = setup({ screen: 'unparsed', status: 'waiting' })
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'now' })
    expect(res).toEqual({ ok: false, error: 'unparsed' })
    expect(writes).toEqual([])
    expect(queue.snapshot().counters.refusedUnparsed).toBe(1)
  })

  it("'now' para filha de handoff com pergunta pendente recusa", async () => {
    const { queue, state, writes } = setup({ status: 'idle' })
    state.asking = true
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'now' })
    expect(res).toEqual({ ok: false, error: 'attention' })
    expect(writes).toEqual([])
  })

  it("'now' sem espelho: recusa se a sessão espera você, escreve nos outros casos", async () => {
    const waiting = setup({ status: 'waiting', mirrored: false })
    const res = await waiting.queue.send({ sessionId: SID, text: 'oi', when: 'now' })
    expect(res).toEqual({ ok: false, error: 'no-screen' })
    expect(waiting.writes).toEqual([])

    const idle = setup({ status: 'idle', mirrored: false })
    expect(await idle.queue.send({ sessionId: SID, text: 'oi', when: 'now' })).toEqual({
      ok: true,
      delivered: true,
    })
    expect(idle.writes).toEqual([`${SID}:oi`])
  })

  it("'now' sem espelho com status só da PTY (Codex) recusa até 'idle': o overlay parado parece ocioso", async () => {
    const codex = setup({ status: 'idle', mirrored: false })
    codex.state.native = false
    const res = await codex.queue.send({ sessionId: SID, text: 'continue', when: 'now' })
    expect(res).toEqual({ ok: false, error: 'no-screen' })
    expect(codex.writes).toEqual([])
  })

  it('a PTY morre durante a releitura da tela: o envio não se diz entregue', async () => {
    const { queue, state, writes, snapshots } = setup({ status: 'idle' })
    let scans = 0
    // 2ª leitura = a do tryDeliver; o 'exit' do ptyManager chega no meio dela.
    state.onScan = () => {
      if (++scans !== 2) return
      state.running = false
      queue.onSessionExit(SID)
    }
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    expect(res).toEqual({ ok: false, error: 'not-running' })
    expect(writes).toEqual([])
    expect(snapshots.at(-1)?.lastEvent?.kind).toBe('session-gone')
    expect(queue.snapshot().counters.delivered).toBe(0)
  })

  it('cancelada durante a releitura da tela: o envio devolve cancelled', async () => {
    const { queue, state, writes } = setup({ status: 'idle' })
    let scans = 0
    state.onScan = () => {
      if (++scans !== 2) return
      const id = queue.snapshot().items[0]?.id
      if (id) queue.cancel(id)
    }
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    expect(res).toEqual({ ok: false, error: 'cancelled' })
    expect(writes).toEqual([])
  })

  it('o poll entrega mesmo se a borda do fim de turno se perder', async () => {
    const { queue, state, writes } = setup({ status: 'working' })
    await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    state.status = 'idle'
    await vi.advanceTimersByTimeAsync(POLL_MS + 10)
    expect(writes).toEqual([`${SID}:oi`])
  })

  it("placeholder esmaecido na caixa real: 'now' entrega normalmente", async () => {
    const { queue, writes } = setup({ screen: 'placeholder' })
    expect(await queue.send({ sessionId: SID, text: 'oi', when: 'now' })).toEqual({
      ok: true,
      delivered: true,
    })
    expect(writes).toEqual([`${SID}:oi`])
  })

  it("rascunho do usuário na caixa real: 'now' recusa com input-dirty e conta", async () => {
    const { queue, writes } = setup({ screen: 'dirty' })
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'now' })
    expect(res).toEqual({ ok: false, error: 'input-dirty' })
    expect(writes).toEqual([])
    expect(queue.snapshot().counters.refusedInputDirty).toBe(1)
  })

  it("rascunho na caixa real: 'on-idle' segura com o motivo e entrega quando a caixa esvazia", async () => {
    const { queue, writes, show } = setup({ screen: 'dirty' })
    const res = await queue.send({ sessionId: SID, text: 'oi', when: 'on-idle' })
    expect(res.ok && !res.delivered).toBe(true)
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(writes).toEqual([])
    const snap = queue.snapshot()
    expect(snap.items[0].heldReason).toBe('input-dirty')
    // Um motivo contínuo conta uma vez, não a cada poll.
    expect(snap.counters.refusedInputDirty).toBe(1)

    show('placeholder')
    await vi.advanceTimersByTimeAsync(POLL_MS + 10)
    expect(writes).toEqual([`${SID}:oi`])
  })
})
