import { ACTIVE_HANDOFF_STATUSES, childSessionIds } from '@/store/handoffsStore'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

// Domínio da "equipe": as sessões-filhas de handoffs ativos. Elas ficam FORA da
// strip/switcher (ver useGlobalSessions) e vivem no Crew Dock. Tudo aqui é puro —
// sem store, sem IPC — pra ser testável e reusável entre dock e inbox.

export interface AliasParts {
  // Nome humano do papel, capitalizado ("mauricio" → "Mauricio").
  name: string
  // Escopo derivado da task ("auth-refactor"), null quando o alias é só o nome.
  scope: string | null
}

// Alias `<nome>-<escopo>` (ver electron/main/services/handoff/alias.ts): o nome é
// sempre a primeira palavra do kebab; o resto (incluindo sufixo numérico de
// desambiguação) é o escopo. Null quando não há alias — handoff legado ou filha
// que ainda não subiu.
export function splitAlias(alias: string | null | undefined): AliasParts | null {
  const raw = alias?.trim()
  if (!raw) return null
  const [first, ...rest] = raw.split('-').filter(Boolean)
  if (!first) return null
  return {
    name: first.charAt(0).toUpperCase() + first.slice(1),
    scope: rest.join('-') || null,
  }
}

// Handoffs cuja filha está sob a alçada do dock (mesmo conjunto que a strip
// esconde). Sem eles o dock não existe — nada delegado, nenhum pixel gasto.
export function activeCrew(handoffs: Handoff[]): Handoff[] {
  return handoffs.filter((h) => ACTIVE_HANDOFF_STATUSES.has(h.status))
}

// Endereço das filhas do dock no vocabulário das notificações: o evento do main
// vem com ccSessionId, e o dock raciocina em Session.id. Serve pra calar o aviso
// que o dock já dá (ver NotificationToast). Puro → testável.
export function crewCcSessionIds(
  handoffs: Handoff[],
  liveSessions: LiveSessionInfo[],
): Set<string> {
  const childIds = childSessionIds(handoffs)
  const cc = new Set<string>()
  for (const s of liveSessions) {
    if (childIds.has(s.id)) cc.add(s.ccSessionId)
  }
  return cc
}

// A filha está esperando a mãe? Duas fontes: o status vivo do PTY ('waiting') e o
// needs_input do handoff (pergunta aberta via handoff_ask). Qualquer uma basta.
export function crewNeedsAttention(handoff: Handoff, live: LiveSessionInfo | undefined): boolean {
  if (handoff.status === 'needs_input') return true
  return live?.status === 'waiting'
}

// Quantas filhas estão esperando você. É o gatilho do auto-reveal do dock e o
// número do badge — filhas ficam fora do useWaitingCount (que serve strip/rail).
export function crewAttentionCount(handoffs: Handoff[], liveSessions: LiveSessionInfo[]): number {
  const byId = new Map(liveSessions.map((s) => [s.id, s]))
  let count = 0
  for (const h of activeCrew(handoffs)) {
    const live = h.childSessionId ? byId.get(h.childSessionId) : undefined
    if (crewNeedsAttention(h, live)) count++
  }
  return count
}

// Ordem do dock: quem espera você primeiro; o resto mantém a ordem do store
// (created_at DESC). Sem reordenar por status vivo — só a atenção promove.
export function orderCrew(handoffs: Handoff[], liveSessions: LiveSessionInfo[]): Handoff[] {
  const byId = new Map(liveSessions.map((s) => [s.id, s]))
  const crew = activeCrew(handoffs)
  const attention: Handoff[] = []
  const rest: Handoff[] = []
  for (const h of crew) {
    const live = h.childSessionId ? byId.get(h.childSessionId) : undefined
    if (crewNeedsAttention(h, live)) attention.push(h)
    else rest.push(h)
  }
  return [...attention, ...rest]
}
