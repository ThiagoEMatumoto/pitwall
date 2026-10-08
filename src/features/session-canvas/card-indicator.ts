// PURO: o indicador de estado do cartão — o que a sessão está fazendo e se ela
// precisa de você —, derivado do status do grafo, do motivo parseado da tela
// (attentionReason do LiveSessionInfo) e dos relógios de atividade.
import type {
  SessionGraphAttention,
  SessionGraphNode,
  SessionGraphStatus,
} from '../../../shared/types/session-graph'
import type { LiveSessionInfo } from '../../../shared/types/ipc'

export type IndicatorTone = 'needs-you' | 'working' | 'done' | 'starting' | 'interrupted' | 'ended'

// UMA cor por tom em todas as superfícies (cartão, contadores, Crew Dock, peek):
// "precisa de você" é sempre o vermelho do HUD de atenção, nunca âmbar.
export const TONE_COLOR: Record<IndicatorTone, string> = {
  'needs-you': 'var(--color-danger)',
  working: 'var(--color-info)',
  starting: 'var(--color-info)',
  done: 'var(--color-success)',
  interrupted: 'var(--color-warning)',
  ended: 'var(--color-text-dim)',
}

export interface CardIndicator {
  tone: IndicatorTone
  // Só em 'needs-you': Permissão / Pergunta / Pergunta pendente / Confiar.
  reason: string | null
  // Só em 'working': o que ela está dizendo agora (1ª linha do último texto).
  step: string | null
  // Desde quando está neste estado (ms epoch); null = sem relógio confiável.
  sinceAt: number | null
}

export interface IndicatorInput {
  status: SessionGraphStatus
  graphAttention: SessionGraphAttention | null
  detail?: LiveSessionInfo['attentionReason']
  lastActivityAt: number | null
  workingSince: number | null
  lastText?: string | null
  // Fim da tela (cartão aberto): é onde a interrupção aparece.
  tail?: string[] | null
}

const REASON: Record<string, string> = {
  permission: 'Permissão',
  question: 'Pergunta',
  'handoff-input': 'Pergunta pendente',
  trust: 'Confiar',
}

const STEP_MAX = 90
const INTERRUPT_SCAN_LINES = 8
// "⎿  Interrupted · What should Claude do instead?" (Esc/Ctrl+C no meio do turno).
const INTERRUPTED_RE = /(^|\s)⎿?\s*Interrupted\b/

function firstLine(text: string | null | undefined): string | null {
  const line = text
    ?.split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return null
  return line.length > STEP_MAX ? `${line.slice(0, STEP_MAX - 1)}…` : line
}

export function looksInterrupted(tail: string[] | null | undefined): boolean {
  if (!tail) return false
  return tail.slice(-INTERRUPT_SCAN_LINES).some((l) => INTERRUPTED_RE.test(l))
}

export function cardIndicator(input: IndicatorInput): CardIndicator {
  const base = { reason: null, step: null }
  if (input.status === 'ended') return { tone: 'ended', ...base, sinceAt: null }
  // Precisa de você vence o status, e vem SÓ do nó (a fila única, attention:list):
  // a tela parseada aqui (detail, tail) só dá o rótulo. Uma regra própria daqui
  // fazia os contadores do mapa divergirem do HUD (a projeção conta a tela
  // "Interrupted" como esperando você: não reconhecida não é suprimida).
  if (input.graphAttention) {
    const reason =
      input.graphAttention === 'handoff-input'
        ? REASON['handoff-input']
        : ((input.detail && REASON[input.detail]) ??
          (looksInterrupted(input.tail) ? 'Interrompida' : 'Esperando você'))
    return { tone: 'needs-you', ...base, reason, sinceAt: input.lastActivityAt }
  }
  if (input.status === 'starting') return { tone: 'starting', ...base, sinceAt: null }
  if (input.status === 'working') {
    return {
      tone: 'working',
      reason: null,
      step: firstLine(input.lastText),
      sinceAt: input.workingSince ?? input.lastActivityAt,
    }
  }
  if (looksInterrupted(input.tail)) {
    return { tone: 'interrupted', ...base, sinceAt: input.lastActivityAt }
  }
  return { tone: 'done', ...base, sinceAt: input.lastActivityAt }
}

export function indicatorFor(
  node: SessionGraphNode,
  live: Pick<LiveSessionInfo, 'attentionReason' | 'lastText'> | undefined,
  workingSince: number | null,
  tail?: string[] | null,
): CardIndicator {
  return cardIndicator({
    status: node.status,
    graphAttention: node.attentionReason,
    detail: live?.attentionReason,
    lastActivityAt: node.lastActivityAt,
    workingSince,
    lastText: live?.lastText,
    tail,
  })
}

// Duração curta pro rótulo da pílula: 45s, 3m, 2h, 1d.
export function shortDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function indicatorText(ind: CardIndicator, now: number): string {
  const since = ind.sinceAt != null ? shortDuration(now - ind.sinceAt) : null
  switch (ind.tone) {
    case 'working':
      return since ? `trabalhando há ${since}` : 'trabalhando'
    case 'needs-you':
      return 'precisa de você'
    case 'done':
      return since ? `pronto · há ${since}` : 'pronto'
    case 'interrupted':
      return since ? `interrompida · há ${since}` : 'interrompida'
    case 'starting':
      return 'subindo'
    case 'ended':
      return 'encerrada'
  }
}

// Relógio "trabalhando há": quando cada sessão entrou em 'working' (null fora dele).
// O 1º status visto já em 'working' conta daquele instante — melhor que nada.
export function advanceWorkingClocks(
  prev: ReadonlyMap<string, number | null>,
  nodes: Array<Pick<SessionGraphNode, 'sessionId' | 'status'>>,
  now: number,
): Map<string, number | null> {
  const next = new Map<string, number | null>()
  for (const n of nodes) {
    if (n.status !== 'working') {
      next.set(n.sessionId, null)
      continue
    }
    next.set(n.sessionId, prev.get(n.sessionId) ?? now)
  }
  return next
}

export interface MapCounters {
  working: number
  needsYou: number
  done: number
}

export function mapCounters(tones: IndicatorTone[]): MapCounters {
  const out: MapCounters = { working: 0, needsYou: 0, done: 0 }
  for (const t of tones) {
    if (t === 'working') out.working++
    else if (t === 'needs-you') out.needsYou++
    else if (t === 'done') out.done++
  }
  return out
}
