// Barramento único dos "pulsos" entre sessões: cada produtor real de mensagem
// sessão→sessão (handoff tools, agent-bus, bastão, SendMessage nativo) avisa aqui,
// e o mapa anima a bolinha no fio. É efêmero de propósito — nada persiste, e falhar
// aqui nunca pode derrubar a entrega que já aconteceu (por isso o try no emit).
import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type {
  SessionLinkPulse,
  SessionLinkPulseKind,
} from '../../../shared/types/session-link-pulse'

export const PULSE_WINDOW_MS = 1000
// Acima disso o fio vira um borrão; o excedente da janela vira UM pulso no fim dela.
export const PULSES_PER_WINDOW = 4

export interface PulseInput {
  fromSessionId: string | null | undefined
  toSessionId: string | null | undefined
  kind: SessionLinkPulseKind
  label?: string
}

export interface PulseBusDeps {
  now(): number
  publish(pulse: SessionLinkPulse): void
  schedule(fn: () => void, ms: number): void
  labelFor?(from: string, to: string, kind: SessionLinkPulseKind): string | undefined
  newId?(): string
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

export class SessionLinkPulseBus {
  private recent = new Map<string, number[]>()
  private pending = new Map<string, PulseInput>()

  constructor(private readonly deps: PulseBusDeps) {}

  emit(input: PulseInput): void {
    const from = input.fromSessionId
    const to = input.toSessionId
    if (!from || !to || from === to) return
    const key = pairKey(from, to)
    const now = this.deps.now()
    const times = (this.recent.get(key) ?? []).filter((t) => now - t < PULSE_WINDOW_MS)
    if (times.length >= PULSES_PER_WINDOW) {
      const scheduled = this.pending.has(key)
      this.pending.set(key, input)
      if (!scheduled) this.deps.schedule(() => this.flush(key), times[0] + PULSE_WINDOW_MS - now)
      this.recent.set(key, times)
      return
    }
    times.push(now)
    this.recent.set(key, times)
    this.deps.publish({
      id: this.deps.newId?.() ?? randomUUID(),
      fromSessionId: from,
      toSessionId: to,
      kind: input.kind,
      label: input.label ?? this.deps.labelFor?.(from, to, input.kind),
      at: now,
    })
  }

  private flush(key: string): void {
    const input = this.pending.get(key)
    this.pending.delete(key)
    if (input) this.emit(input)
  }
}

// ---- SendMessage nativo do Claude Code, lido do tail do transcript ----

export interface SendMessageCall {
  toolUseId: string
  to: string
  at: number
}

interface ToolUseItem {
  type?: string
  id?: string
  name?: string
  input?: { to?: unknown }
}

// tool_use 'SendMessage' das linhas assistant. `at` vem do timestamp da linha: o
// tail relido traz o histórico, e só o que acabou de acontecer vira pulso.
export function extractSendMessages(tail: string): SendMessageCall[] {
  const out: SendMessageCall[] = []
  for (const raw of tail.split('\n')) {
    if (!raw.includes('"SendMessage"')) continue
    let line: { type?: string; timestamp?: string; message?: { content?: ToolUseItem[] } }
    try {
      line = JSON.parse(raw.trim())
    } catch {
      continue // linha partida no começo do tail
    }
    if (line.type !== 'assistant' || !Array.isArray(line.message?.content)) continue
    const at = line.timestamp ? Date.parse(line.timestamp) : NaN
    for (const c of line.message.content) {
      if (c.type !== 'tool_use' || c.name !== 'SendMessage' || !c.id) continue
      if (typeof c.input?.to !== 'string' || !c.input.to) continue
      out.push({ toolUseId: c.id, to: c.input.to, at })
    }
  }
  return out
}

// `to` é o apelido vivo (`-n`, que é o endereço) ou o socket do processo
// ("uds:/run/user/1000/cc-socks/<pid>.sock"). Ambos viram ccSessionId pelo índice
// de ~/.claude/sessions; sem o índice, o apelido ainda casa com sessions.title.
export interface SendMessageResolveDeps {
  index: ReadonlyMap<string, { pid: number; name: string | null }>
  sessionIdForCc(ccSessionId: string): string | null
  sessionIdForTitle(title: string): string | null
}

const UDS_PID = /\/(\d+)\.sock$/

export function resolveSendMessageTarget(to: string, deps: SendMessageResolveDeps): string | null {
  const pid = to.startsWith('uds:') ? Number(UDS_PID.exec(to)?.[1]) : NaN
  for (const [cc, entry] of deps.index) {
    if (Number.isFinite(pid) ? entry.pid === pid : entry.name === to) {
      const id = deps.sessionIdForCc(cc)
      if (id) return id
    }
  }
  return Number.isFinite(pid) ? null : deps.sessionIdForTitle(to)
}

// Na PRIMEIRA leitura de uma sessão (boot, sessão recém-indexada), mais velho que
// isso é histórico, não mensagem nova. Depois da primeira leitura, todo tool_use
// que aparece é novo, qualquer que seja o carimbo: um turno longo só relê o tail
// minutos depois da chamada, e cortar por idade perdia exatamente esse pulso.
export const SEND_MESSAGE_FRESH_MS = 30_000
// Quanto tempo uma chamada sem remetente/destino resolvido ainda é retentada.
export const SEND_MESSAGE_RETRY_MS = 30_000
const SEEN_CAP = 2000

export class SendMessageWatcher {
  private seen = new Set<string>()
  private unresolved = new Map<string, number>()
  private baselined = new Set<string>()

  constructor(
    private readonly emit: (input: PulseInput) => void,
    private readonly now: () => number = Date.now,
  ) {}

  markRead(sourceKey: string): void {
    this.baselined.add(sourceKey)
  }

  // sourceKey = o ccSessionId do transcript lido (a sessão pode ainda não ter
  // fromSessionId no banco; o baseline é do arquivo).
  scan(
    sourceKey: string,
    fromSessionId: string | null,
    tail: string,
    deps: SendMessageResolveDeps,
  ): void {
    const firstRead = !this.baselined.has(sourceKey)
    this.baselined.add(sourceKey)
    const now = this.now()
    for (const call of extractSendMessages(tail)) {
      if (this.seen.has(call.toolUseId)) continue
      const pendingSince = this.unresolved.get(call.toolUseId)
      if (
        pendingSince === undefined &&
        firstRead &&
        !(now - call.at <= SEND_MESSAGE_FRESH_MS)
      ) {
        this.seen.add(call.toolUseId)
        continue
      }
      const to = resolveSendMessageTarget(call.to, deps)
      if (fromSessionId && to) {
        this.unresolved.delete(call.toolUseId)
        this.seen.add(call.toolUseId)
        this.emit({ fromSessionId, toSessionId: to, kind: 'message' })
      } else if (pendingSince === undefined) {
        // Remetente ainda sem cc_session_id no banco, ou destino ainda fora do
        // índice de ~/.claude/sessions: a próxima releitura tenta de novo.
        this.unresolved.set(call.toolUseId, now)
      } else if (now - pendingSince > SEND_MESSAGE_RETRY_MS) {
        this.unresolved.delete(call.toolUseId)
        this.seen.add(call.toolUseId)
      }
    }
    if (this.seen.size > SEEN_CAP) this.seen = new Set([...this.seen].slice(-SEEN_CAP / 2))
    if (this.unresolved.size > SEEN_CAP) {
      this.unresolved = new Map([...this.unresolved].slice(-SEEN_CAP / 2))
    }
  }
}

// ---- singleton do app ----

export const KIND_LABEL: Record<SessionLinkPulseKind, string> = {
  task: 'tarefa',
  message: 'mensagem',
  progress: 'progresso',
  report: 'entrega',
  question: 'pergunta',
  answer: 'resposta',
  ask: 'pergunta',
  reply: 'resposta',
  note: 'nota',
}

type Listener = (pulse: SessionLinkPulse) => void
const listeners = new Set<Listener>()

export function onSessionLinkPulse(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Rótulo é cosmético: sem banco (teste, desligando) o pulso sai sem nome, mas sai.
// Sessão sem apelido ainda tem o repo: "legal-app → sessão" não diz nada.
function titleOf(sessionId: string): string | null {
  try {
    const row = getDb()
      .prepare(
        'SELECT COALESCE(s.title, r.label) AS name FROM sessions s LEFT JOIN repos r ON r.id = s.repo_id WHERE s.id = ?',
      )
      .get(sessionId) as { name: string | null } | undefined
    return row?.name ?? null
  } catch {
    return null
  }
}

const bus = new SessionLinkPulseBus({
  now: () => Date.now(),
  publish: (pulse) => {
    for (const fn of listeners) fn(pulse)
  },
  schedule: (fn, ms) => void setTimeout(fn, ms),
  labelFor: (from, to, kind) =>
    `${titleOf(from) ?? 'sessão'} → ${titleOf(to) ?? 'sessão'}: ${KIND_LABEL[kind]}`,
})

export function emitSessionLinkPulse(input: PulseInput): void {
  try {
    bus.emit(input)
  } catch (err) {
    console.warn('[session-link-pulse] pulso descartado:', err)
  }
}

const sendMessageWatcher = new SendMessageWatcher(emitSessionLinkPulse)

function sessionIdForCc(ccSessionId: string): string | null {
  const row = getDb()
    .prepare('SELECT id FROM sessions WHERE cc_session_id = ? ORDER BY started_at DESC LIMIT 1')
    .get(ccSessionId) as { id: string } | undefined
  return row?.id ?? null
}

function sessionIdForTitle(title: string): string | null {
  const row = getDb()
    .prepare(
      "SELECT id FROM sessions WHERE title = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    )
    .get(title) as { id: string } | undefined
  return row?.id ?? null
}

// Chamado a cada releitura do tail (session-activity): o SendMessage nativo não
// passa pelo app, então o transcript é a única testemunha dele.
export function scanTranscriptForSendMessage(
  ccSessionId: string,
  tail: string,
  index: SendMessageResolveDeps['index'],
): void {
  if (!tail.includes('"SendMessage"')) {
    // Lida sem SendMessage ainda conta como 1ª leitura: a chamada que vier
    // depois é nova, por mais atrasada que seja a releitura.
    sendMessageWatcher.markRead(ccSessionId)
    return
  }
  try {
    sendMessageWatcher.scan(ccSessionId, sessionIdForCc(ccSessionId), tail, {
      index,
      sessionIdForCc,
      sessionIdForTitle,
    })
  } catch (err) {
    console.warn('[session-link-pulse] SendMessage não resolvido:', err)
  }
}
