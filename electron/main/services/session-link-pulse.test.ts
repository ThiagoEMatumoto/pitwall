/** @vitest-environment node */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionLinkPulse } from '../../../shared/types/session-link-pulse'
import {
  KIND_LABEL,
  PULSE_WINDOW_MS,
  PULSES_PER_WINDOW,
  SendMessageWatcher,
  SEND_MESSAGE_RETRY_MS,
  SessionLinkPulseBus,
  extractSendMessages,
  resolveSendMessageTarget,
  type PulseInput,
  type SendMessageResolveDeps,
} from './session-link-pulse'

function makeBus() {
  let now = 1_000
  const published: SessionLinkPulse[] = []
  const timers: Array<{ at: number; fn: () => void }> = []
  let seq = 0
  const bus = new SessionLinkPulseBus({
    now: () => now,
    publish: (p) => published.push(p),
    schedule: (fn, ms) => timers.push({ at: now + ms, fn }),
    labelFor: (from, to, kind) => `${from} → ${to}: ${kind}`,
    newId: () => `p${++seq}`,
  })
  const advance = (ms: number) => {
    now += ms
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (t.at <= now) t.fn()
      else timers.push(t)
    }
  }
  return { bus, published, advance, pending: () => timers.length }
}

describe('SessionLinkPulseBus', () => {
  it('publica from/to/kind com rótulo e carimbo', () => {
    const { bus, published } = makeBus()
    bus.emit({ fromSessionId: 'mae', toSessionId: 'filha', kind: 'task' })
    expect(published).toEqual([
      {
        id: 'p1',
        fromSessionId: 'mae',
        toSessionId: 'filha',
        kind: 'task',
        label: 'mae → filha: task',
        at: 1_000,
      },
    ])
  })

  it('ignora par incompleto e auto-pulso', () => {
    const { bus, published } = makeBus()
    bus.emit({ fromSessionId: null, toSessionId: 'x', kind: 'note' })
    bus.emit({ fromSessionId: 'x', toSessionId: undefined, kind: 'note' })
    bus.emit({ fromSessionId: 'x', toSessionId: 'x', kind: 'note' })
    expect(published).toHaveLength(0)
  })

  it(`no máximo ${PULSES_PER_WINDOW}/s por par; o excedente coalesce em UM pulso no fim da janela`, () => {
    const { bus, published, advance } = makeBus()
    for (let i = 0; i < 10; i++) {
      // Mesma dupla nos dois sentidos conta como o mesmo par (é o mesmo fio).
      const fwd = i % 2 === 0
      bus.emit({
        fromSessionId: fwd ? 'a' : 'b',
        toSessionId: fwd ? 'b' : 'a',
        kind: i === 9 ? 'reply' : 'message',
      })
    }
    expect(published).toHaveLength(PULSES_PER_WINDOW)
    advance(PULSE_WINDOW_MS)
    expect(published).toHaveLength(PULSES_PER_WINDOW + 1)
    // O coalescido carrega o ÚLTIMO pedido (direção e tipo).
    expect(published.at(-1)).toMatchObject({ fromSessionId: 'b', toSessionId: 'a', kind: 'reply' })
  })

  it('pares diferentes não dividem a cota', () => {
    const { bus, published } = makeBus()
    for (let i = 0; i < PULSES_PER_WINDOW; i++)
      bus.emit({ fromSessionId: 'a', toSessionId: 'b', kind: 'message' })
    bus.emit({ fromSessionId: 'a', toSessionId: 'c', kind: 'message' })
    expect(published).toHaveLength(PULSES_PER_WINDOW + 1)
  })
})

// Linhas REAIS do transcript do Claude Code 2.1.286 (texto da mensagem trocado
// por um neutro): uma com apelido no `to`, outra com o socket do processo.
const FIXTURE = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    'shared',
    'tui',
    '__fixtures__',
    'claude-2.1.286-send-message.jsonl',
  ),
  'utf8',
)
const ALIAS_AT = Date.parse('2026-09-30T20:24:19.303Z')
const UDS_AT = Date.parse('2026-09-30T19:26:42.577Z')

describe('SendMessage nativo no transcript', () => {
  it('extrai tool_use id, destino e hora das linhas reais', () => {
    expect(extractSendMessages(`{"partida...\n${FIXTURE}`)).toEqual([
      {
        toolUseId: 'toolu_01Fyug6k2b6p9nxpnb8gSWYx',
        to: 'otavio-fazer-lia-responder',
        at: ALIAS_AT,
      },
      {
        toolUseId: 'toolu_01FTNqXLJMTBGdwHFoMjeEpA',
        to: 'uds:/run/user/1000/cc-socks/914134.sock',
        at: UDS_AT,
      },
    ])
  })

  const deps: SendMessageResolveDeps = {
    index: new Map([
      ['cc-otavio', { pid: 111, name: 'otavio-fazer-lia-responder' }],
      ['cc-sock', { pid: 914134, name: 'outra' }],
    ]),
    sessionIdForCc: (cc) => ({ 'cc-otavio': 's-otavio', 'cc-sock': 's-sock' })[cc] ?? null,
    sessionIdForTitle: (t) => (t === 'so-no-banco' ? 's-banco' : null),
  }

  it('resolve apelido vivo, socket por pid e cai no sessions.title', () => {
    expect(resolveSendMessageTarget('otavio-fazer-lia-responder', deps)).toBe('s-otavio')
    expect(resolveSendMessageTarget('uds:/run/user/1000/cc-socks/914134.sock', deps)).toBe('s-sock')
    expect(resolveSendMessageTarget('uds:/run/user/1000/cc-socks/999.sock', deps)).toBeNull()
    expect(resolveSendMessageTarget('so-no-banco', deps)).toBe('s-banco')
    // Subagente in-process (id hex) não é sessão do mapa.
    expect(resolveSendMessageTarget('a47c9571013d0d199', deps)).toBeNull()
  })

  it('pulsa só o que é novo, uma vez por tool_use, e ignora histórico relido', () => {
    const out: PulseInput[] = []
    let now = ALIAS_AT + 2_000
    const w = new SendMessageWatcher(
      (p) => out.push(p),
      () => now,
    )
    w.scan('cc-mae', 's-mae', FIXTURE, deps)
    // A linha do socket é de 1h antes: histórico, não pulsa.
    expect(out).toEqual([{ fromSessionId: 's-mae', toSessionId: 's-otavio', kind: 'message' }])
    now += 500
    w.scan('cc-mae', 's-mae', FIXTURE, deps)
    expect(out).toHaveLength(1)
  })

  // Turno longo: a releitura do tail só acontece minutos depois do tool_use.
  // Já tendo lido esta sessão antes, a chamada é nova e pulsa mesmo velha.
  it('chamada nova numa sessão já lida pulsa mesmo com releitura atrasada', () => {
    const [alias, sock] = FIXTURE.trim().split('\n').filter((l) => l.includes('"SendMessage"'))
    const out: PulseInput[] = []
    let now = UDS_AT + 5 * 60_000
    const w = new SendMessageWatcher(
      (p) => out.push(p),
      () => now,
    )
    w.scan('cc-mae', 's-mae', sock, deps)
    expect(out).toEqual([])
    now = ALIAS_AT + 3 * 60_000
    w.scan('cc-mae', 's-mae', `${sock}\n${alias}`, deps)
    expect(out).toEqual([{ fromSessionId: 's-mae', toSessionId: 's-otavio', kind: 'message' }])
  })

  // O índice de ~/.claude/sessions e o cc_session_id do remetente podem chegar
  // depois da 1ª leitura do tail: a chamada não pode morrer marcada como vista.
  it('destino ainda fora do índice pulsa quando o índice chega (dentro do prazo)', () => {
    const [alias] = FIXTURE.trim().split('\n').filter((l) => l.includes('"SendMessage"'))
    const out: PulseInput[] = []
    let now = ALIAS_AT + 2_000
    const w = new SendMessageWatcher(
      (p) => out.push(p),
      () => now,
    )
    const empty: SendMessageResolveDeps = { ...deps, index: new Map() }
    w.scan('cc-mae', 's-mae', alias, empty)
    w.scan('cc-mae', null, alias, deps)
    expect(out).toEqual([])
    now += 5_000
    w.scan('cc-mae', 's-mae', alias, deps)
    expect(out).toEqual([{ fromSessionId: 's-mae', toSessionId: 's-otavio', kind: 'message' }])
    w.scan('cc-mae', 's-mae', alias, deps)
    expect(out).toHaveLength(1)
  })

  it('não resolvida depois do prazo é descartada de vez', () => {
    const [alias] = FIXTURE.trim().split('\n').filter((l) => l.includes('"SendMessage"'))
    const out: PulseInput[] = []
    let now = ALIAS_AT + 2_000
    const w = new SendMessageWatcher(
      (p) => out.push(p),
      () => now,
    )
    const empty: SendMessageResolveDeps = { ...deps, index: new Map() }
    w.scan('cc-mae', 's-mae', alias, empty)
    now += SEND_MESSAGE_RETRY_MS + 1
    w.scan('cc-mae', 's-mae', alias, empty)
    now += 1_000
    w.scan('cc-mae', 's-mae', alias, deps)
    expect(out).toEqual([])
  })
})

it('entrega final não é anunciada como progresso', () => {
  expect(KIND_LABEL.report).toBe('entrega')
  expect(KIND_LABEL.progress).toBe('progresso')
})
