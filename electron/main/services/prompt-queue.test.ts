import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TuiMenuWatch } from './tui-menu-watch'
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

// Telas REAIS do claude 2.1.286 passadas pelo mesmo espelho headless que o app usa
// em produção (TuiMenuWatch): o gate lê o ScreenScan que o produtor real devolve.
const FIXTURES = join(__dirname, '..', '..', '..', 'shared', 'tui', '__fixtures__')
const PERMISSION = readFileSync(join(FIXTURES, 'claude-2.1.286-permission-bash.ansi'), 'utf8')
const IDLE_PROMPT = readFileSync(join(FIXTURES, 'claude-2.1.286-idle-prompt.ansi'), 'utf8')
// Menu real que o parser NÃO reconhece (trust sem numeração): sem menu e sem a
// caixa de input — o caso de drift da CLI em que o \r responderia às cegas.
const UNPARSED = readFileSync(join(FIXTURES, 'claude-2.1.286-trust-unnumbered.ansi'), 'utf8')
// Caixa de input vazia (placeholder esmaecido) × com rascunho digitado sem Enter:
// o texto puro das duas é "❯ <algo>"; só o atributo dim das células separa.
const PLACEHOLDER = readFileSync(
  join(FIXTURES, 'claude-2.1.286-input-placeholder.ansi'),
  'utf8',
)
const DIRTY = readFileSync(join(FIXTURES, 'claude-2.1.286-input-dirty.ansi'), 'utf8')
const SID = 's1'

class FakePty extends EventEmitter {
  write(): void {}
}

// O scan sai do TuiMenuWatch real com timers reais (o write do xterm headless é
// assíncrono); os testes da fila rodam com timers falsos em cima desse shape.
async function scanOf(raw: string): Promise<ScreenScan> {
  const pty = new FakePty()
  const watch = new TuiMenuWatch()
  watch.attach(pty)
  pty.emit('spawn', { sessionId: 'probe', cols: 80, rows: 24 })
  pty.emit('data', { sessionId: 'probe', data: raw })
  const scan = await watch.rescan('probe')
  pty.emit('exit', { sessionId: 'probe', exitCode: 0 })
  if (!scan) throw new Error('sem scan')
  return scan
}

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
  }
  const writes: string[] = []
  const snapshots: PromptQueueSnapshot[] = []
  const deps: PromptQueueDeps = {
    isRunning: () => state.running,
    status: () => state.status,
    screen: async () => state.scan,
    handoffAsking: () => state.asking,
    write: (id, text) => writes.push(`${id}:${text}`),
    emit: (s) => snapshots.push(s),
    warn: () => {},
  }
  const queue = new PromptQueue(deps)
  const show = (screen: Screen) => {
    state.scan = SCANS[screen]
  }
  return { queue, state, writes, snapshots, show }
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
