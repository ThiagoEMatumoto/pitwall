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

// Rótulo visível dos nomes do roster (ver ROLE_NAMES em
// electron/main/services/handoff/alias.ts). O alias técnico é kebab sem acento —
// ele é o ENDEREÇO do SendMessage e não pode mudar —, mas na tela o nome da
// pessoa aparece escrito como se escreve.
const DISPLAY_NAMES: Record<string, string> = {
  mauricio: 'Maurício',
  otavio: 'Otávio',
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
    name: DISPLAY_NAMES[first.toLowerCase()] ?? first.charAt(0).toUpperCase() + first.slice(1),
    scope: rest.join('-') || null,
  }
}

// Handoffs cuja filha está sob a alçada do dock (mesmo conjunto que a strip
// esconde). Sem eles o dock não existe — nada delegado, nenhum pixel gasto.
export function activeCrew(handoffs: Handoff[]): Handoff[] {
  return handoffs.filter((h) => ACTIVE_HANDOFF_STATUSES.has(h.status))
}

// Filhas que ficam FORA das superfícies de sessão do usuário (barra, switcher,
// command palette, Home): as de handoff ativo que ainda não têm pane aberta.
// Enquanto só rodam, elas vivem no dock; assim que ele abre o terminal de uma,
// ela vira sessão de primeira classe — com chip na barra e entrada no switcher,
// como qualquer aba aberta — e some de novo quando ele fecha a aba.
export function hiddenCrewSessionIds(
  handoffs: Handoff[],
  liveSessions: LiveSessionInfo[],
  openCcSessionIds: Set<string>,
): Set<string> {
  const childIds = childSessionIds(handoffs)
  const hidden = new Set<string>()
  for (const s of liveSessions) {
    if (childIds.has(s.id) && !openCcSessionIds.has(s.ccSessionId)) hidden.add(s.id)
  }
  return hidden
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

// Card sob foco de teclado depois de a lista mudar (filha entrou, saiu, ou a
// atenção reordenou): segura o card atual se ele sobreviveu, senão cai no
// primeiro. Null só com a lista vazia — aí o dock nem monta.
export function resolveCrewFocus(ids: string[], currentId: string | null): string | null {
  if (ids.length === 0) return null
  if (currentId && ids.includes(currentId)) return currentId
  return ids[0]
}

// Passo do ↑/↓ dentro do dock, sobre a lista JÁ ordenada (orderCrew). Clampa nas
// pontas em vez de dar wrap: a lista é curta e voltar ao topo sozinho desorienta
// mais do que ajuda. Sem foco ainda, entra pela ponta de onde a tecla veio.
export function stepCrewFocus(
  ids: string[],
  currentId: string | null,
  delta: number,
): string | null {
  if (ids.length === 0) return null
  const i = currentId ? ids.indexOf(currentId) : -1
  if (i < 0) return delta > 0 ? ids[0] : ids[ids.length - 1]
  return ids[Math.min(ids.length - 1, Math.max(0, i + delta))]
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
