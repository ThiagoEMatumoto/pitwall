import { dockCrew } from '@/features/handoffs/crew'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'
import { humanQueue, isAskItem } from '../../../shared/attention/selectors'
import type {
  AttentionKind,
  AttentionItem as ProjectedAttentionItem,
} from '../../../shared/types/attention'
import { mruBackTarget } from '@/store/session-mru-store'
import { liveSessionLabel } from './session-label'

// Fila de atenção: "quem precisa de você, em que ordem". QUEM entra e em que ordem
// vem da projeção do main (attention:list); aqui só se decide ONDE cada item abre
// (aba ou quick look). É a MESMA lista do badge "N no box", do Crew Dock e do Ctrl+`.

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
  // Kind da projeção (o HUD pode distinguir failed/interrupted; por ora só carrega).
  projectedKind?: AttentionKind
}

export interface SessionSurfacesInput {
  // Sessões que o usuário vê na barra/switcher (useVisibleLiveSessions): filha do
  // dock sem aba aberta NÃO está aqui — ela entra pela crew.
  visibleSessions: LiveSessionInfo[]
  liveSessions: LiveSessionInfo[]
  handoffs: Handoff[]
}

export interface AttentionQueueInput extends SessionSurfacesInput {
  attention: ProjectedAttentionItem[]
}

function reasonOf(kind: AttentionKind): AttentionReason {
  if (isAskItem({ kind })) return 'handoff-input'
  if (kind === 'session_menu') return 'waiting'
  return 'crew'
}

// O porquê vem do mesmo item: o menu reconhecido na tela ou a pergunta do handoff.
function detailOf(item: ProjectedAttentionItem): AttentionDetail | undefined {
  if (isAskItem(item)) return 'handoff-input'
  if (item.menuReason && item.menuReason !== 'unrecognized') return item.menuReason
  return undefined
}

function sessionItem(s: LiveSessionInfo, item: ProjectedAttentionItem): AttentionItem {
  return {
    key: `session:${s.id}`,
    kind: 'session',
    sessionId: s.id,
    ccSessionId: s.ccSessionId,
    ...(item.handoffId ? { handoffId: item.handoffId } : {}),
    projectName: s.projectName,
    title: liveSessionLabel(s),
    reason: reasonOf(item.kind),
    detail: detailOf(item),
    since: item.createdAt,
    liveStatus: s.status,
    projectedKind: item.kind,
  }
}

function crewItem(
  h: Handoff,
  liveChild: LiveSessionInfo | undefined,
  item: ProjectedAttentionItem,
): AttentionItem {
  return {
    key: `crew:${h.id}`,
    kind: 'crew',
    sessionId: h.childSessionId,
    ccSessionId: liveChild?.ccSessionId ?? null,
    handoffId: h.id,
    projectName: liveChild?.projectName ?? h.targetRepoLabel,
    title: liveChild?.title ?? liveChild?.name ?? h.task,
    reason: reasonOf(item.kind),
    detail: detailOf(item),
    since: item.createdAt,
    liveStatus: liveChild?.status ?? null,
    projectedKind: item.kind,
  }
}

// Mapeia humanQueue(attention) mantendo a ordem da projeção. Sessão visível abre
// aba; filha do dock (sem aba) abre o quick look. Item sem sessão visível e sem
// handoff carregado é a corrida entre attention:changed e handoff:updated: sai
// agora e volta no próximo push. Dedup pela chave: o primeiro (mais grave) vence.
export function buildAttentionQueue(input: AttentionQueueInput): AttentionItem[] {
  const visibleById = new Map(input.visibleSessions.map((s) => [s.id, s]))
  const liveById = new Map(input.liveSessions.map((s) => [s.id, s]))
  const handoffById = new Map(input.handoffs.map((h) => [h.id, h]))
  const out: AttentionItem[] = []
  const taken = new Set<string>()
  for (const item of humanQueue(input.attention)) {
    const visible = item.sessionId ? visibleById.get(item.sessionId) : undefined
    const h = item.handoffId ? handoffById.get(item.handoffId) : undefined
    const entry = visible
      ? sessionItem(visible, item)
      : h
        ? crewItem(h, h.childSessionId ? liveById.get(h.childSessionId) : undefined, item)
        : null
    if (!entry || taken.has(entry.key)) continue
    taken.add(entry.key)
    out.push(entry)
  }
  return out
}

// O número do badge "N no box": a fila inteira (sessões, filhas, falhas).
export function attentionCount(queue: AttentionItem[]): number {
  return queue.length
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

export type BackTarget =
  { kind: 'session'; ccSessionId: string } | { kind: 'crew'; handoffId: string }

// Alt+Q: a sessão focada antes da atual, entre as que o usuário VÊ. Filha do dock
// sem aba volta pelo quick look — abrir pane pra ela a tiraria do dock sem ele
// pedir. Sessão viva que não aparece em lugar nenhum não é alvo.
export function planBackTarget(
  order: string[],
  activeCc: string | null,
  input: SessionSurfacesInput,
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
