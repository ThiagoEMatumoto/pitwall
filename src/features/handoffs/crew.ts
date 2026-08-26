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

// Quem o Crew Dock EXIBE. A pergunta aqui não é "está viva?" (quem responde isso
// é ACTIVE_HANDOFF_STATUSES, que governa quem some da strip), e sim "ainda dá pra
// fazer alguma coisa com ela?". Uma filha interrompida (aba fechada, app
// reiniciado, reconcileStuck) cujo transcript sobreviveu é RETOMÁVEL a um clique —
// sumir do dock nesse instante é justamente perder o único lugar de onde ela
// voltaria. Ela sai por conclusão/falha ou por dispensa manual.
//
// dismissedAt manda sobre tudo, inclusive sobre filha ativa: dispensar é um pedido
// explícito de "tira isso da minha frente", e ele vale enquanto o carimbo existir.
//
// É por isso que dismissedAt também é lido do OUTRO lado (childSessionIds, no
// handoffsStore, e isActiveCrewChild, no main): esta é a ÚNICA lista onde um card
// dispensado deixa de aparecer, e a INVARIANTE é que um handoff com filha viva
// nunca esteja invisível em todas as superfícies ao mesmo tempo. Sumir daqui
// obriga a sessão a voltar pra strip/switcher — dispensar é arquivar o card, não
// sumir com a filha.
//
// O que dockCrew NÃO faz é mexer no gate de status: uma filha interrompida
// continua no dock (dá pra retomar) sem por isso ser escondida da strip — ela nem
// tem PTY pra esconder de lugar nenhum.
export function dockCrew(handoffs: Handoff[]): Handoff[] {
  return handoffs.filter((h) => {
    if (h.dismissedAt != null) return false
    if (ACTIVE_HANDOFF_STATUSES.has(h.status)) return true
    return h.status === 'interrupted' && h.resumable
  })
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

// A filha JÁ retomou depois de perguntar? O needs_input só é limpo por
// handoff_message (a caixa do app) — resposta entregue fora do app (mensagem
// peer/SendMessage do MCP) o main não observa, e a pergunta fica pendente no
// banco pra sempre. O sinal honesto é o relógio: um handoff_progress POSTERIOR à
// pergunta só existe porque a filha voltou a trabalhar. É o mesmo critério que a
// description do handoff_result já documenta ("a needs_input whose currentStep
// keeps advancing means the child already got your answer off-band").
//
// A pergunta NÃO é apagada — nem daqui, nem do banco (handoff_progress parou de
// apagá-la de propósito: a filha limpava o próprio pedido antes da mãe ver e 4 de
// 12 perguntas se perdiam). O que muda é só o ALARME, que passa a respeitar a
// evidência de retomada.
export function crewResumedAfterQuestion(handoff: Handoff): boolean {
  if (handoff.status !== 'needs_input') return false
  const asked = handoff.questionAskedAt
  const stepped = handoff.stepUpdatedAt
  if (asked == null || stepped == null) return false
  return stepped > asked
}

// A filha está esperando a mãe? Duas fontes: o status vivo do PTY ('waiting') e o
// needs_input do handoff (pergunta aberta via handoff_ask).
//
// O PTY vem primeiro porque é testemunha de primeira mão: parado num prompt, ela
// espera — mesmo com progresso registrado depois. O needs_input é registro, e
// registro vence só enquanto não há evidência de retomada.
export function crewNeedsAttention(handoff: Handoff, live: LiveSessionInfo | undefined): boolean {
  if (live?.status === 'waiting') return true
  if (handoff.status === 'needs_input') return !crewResumedAfterQuestion(handoff)
  return false
}

// Quantas filhas estão esperando você. É o gatilho do auto-reveal do dock e o
// número do badge — filhas ficam fora do useWaitingCount (que serve strip/rail).
//
// Itera dockCrew, a MESMA lista que o painel renderiza (e não o conjunto dos
// vivos): um badge que conta quem o dock não mostra vira um "1!" que o usuário
// não consegue zerar clicando em nada — não há card onde responder. Badge e lista
// têm que concordar sempre, então a fonte é uma só.
export function crewAttentionCount(handoffs: Handoff[], liveSessions: LiveSessionInfo[]): number {
  const byId = new Map(liveSessions.map((s) => [s.id, s]))
  let count = 0
  for (const h of dockCrew(handoffs)) {
    const live = h.childSessionId ? byId.get(h.childSessionId) : undefined
    if (crewNeedsAttention(h, live)) count++
  }
  return count
}

// Referência mínima de pane aberta (estrutural, pra não importar o appStore aqui).
export interface OpenPaneRef {
  session: { ccSessionId: string | null }
}

// Onde o terminal desta filha deve aparecer quando pedem "abrir terminal".
//
// 'overlay' é o default: o terminal abre DENTRO do quick look, em janela, sem
// promover a filha a pane — assim "só vou dar uma olhada" não põe o botão de
// encerrar a sessão a um clique de distância.
// 'pane' quando ela já tem uma aba aberta: dois xterms na MESMA PTY disputariam
// o sessionsApi.resize (o último a medir manda) e a TUI refluiria na cara de
// quem já estava trabalhando nela. Com aba aberta, o terminal dela mora lá.
// 'none' sem sessão viva — não há PTY a que anexar.
export function crewTerminalTarget(
  live: LiveSessionInfo | null | undefined,
  openPanes: OpenPaneRef[],
): 'pane' | 'overlay' | 'none' {
  if (!live) return 'none'
  return openPanes.some((p) => p.session.ccSessionId === live.ccSessionId) ? 'pane' : 'overlay'
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

// Pra onde o cursor do teclado pousa depois de dispensar o card `id`. Calculado
// ANTES da dispensa, sobre a lista que ainda contém ele: descer é o padrão (a
// leitura continua de cima pra baixo), mas no ÚLTIMO card descer clamparia
// justamente no que está saindo — aí sobe pro anterior. Null quando ele era o
// único: a lista fica vazia, o dock desmonta e não há onde pousar.
export function crewFocusAfterDismiss(ids: string[], id: string): string | null {
  const next = stepCrewFocus(ids, id, 1)
  if (next && next !== id) return next
  const prev = stepCrewFocus(ids, id, -1)
  return prev && prev !== id ? prev : null
}

// Ordem do dock: quem espera você primeiro; o resto mantém a ordem do store
// (created_at DESC). Sem reordenar por status vivo — só a atenção promove.
export function orderCrew(handoffs: Handoff[], liveSessions: LiveSessionInfo[]): Handoff[] {
  const byId = new Map(liveSessions.map((s) => [s.id, s]))
  const crew = dockCrew(handoffs)
  const attention: Handoff[] = []
  const rest: Handoff[] = []
  for (const h of crew) {
    const live = h.childSessionId ? byId.get(h.childSessionId) : undefined
    if (crewNeedsAttention(h, live)) attention.push(h)
    else rest.push(h)
  }
  return [...attention, ...rest]
}
