import type { ChatMessage, SessionActivity } from '../../../../shared/types/ipc'

// Eco otimista de uma mensagem do usuário enviada pelo composer em modo chat. O
// transcript de disco tem atraso (o claude grava o turno do usuário no JSONL
// alguns instantes depois do submit), então mostramos a bolha na hora e a
// "reconciliamos" quando o disco alcança.
export interface Echo {
  text: string
  // Contagem de mensagens do usuário NO DISCO a partir da qual este eco é
  // considerado já gravado (e some). Contamos em vez de casar texto: assim
  // histórico com texto idêntico não resolve o eco por engano, e envios rápidos
  // em sequência não resolvem uns aos outros.
  resolveAt: number
}

// Estado de tela do Chat View. Distingue "aguardando o JSONL nascer" (sessão
// recém-spawnada, transitório — o watcher recupera quando o arquivo aparece) do
// "vazio real" (arquivo existe, 0 mensagens renderizáveis).
export type ChatViewState = 'loading' | 'waiting' | 'empty' | 'ready'

// PURA: a decisão de estado fica testável sem React. messageCount inclui ecos
// otimistas — qualquer coisa a renderar ganha de loading/waiting/empty.
export function resolveChatViewState(input: {
  loading: boolean
  transcriptExists: boolean
  messageCount: number
}): ChatViewState {
  if (input.messageCount > 0) return 'ready'
  if (input.loading) return 'loading'
  if (!input.transcriptExists) return 'waiting'
  return 'empty'
}

// Conta o que o HUMANO enviou pelo composer: bolhas de user e slash commands
// (que o parser classifica como 'command', não 'user'). Sem contar 'command', o
// eco otimista de um "/goal …" digitado nunca reconciliaria com o disco.
export function countUserMessages(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) if (m.kind === 'user' || m.kind === 'command') n++
  return n
}

// Resolução dos momentos interativos: liga cada ask_user_question/exit_plan_mode
// (por id) à sua resposta/decisão posterior (por forId). A UI usa isso pra mostrar
// a opção escolhida / o estado de aprovação no MESMO card e pra não renderizar a
// mensagem de resposta solta.
export interface InteractiveResolution {
  answers: Map<string, Record<string, string>> // id da pergunta → mapa pergunta→opção
  plans: Map<string, boolean> // id do plano → aprovado
  subagents: Map<string, boolean> // id do subagente → terminou com erro
}

export function resolveInteractive(messages: ChatMessage[]): InteractiveResolution {
  const answers = new Map<string, Record<string, string>>()
  const plans = new Map<string, boolean>()
  const subagents = new Map<string, boolean>()
  for (const m of messages) {
    if (m.kind === 'ask_user_question_answered') answers.set(m.forId, m.answers)
    else if (m.kind === 'plan_decision') plans.set(m.forId, m.approved)
    else if (m.kind === 'subagent_result') subagents.set(m.forId, m.isError)
  }
  return { answers, plans, subagents }
}

// Momento interativo aguardando o usuário: kind + id do tool_use. O id permite à
// UI saber QUAL card pode responder por clique (guard: só o card pendente).
export interface PendingInteractive {
  kind: 'question' | 'plan'
  id: string
}

// Preenchido quando o ÚLTIMO momento interativo do transcript ainda não tem
// resposta/decisão (claude aguardando o usuário); null caso contrário. Espelha
// o critério "tool_use de AskUserQuestion/ExitPlanMode sem tool_result depois".
export function pendingInteractive(messages: ChatMessage[]): PendingInteractive | null {
  const { answers, plans } = resolveInteractive(messages)
  let pending: PendingInteractive | null = null
  for (const m of messages) {
    if (m.kind === 'ask_user_question')
      pending = answers.has(m.id) ? null : { kind: 'question', id: m.id }
    else if (m.kind === 'exit_plan_mode')
      pending = plans.has(m.id) ? null : { kind: 'plan', id: m.id }
  }
  return pending
}

// Decisão pura: mostrar o banner genérico de "aguardando no terminal"? Verdadeiro
// quando a sessão está 'waiting' MAS não há um momento interativo conhecido
// (pergunta/plano) já renderizado como card. Ou seja: é uma espera que o chat NÃO
// consegue representar a partir do transcript — provável prompt de permissão y/n
// ou menu TTY que só existe no PTY. O banner do R5 (pendingInteractive) tem
// precedência; este é o fallback que direciona o usuário ao terminal.
export function showTerminalWaitBanner(input: {
  status: SessionActivity['status'] | undefined
  pending: PendingInteractive | null
  // Quem hospeda o chat já mostra um painel que responde o menu (quick look da
  // filha): mandar abrir o terminal contradiria os botões ao lado.
  answeredElsewhere?: boolean
}): boolean {
  return input.status === 'waiting' && input.pending === null && !input.answeredElsewhere
}

// resolveAt de um eco novo: resolve quando a contagem de usuário no disco chega a
// (contagem atual + ecos já pendentes + 1). O +pendingCount evita que o disco de
// um envio resolva o eco de outro envio ainda não gravado.
export function nextResolveAt(diskUserCount: number, pendingCount: number): number {
  return diskUserCount + pendingCount + 1
}

// Ecos ainda não resolvidos dada a contagem de usuário atual no disco.
export function pendingEchoes(echoes: Echo[], diskUserCount: number): Echo[] {
  return echoes.filter((e) => diskUserCount < e.resolveAt)
}

// Stick-to-bottom: só consideramos "no fim" (e portanto auto-scrollamos no
// próximo conteúdo) se a distância até o fundo está dentro de uma folga pequena.
// Folga absorve subpixels e o crescimento de uma linha em digitação.
export function isAtBottom(
  m: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 24,
): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold
}
