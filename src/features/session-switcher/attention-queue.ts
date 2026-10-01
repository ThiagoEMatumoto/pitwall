import { crewNeedsAttention, crewResumedAfterQuestion, dockCrew } from '@/features/handoffs/crew'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'
import { mruBackTarget } from '@/store/session-mru-store'
import { liveSessionLabel } from './session-label'

// Fila de atenção: "quem precisa de você, em que ordem". Pura — o hook
// (useAttentionQueue) só a alimenta dos stores. É a MESMA fonte do badge "N no
// box" da TitleBar, então badge e ciclo do Alt+A nunca discordam.

export type AttentionReason = 'handoff-input' | 'waiting' | 'crew'

// O PORQUÊ da espera (tela parseada no main). Enfeite: nunca muda quem entra na fila.
export type AttentionDetail = NonNullable<LiveSessionInfo['attentionReason']>

export interface AttentionItem {
  // Identidade estável dentro da fila (cursor do ciclo): session:<id> | crew:<handoffId>.
  key: string
  // 'session' abre/foca uma aba; 'crew' abre o quick look da filha (sem criar aba).
  kind: 'session' | 'crew'
  // Session.id (= LiveSessionInfo.id). Null só em crew sem sessão viva.
  sessionId: string | null
  ccSessionId: string | null
  handoffId?: string
  projectName: string | null
  title: string
  reason: AttentionReason
  detail?: AttentionDetail
  // Desde quando espera (ms epoch); null quando não há relógio confiável.
  since: number | null
  liveStatus: LiveSessionInfo['status'] | null
}

export interface AttentionQueueInput {
  // Sessões que o usuário vê na barra/switcher (useVisibleLiveSessions): filha do
  // dock sem aba aberta NÃO está aqui — ela entra pela crew.
  visibleSessions: LiveSessionInfo[]
  liveSessions: LiveSessionInfo[]
  handoffs: Handoff[]
}

// Mais antiga primeiro; sem relógio vai pro fim (não dá pra dizer que espera há mais tempo).
function bySinceAsc(a: AttentionItem, b: AttentionItem): number {
  if (a.since == null) return b.since == null ? 0 : 1
  if (b.since == null) return -1
  return a.since - b.since
}

function sessionItem(
  s: LiveSessionInfo,
  reason: AttentionReason,
  since: number | null,
  handoffId?: string,
): AttentionItem {
  return {
    key: `session:${s.id}`,
    kind: 'session',
    sessionId: s.id,
    ccSessionId: s.ccSessionId,
    ...(handoffId ? { handoffId } : {}),
    projectName: s.projectName,
    title: liveSessionLabel(s),
    reason,
    detail: reason === 'handoff-input' ? 'handoff-input' : s.attentionReason,
    since,
    liveStatus: s.status,
  }
}

function crewItem(h: Handoff, liveChild: LiveSessionInfo | undefined): AttentionItem {
  const asking = h.status === 'needs_input' && !crewResumedAfterQuestion(h)
  return {
    key: `crew:${h.id}`,
    kind: 'crew',
    sessionId: h.childSessionId,
    ccSessionId: liveChild?.ccSessionId ?? null,
    handoffId: h.id,
    projectName: liveChild?.projectName ?? h.targetRepoLabel,
    title: liveChild?.title ?? liveChild?.name ?? h.task,
    reason: asking ? 'handoff-input' : 'crew',
    detail: asking ? 'handoff-input' : liveChild?.attentionReason,
    since: asking ? h.questionAskedAt : (liveChild?.lastActivityAt ?? null),
    liveStatus: liveChild?.status ?? null,
  }
}

// Ordem: (1) filha com aba aberta e pergunta pendente, (2) sessões visíveis em
// waiting, (3) filhas do dock que esperam você. Dedup por sessionId: a filha com
// aba aberta é sessão de primeira classe e nunca aparece de novo como crew.
export function buildAttentionQueue(input: AttentionQueueInput): AttentionItem[] {
  const visibleById = new Map(input.visibleSessions.map((s) => [s.id, s]))
  const liveById = new Map(input.liveSessions.map((s) => [s.id, s]))
  const crew = dockCrew(input.handoffs)
  const taken = new Set<string>()

  const asking: AttentionItem[] = []
  for (const h of crew) {
    const child = h.childSessionId ? visibleById.get(h.childSessionId) : undefined
    if (!child || h.status !== 'needs_input' || crewResumedAfterQuestion(h)) continue
    asking.push(sessionItem(child, 'handoff-input', h.questionAskedAt, h.id))
    taken.add(child.id)
  }

  const waiting = input.visibleSessions
    .filter((s) => s.status === 'waiting' && !taken.has(s.id))
    .map((s) => sessionItem(s, 'waiting', s.lastActivityAt))
  for (const item of waiting) taken.add(item.sessionId!)

  const crewItems = crew
    .filter((h) => !(h.childSessionId && taken.has(h.childSessionId)))
    .filter((h) =>
      crewNeedsAttention(h, h.childSessionId ? liveById.get(h.childSessionId) : undefined),
    )
    .map((h) => crewItem(h, h.childSessionId ? liveById.get(h.childSessionId) : undefined))

  return [...asking.sort(bySinceAsc), ...waiting.sort(bySinceAsc), ...crewItems.sort(bySinceAsc)]
}

// O número do badge "N no box": sessões da fila, crew fora (tem badge próprio no dock).
export function attentionSessionCount(queue: AttentionItem[]): number {
  return queue.filter((i) => i.kind === 'session').length
}

// Índice do próximo item a partir do cursor, com wrap. Sem cursor (ou cursor que
// saiu da fila), entra pela ponta de onde a tecla veio.
export function stepAttention(
  keys: string[],
  cursorKey: string | null,
  delta: 1 | -1,
): number | null {
  if (keys.length === 0) return null
  const i = cursorKey ? keys.indexOf(cursorKey) : -1
  if (i < 0) return delta > 0 ? 0 : keys.length - 1
  return (i + delta + keys.length) % keys.length
}

export interface StoredAttentionCursor {
  key: string
  // Sessões ativas por onde esta sequência de pulos passou, incluindo a de origem.
  // O dockview só ativa a aba alguns renders depois do pulo: com Alt+A rápido o
  // store fica para trás (B→A→B) e qualquer uma delas ainda é "o usuário não saiu".
  trail: Array<string | null>
}

export interface AttentionStep {
  index: number
  cursor: StoredAttentionCursor
}

// Sem pulo a seguir, entra pela ponta (a mais antiga no Alt+A), pulando a sessão
// ativa se é ela que está lá.
function entryIndex(keys: string[], activeKey: string | null, delta: 1 | -1): number | null {
  const entry = stepAttention(keys, null, delta)
  if (entry != null && keys.length > 1 && keys[entry] === activeKey) {
    return stepAttention(keys, activeKey, delta)
  }
  return entry
}

// O próximo pulo: segue o último enquanto a sessão ativa está na trilha dele; se
// o usuário foi pra outra sessão por fora (ou o item saiu da fila), recomeça.
export function planAttentionStep(
  queue: AttentionItem[],
  stored: StoredAttentionCursor | null,
  activeCc: string | null,
  delta: 1 | -1,
): AttentionStep | null {
  const keys = queue.map((i) => i.key)
  const follows = stored !== null && stored.trail.includes(activeCc) && keys.includes(stored.key)
  const activeKey =
    queue.find((i) => i.kind === 'session' && i.ccSessionId === activeCc)?.key ?? null
  const index = follows
    ? stepAttention(keys, stored.key, delta)
    : entryIndex(keys, activeKey, delta)
  if (index == null) return null
  const item = queue[index]
  const trail = follows ? stored.trail : [activeCc]
  // Crew abre o peek sem trocar a aba: a ativa continua a de antes.
  const landed = item.kind === 'session' ? item.ccSessionId : (trail[trail.length - 1] ?? null)
  return {
    index,
    cursor: { key: item.key, trail: trail.includes(landed) ? trail : [...trail, landed] },
  }
}

export type BackTarget = { kind: 'session'; ccSessionId: string } | { kind: 'crew'; handoffId: string }

// Alt+Q: a sessão focada antes da atual, entre as que o usuário VÊ. Filha do dock
// sem aba volta pelo quick look — abrir pane pra ela a tiraria do dock sem ele
// pedir. Sessão viva que não aparece em lugar nenhum não é alvo.
export function planBackTarget(
  order: string[],
  activeCc: string | null,
  input: AttentionQueueInput,
): BackTarget | null {
  const visible = new Set(input.visibleSessions.map((s) => s.ccSessionId))
  const liveById = new Map(input.liveSessions.map((s) => [s.id, s]))
  const crewByCc = new Map<string, string>()
  for (const h of dockCrew(input.handoffs)) {
    const cc = h.childSessionId ? liveById.get(h.childSessionId)?.ccSessionId : null
    if (cc && !visible.has(cc)) crewByCc.set(cc, h.id)
  }
  const reachable = new Set([...visible, ...crewByCc.keys()])
  const target = mruBackTarget(order, activeCc, reachable)
  if (!target) return null
  const handoffId = crewByCc.get(target)
  return handoffId ? { kind: 'crew', handoffId } : { kind: 'session', ccSessionId: target }
}
