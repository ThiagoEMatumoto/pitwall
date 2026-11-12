import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CircleSlash,
  CornerDownLeft,
  Eye,
  Moon,
  MoreHorizontal,
  PanelTop,
  Pause,
  Play,
  Send,
  Sun,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu } from '@/components/ui/Menu'
import { handoffsApi, prefsApi } from '@/lib/ipc'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { pendingEndSessionIds, useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import type { PanelTier } from '@/features/sessions/use-panel-tier'
import { TONE_COLOR, cardIndicator, indicatorText } from '@/features/session-canvas/card-indicator'
import { crewResumedAfterQuestion, paneShowsLive, splitAlias } from './crew'
import { endSessionAsked } from './end-child'
import { revealChildOnUserMessage } from './reveal-child'
import { wakeChildIntoTab } from './wake-child'
import type { Handoff, HandoffOutcome, HandoffStatus, LiveSessionInfo } from '../../../shared/types/ipc'

// Card de um handoff: identidade da filha (alias), estado ao vivo, último texto e
// input de resposta. Compartilhado pelo inbox (HandoffsPanel) e pelo Crew Dock —
// o `tier` só decide o que cabe na largura, nunca o comportamento.

const HEARTBEAT_TTL_KEY = 'handoffs.heartbeatTtlHours'
const HEARTBEAT_TTL_DEFAULT = 2

// TTL de heartbeat lido das prefs (inbox e dock usam o mesmo número).
export function useHeartbeatTtl(): number {
  const [ttlHours, setTtlHours] = useState(HEARTBEAT_TTL_DEFAULT)
  useEffect(() => {
    void prefsApi
      .get<number>(HEARTBEAT_TTL_KEY)
      .then((v) => setTtlHours(v ?? HEARTBEAT_TTL_DEFAULT))
  }, [])
  return ttlHours
}

// Um handoff `running` está "sem heartbeat" se o último sinal de progresso é mais
// antigo que o TTL. Usa step_updated_at (último handoff_progress) e cai pra
// updated_at quando a filha nunca reportou passo. Puro → testável.
export function isStale(handoff: Handoff, ttlHours: number, now: number): boolean {
  if (handoff.status !== 'running') return false
  const last = handoff.stepUpdatedAt ?? handoff.updatedAt
  return now - last > ttlHours * 3_600_000
}

// "há Xh" arredondado pra baixo (mínimo 1h, já que só chamamos quando stale).
export function staleLabel(handoff: Handoff, now: number): string {
  const last = handoff.stepUpdatedAt ?? handoff.updatedAt
  const hours = Math.max(1, Math.floor((now - last) / 3_600_000))
  return `sem progresso há ${hours}h`
}

// "há Xs / Xmin / Xh" pro último sinal de atividade da filha (reusa a escala do
// Terminal). Puro → testável. Null se nunca houve atividade.
export function liveActivityLabel(at: number | null, now: number): string | null {
  if (at == null) return null
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `há ${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m}min`
  const h = Math.round(m / 60)
  return `há ${h}h`
}

// Tokens de contexto compactos: "128k ctx" / "12k ctx" / "900 ctx". Null se ausente.
export function contextLabel(tokens: LiveSessionInfo['tokens']): string | null {
  const ctx = tokens?.context
  if (ctx == null) return null
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k ctx`
  return `${ctx} ctx`
}

// Liveness da sessão-filha viva. `undefined` = filha não está mais no
// liveSessions (PTY encerrou). O tom vem do MESMO cardIndicator do mapa: o dock
// dizia "aguardando você" em âmbar para a filha que o cartão chamava de "pronto"
// (fim de turno), e as duas superfícies não podem divergir. Puro → testável.
export interface LiveBadge {
  label: string
  color: string
  // Precisa de você (ou encerrou): pede destaque/ação no card.
  attention: boolean
}

// Quem o card mostra como filha. Depois do bastão de uma FILHA o handoff já
// aponta pra sucessora, mas ela pode ainda não ter chegado ao liveSessions: sem
// isto o card caía em "→ <repo> · filha encerrou" no meio de uma troca que deu
// certo. Enquanto ela não aparece, vale o apelido que a antecessora carregava
// (a sucessora herda o mesmo endereço) e o selo diz que o bastão está passando.
// A troca dura segundos: o relink (markRunning) grava updated_at no bastão. Depois
// desta janela a sucessora ausente não está "assumindo" — falhou ou encerrou.
export const SUCCESSOR_PENDING_MS = 60_000

export function childIdentity(
  handoff: Pick<Handoff, 'childSessionId' | 'predecessorSessionId' | 'updatedAt'>,
  liveSessions: readonly Pick<LiveSessionInfo, 'id' | 'title' | 'status'>[],
  now: number = Date.now(),
): { title: string | null; successorPending: boolean } {
  const child = handoff.childSessionId
    ? liveSessions.find((s) => s.id === handoff.childSessionId)
    : undefined
  if (child) return { title: child.title ?? null, successorPending: false }
  if (
    !handoff.predecessorSessionId ||
    !handoff.childSessionId ||
    now - handoff.updatedAt > SUCCESSOR_PENDING_MS
  ) {
    return { title: null, successorPending: false }
  }
  const predecessor = liveSessions.find((s) => s.id === handoff.predecessorSessionId)
  return { title: predecessor?.title ?? null, successorPending: true }
}

// O processo da filha existe? Fora da lista viva a PTY já morreu; 'ended' é o
// mesmo fato, visto um tick antes de a lista recarregar.
export function childProcessAlive(
  live: Pick<LiveSessionInfo, 'status'> | null | undefined,
): boolean {
  return !!live && live.status !== 'ended'
}

// Arquivar o card (carimba dismissed_at) só com o processo morto. Com a filha
// viva ele tirava o card e deixava a sessão rodando como sessão comum, que no
// próximo resume subia sem apelido nem permissões de filha (o relink exige
// dismissed_at IS NULL): prometia arquivar e, na prática, soltava. Quem tira a
// filha viva da frente é Minimizar ou Encerrar.
export function canArchiveCard(
  handoff: Pick<Handoff, 'dismissedAt' | 'childSessionId'>,
  child: Pick<LiveSessionInfo, 'status'> | null | undefined,
): boolean {
  if (handoff.dismissedAt != null || childProcessAlive(child)) return false
  // Encerrar com o Desfazer em aberto: a filha já saiu da lista viva, mas a PTY
  // só morre quando a janela expira. Arquivar ali e desfazer devolvia a filha
  // viva a um card arquivado.
  return !handoff.childSessionId || !pendingEndSessionIds().has(handoff.childSessionId)
}

// "Forçar falha" só para o aprovado cuja filha nunca subiu: ali não há processo
// para Encerrar. Em running ele era um segundo jeito de matar a filha, que a
// deixava failed (sem retomada) em vez de interrupted.
export function canForceFail(handoff: Pick<Handoff, 'status'>): boolean {
  return handoff.status === 'approved'
}

export const SUCCESSOR_PENDING_BADGE: LiveBadge = {
  label: 'assumindo o bastão',
  color: 'var(--color-info)',
  attention: false,
}

// A concluída que hibernou não tem processo, mas não caiu: apagado, sem alarme.
export const ASLEEP_BADGE: LiveBadge = {
  label: 'dormindo',
  color: 'var(--color-text-dim)',
  attention: false,
}

export function liveBadgeFor(
  live: Pick<LiveSessionInfo, 'status' | 'attentionReason'> | undefined,
  needsInput = false,
): LiveBadge {
  if (!live || live.status === 'ended') {
    return { label: 'filha encerrou', color: 'var(--color-danger)', attention: true }
  }
  // Rótulo da tela da filha, não contagem: o badge/ordem do dock já saem da fila
  // única. TODO(attention-projection): ler o item da fila em vez da tela.
  const screenWaiting = live.status === 'waiting' && live.attentionReason !== 'turn-end'
  const ind = cardIndicator({
    status: live.status,
    graphAttention: needsInput ? 'handoff-input' : screenWaiting ? 'waiting' : null,
    detail: live.attentionReason,
    lastActivityAt: null,
    workingSince: null,
  })
  return {
    label: indicatorText(ind, 0),
    color: TONE_COLOR[ind.tone],
    attention: ind.tone === 'needs-you',
  }
}

// A trilha colapsada é o resumo de 40px do dock: cor = estado. A filha PAUSADA
// (interrompida mas retomável) fica apagada em vez do âmbar de 'interrupted' —
// ela não está pedindo nada, só esperando você mandar continuar; âmbar ali seria
// o mesmo alarme de quem realmente espera resposta. No bastão de uma filha a
// sucessora pode ainda não estar em liveSessions: vale childIdentity, como no card.
export function crewDotColor(
  handoff: Handoff,
  live: LiveSessionInfo | undefined,
  liveSessions: readonly LiveSessionInfo[],
  now: number = Date.now(),
): string {
  if (live) return liveBadgeFor(live).color
  if (childIdentity(handoff, liveSessions, now).successorPending) return SUCCESSOR_PENDING_BADGE.color
  if (handoff.status === 'interrupted' && handoff.resumable) return 'var(--color-text-dim)'
  if (handoff.childAsleep) return ASLEEP_BADGE.color
  return STATUS_COLOR[handoff.status]
}

export function crewDotTitle(
  handoff: Handoff,
  live: LiveSessionInfo | undefined,
  liveSessions: readonly LiveSessionInfo[],
  now: number = Date.now(),
): string {
  const identity = childIdentity(handoff, liveSessions, now)
  const title = live?.title ?? identity.title
  const alias = splitAlias(title)
  const who = title ?? handoff.targetRepoLabel ?? handoff.targetRepoId
  const scope = alias ? ` (${alias.name})` : ''
  const state = live
    ? liveBadgeFor(live).label
    : identity.successorPending
      ? SUCCESSOR_PENDING_BADGE.label
      : handoff.status === 'interrupted' && handoff.resumable
        ? 'pausada, dá pra retomar'
        : handoff.childAsleep
          ? 'dormindo, dá pra acordar'
          : 'despachando'
  return `${who}${scope} — ${state}`
}

// Inicial da filha no trilho recolhido da Equipe (o ponto sozinho não dizia quem
// era): a do apelido ("otavio-parte-c1" → "O"), senão a do título ou do repo.
export function crewDotInitial(
  handoff: Handoff,
  live: LiveSessionInfo | undefined,
  liveSessions: readonly LiveSessionInfo[],
  now: number = Date.now(),
): string {
  const title = live?.title ?? childIdentity(handoff, liveSessions, now).title
  const who = splitAlias(title)?.name ?? title ?? handoff.targetRepoLabel ?? handoff.targetRepoId ?? ''
  return (who.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
}

export const STATUS_LABEL: Record<HandoffStatus, string> = {
  pending: 'Pendente',
  approved: 'Aprovado',
  running: 'Em andamento',
  needs_input: 'Pergunta pendente',
  done: 'Concluído',
  rejected: 'Rejeitado',
  failed: 'Falhou',
  interrupted: 'Interrompido',
}

// status → token de cor (texto + borda + fundo translúcido). interrupted usa o
// tom de aviso (recuperável, não é erro real como failed).
export const STATUS_COLOR: Record<HandoffStatus, string> = {
  pending: 'var(--color-warning)',
  running: 'var(--color-info)',
  needs_input: TONE_COLOR['needs-you'],
  done: 'var(--color-success)',
  failed: 'var(--color-danger)',
  rejected: 'var(--color-text-dim)',
  approved: 'var(--color-accent)',
  interrupted: 'var(--color-warning)',
}

// `paused` é o 'interrupted' que AINDA dá pra retomar (transcript no disco). Ele
// não é desfecho e não pede socorro: em âmbar e rotulado "Interrompido" ele lia
// como falha e convidava a dispensar o card — que é exatamente a filha que a gente
// quer manter à mão. Em tom apagado ele diz o que é: parada, esperando você
// mandar continuar (o botão "Retomar", em accent, é quem carrega a ação).
// `rest` é o mesmo tom apagado com outro nome: a filha que dorme ("Dormindo") e a
// que o usuário encerrou ("Encerrada por você") também só esperam um clique.
export function StatusBadge({
  status,
  paused = false,
  rest,
}: {
  status: HandoffStatus
  paused?: boolean
  rest?: string
}) {
  const color = paused || rest ? 'var(--color-text-dim)' : STATUS_COLOR[status]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {rest ?? (paused ? 'Pausada' : STATUS_LABEL[status])}
    </span>
  )
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

interface Props {
  handoff: Handoff
  ttlHours: number
  // Largura disponível no container (dock estreito vs inbox largo).
  tier?: PanelTier
  // Abre o quick look (CrewPeek) desta filha. Só o dock passa — no inbox, que já
  // é uma área inteira, o overlay não acrescentaria nada.
  onPeek?: () => void
}

export function HandoffCard({ handoff, ttlHours, tier = 'wide', onPeek }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [failing, setFailing] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [rating, setRating] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [waking, setWaking] = useState(false)
  const [wakeError, setWakeError] = useState<string | null>(null)
  const liveSessions = useAppStore((s) => s.liveSessions)
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const load = useHandoffsStore((s) => s.load)
  const dismissHandoff = useHandoffsStore((s) => s.dismiss)
  const repoLabel = handoff.targetRepoLabel ?? handoff.targetRepoId
  const hasDetail =
    (handoff.status === 'done' && !!handoff.summary) ||
    (handoff.status === 'failed' && !!handoff.error) ||
    (handoff.status === 'interrupted' && !!handoff.error)

  // Aperto de largura. 'wide' (inbox) mantém a coluna lateral com data + ações.
  // Abaixo disso — o dock, a 340px — a coluna lateral custaria ~210px dos ~300
  // úteis e o texto sobraria em tiras de duas palavras: as ações descem pro
  // rodapé do card e a largura inteira volta pro conteúdo. 'narrow' ainda
  // degrada rótulo pra ícone. Nada de comportamento muda — só o que cabe.
  const compact = tier !== 'wide'
  const tight = tier === 'narrow'

  // Sem heartbeat: só faz sentido pra running. Calculado no render — a lista
  // recarrega periodicamente via watch, mantendo o "há Xh" razoavelmente fresco.
  const stale = isStale(handoff, ttlHours, Date.now())

  // Quick look: só faz sentido com filha spawnada (é o transcript DELA que o
  // overlay renderiza). Continua valendo com a PTY morta — ler a conversa de uma
  // filha que acabou de cair é justamente quando mais se quer.
  const canPeek = !!onPeek && !!handoff.childSessionId

  // Recovery manual: força failed via IPC handoffs:fail (ver canForceFail).
  const forceFailable = canForceFail(handoff)

  // Desvincular: a operação INVERSA da adoção — corta o vínculo mãe→filha e
  // devolve a sessão à condição de sessão normal. Só faz sentido com filha
  // atrelada; sem childSessionId não há vínculo pra cortar. Ao contrário de
  // "Arquivar card", NÃO é bloqueado com a filha viva: desvincular não cria órfão
  // invisível, é justamente o contrário — a sessão volta a aparecer na barra e no
  // switcher.
  const canRelease = handoff.childSessionId != null

  // Feedback de utilidade: só faz sentido pra handoffs concluídos. Persiste via
  // IPC e recarrega pra refletir o outcome marcado. Idempotente no backend.
  const canRate = handoff.status === 'done'

  // Retomar: só pra handoffs interrompidos (filha morreu sem erro real) cujo
  // transcript ainda existe no disco — senão não há de onde retomar via
  // `claude --resume`. O gate vem PRONTO no handoff (handoff-store.toEntity), no
  // lugar do handoffs:is-resumable que este card disparava por conta própria: é o
  // MESMO critério que decide quem continua no dock, e ler os dois de fontes
  // diferentes deixava o card e a lista discordando por um tick.
  const isInterrupted = handoff.status === 'interrupted'
  const resumable = handoff.resumable
  // Interrompida mas retomável = PAUSADA. O estado terminal de verdade (sem
  // transcript, nada a retomar) segue se lendo como "Interrompido".
  const paused = isInterrupted && resumable

  async function resume() {
    if (resuming) return
    setResuming(true)
    try {
      await handoffsApi.resume(handoff.id)
      await load()
    } catch {
      // O load() seguinte ressincroniza o status. Mantém o botão habilitável pra
      // nova tentativa (a filha pode ter ficado não-resumível nesse meio-tempo).
      setResuming(false)
    }
  }

  // Diferente do Retomar, a falha fica à vista: sem o motivo, "Acordar" que não
  // acorda (transcript apagado, conversa aberta em outro lugar) é um botão morto.
  async function wake() {
    if (waking) return
    setWaking(true)
    setWakeError(null)
    try {
      await wakeChildIntoTab(handoff.id)
    } catch (err) {
      setWakeError(
        err instanceof Error ? ipcErrorMessage(err) : 'Não foi possível acordar a filha.',
      )
    } finally {
      setWaking(false)
      await load()
    }
  }

  async function rate(outcome: HandoffOutcome) {
    if (rating) return
    setRating(true)
    try {
      await handoffsApi.setOutcome({ id: handoff.id, outcome })
      await load()
    } catch {
      // Falha silenciosa: o load() seguinte ressincroniza. Não bloqueia a UI.
    } finally {
      setRating(false)
    }
  }

  async function forceFail() {
    if (failing) return
    const ok = window.confirm(
      `Forçar falha deste handoff para "${repoLabel}"? Ele foi aprovado mas a filha não subiu; o handoff vira "Falhou".`,
    )
    if (!ok) return
    setFailing(true)
    try {
      await handoffsApi.fail({ id: handoff.id, error: 'Falha forçada manualmente pelo usuário' })
      await load()
    } catch {
      setFailing(false)
    }
  }

  async function dismiss() {
    if (dismissing) return
    setDismissing(true)
    try {
      await dismissHandoff(handoff.id)
      await load()
    } catch {
      setDismissing(false)
    }
  }

  // A ressalva das PERMISSÕES vive no confirm, não só no tooltip: uma filha por
  // adoção foi RELANÇADA com HANDOFF_CHILD_SETTINGS_JSON (denylist restritiva, ver
  // electron/main/services/spawn-flags.ts). Isso é flag de exec — soltar mexe no
  // banco, não no processo, então a sessão solta continua com as permissões de
  // filha até ser relançada. O caminho de limpar é o normal: encerrar a sessão e
  // retomá-la pela barra; o sessions:resume NÃO re-vincula depois do release
  // (o relink exige dismissed_at IS NULL), então ela volta como sessão comum.
  //
  // detachChild, e não release(handoff.id): é o MESMO Desvincular do diálogo de
  // vínculo da sessão (ChildLinkDialog), que solta todos os handoffs da conversa.
  // Soltando só este, outro handoff apontando pra mesma conversa a manteria filha
  // depois de "desvinculada".
  async function release() {
    const childSessionId = handoff.childSessionId
    if (releasing || !childSessionId) return
    const ok = window.confirm(
      `Desvincular esta sessão de "${repoLabel}"? Ela deixa de ser filha: volta a aparecer na barra e no switcher como sessão normal, e o handoff vira histórico.\n\nAtenção: a sessão continua rodando com as permissões restritas de filha (isso é do processo, não do registro) — para limpá-las, encerre-a e retome pela barra.`,
    )
    if (!ok) return
    setReleasing(true)
    try {
      await handoffsApi.detachChild(childSessionId)
      await load()
    } catch {
      setReleasing(false)
    }
  }

  // A filha está num PTY enquanto o handoff está vivo (running OU needs_input —
  // needs_input é um estado vivo dentro de running). Só aparece em liveSessions
  // enquanto a PTY existe.
  const isLiveHandoff = handoff.status === 'running' || handoff.status === 'needs_input'
  const childSession = handoff.childSessionId
    ? liveSessions.find((s) => s.id === handoff.childSessionId)
    : undefined
  const childLive = isLiveHandoff ? childSession : undefined
  // O processo, qualquer que seja o status do handoff: é ele que "Abrir na aba"
  // traz para a tela (focusOrOpenSession RE-ATTACHA uma pane à PTY viva, nunca
  // re-spawn/--resume).
  const childProcess = childProcessAlive(childSession) ? childSession : undefined
  // Dormindo de fato: entre a marca e o /exit sair o processo ainda existe.
  const asleep = handoff.childAsleep && !childProcess
  const restLabel = asleep
    ? 'Dormindo'
    : paused && handoff.endedByUserAt != null
      ? 'Encerrada por você'
      : undefined
  const canArchive = canArchiveCard(handoff, childSession)
  // Aba aberta da filha: sem ela não há o que minimizar.
  const childPaneId = useAppStore((s) =>
    childProcess
      ? (s.panes.find((p) => paneShowsLive(p, childProcess))?.paneId ?? null)
      : null,
  )

  // Identidade endereçável da filha: `sessions.title` carrega o alias fixado no
  // spawn (`<nome>-<escopo>`). Nome em destaque, escopo apagado embaixo.
  const identity = childIdentity(handoff, liveSessions)
  const childTitle = childSession?.title ?? identity.title
  const alias = splitAlias(childTitle)

  // Sinais vivos da filha. badge.attention (waiting/ended) ou needs_input pedem
  // realce âmbar. needs_input vence: a mãe pediu input explícito.
  const live = isLiveHandoff
    ? identity.successorPending
      ? SUCCESSOR_PENDING_BADGE
      : liveBadgeFor(childLive)
    : null
  // needs_input com progresso posterior à pergunta = ela já foi respondida fora
  // do app e a filha retomou (ver crewResumedAfterQuestion). O registro segue no
  // banco; o card é que para de anunciar um bloqueio que não existe mais.
  const needsInput = handoff.status === 'needs_input' && !crewResumedAfterQuestion(handoff)
  const highlight = needsInput || (live?.attention ?? false)
  // UM selo por card. Com a filha viva, o estado DELA é o sinal que importa —
  // "aguardando você" diz tudo que "Em andamento" diria, e mais. needs_input
  // vence porque aí quem tem que agir é a mãe. Fora do ar (pendente, concluído,
  // falhou) sobra o status do handoff.
  const liveBadgeWins = !!live && !needsInput
  const lastText = childLive?.lastText?.trim() || null
  const activityLabel = liveActivityLabel(childLive?.lastActivityAt ?? null, Date.now())
  const ctxLabel = contextLabel(childLive?.tokens)

  // Rótulo do botão e placeholder saem da MESMA condição: o campo não pode
  // convidar a "enviar mensagem" enquanto o botão diz "Responder".
  const answering = needsInput || childLive?.status === 'waiting'
  // Input de intervenção: só quando a filha está VIVA (childLive presente). Em
  // needs_input/waiting o tom vira "Responder" com placeholder contextual.
  // Numa superfície apertada (o dock) o campo só aparece quando ela ESPERA você:
  // aí responder rápido é o caminho crítico e vale a altura. Enquanto ela só
  // trabalha, o card é pra ler — falar com ela continua a um Espaço de distância
  // (o peek tem o mesmo campo). Na largura do inbox, o campo fica sempre.
  const canSend = !!childLive && (!compact || answering)
  const sendLabel = answering ? 'Responder' : 'Enviar'
  const sendPlaceholder = needsInput
    ? 'Responder à pergunta da filha…'
    : answering
      ? 'Responder à filha…'
      : 'Enviar mensagem para a filha…'

  async function sendMessage() {
    const text = message.trim()
    if (!text || sending || !childLive) return
    setSending(true)
    setSendError(null)
    try {
      // A aba da filha abre antes do envio, em segundo plano: ir até ela trocaria
      // de área e desmontaria o card do inbox, com o texto e o erro. Envio aceito,
      // o usuário é levado até ela.
      const opened = await revealChildOnUserMessage(handoff.childSessionId, { focus: false })
      await handoffsApi.sendMessage({ id: handoff.id, text })
      setMessage('')
      if (opened) void focusOrOpenSession(opened)
    } catch (err) {
      // Mantém o texto pro usuário não perder o que digitou e mostra o motivo aqui.
      // Filha que morreu entre o render e o envio: o load() abaixo tira o input.
      setSendError(
        err instanceof Error ? ipcErrorMessage(err) : 'Não foi possível entregar a mensagem.',
      )
    } finally {
      setSending(false)
      await load()
    }
  }

  // O pedido aberto da filha. Quando existe, ele É a linha do "agora" — vem
  // antes do briefing, que desce pra linha secundária.
  const question = needsInput ? handoff.pendingQuestion : null

  // Cluster de ações. Mora na coluna lateral no inbox e no rodapé do card no
  // dock — mesmo JSX, dois lugares, pra não espremer o texto onde é estreito.
  const hasActions = !!(
    childProcess ||
    forceFailable ||
    canArchive ||
    canRelease ||
    canPeek ||
    paused ||
    asleep
  )
  const actions = hasActions ? (
    <div className="flex items-center gap-1">
      {/* Primária, na frente e em accent: a aba é onde se trabalha na filha. Vai
          direto, sem a modal do quick look no caminho. */}
      {childProcess && (
        <button
          type="button"
          onClick={() => void focusOrOpenSession(childProcess)}
          title="Abrir esta filha numa aba. A sessão já está rodando: a aba só a traz para a tela"
          aria-label="Abrir na aba"
          className="flex items-center gap-1 rounded border border-[var(--color-accent)]/50 px-2 py-0.5 text-[11px] text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10"
        >
          <Icon as={PanelTop} size={12} />
          {!tight && 'Abrir na aba'}
        </button>
      )}
      {asleep && (
        <button
          type="button"
          onClick={() => void wake()}
          disabled={waking}
          title="Acordar esta filha numa aba: a sessão volta com o histórico e a identidade dela. O trabalho entregue não é refeito."
          aria-label="Acordar"
          className="flex items-center gap-1 rounded border border-[var(--color-accent)]/50 px-2 py-0.5 text-[11px] text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10 disabled:opacity-50"
        >
          <Icon as={Sun} size={12} />
          {!tight && (waking ? 'Acordando…' : 'Acordar')}
        </button>
      )}
      {canPeek && (
        <button
          type="button"
          onClick={onPeek}
          title="Espiar a conversa desta filha (Espaço)"
          className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={Eye} size={12} />
          {!tight && 'Espiar'}
        </button>
      )}
      {paused && (
        <button
          type="button"
          onClick={() => void resume()}
          disabled={resuming}
          title="Re-spawnar a sessão-filha e retomar de onde parou"
          className="flex items-center gap-1 rounded border border-[var(--color-accent)]/50 px-2 py-0.5 text-[11px] text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10 disabled:opacity-50"
        >
          <Icon as={Play} size={12} />
          {!tight && (resuming ? 'Retomando…' : 'Retomar')}
        </button>
      )}
      {/* Recovery manual mora no menu: é destrutivo e o card fica na periferia —
          no mesmo peso de "Abrir na aba" seria convite a clique errado.
          portal: a lista do dock rola (overflow), e o painel absolute seria
          recortado por ela. */}
      {(childProcess || forceFailable || canArchive || canRelease) && (
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          portal
          items={[
            // Os verbos da filha viva são os da barra e do X da aba, com o mesmo
            // efeito: Minimizar é o closePane, Encerrar é o endSessionAsked.
            ...(childPaneId
              ? [
                  {
                    label: 'Minimizar',
                    title:
                      'Fecha só a aba. A filha segue rodando em 2º plano, no chip da mãe na barra.',
                    onClick: () => useAppStore.getState().closePane(childPaneId),
                  },
                ]
              : []),
            ...(childProcess
              ? [
                  {
                    label: 'Encerrar filha',
                    danger: true,
                    title:
                      'Mata o processo. A filha segue vinculada à mãe e pode ser retomada depois.',
                    onClick: () => endSessionAsked(childProcess.id),
                  },
                ]
              : []),
            ...(forceFailable
              ? [
                  {
                    label: failing ? 'Falhando…' : 'Forçar falha',
                    danger: true,
                    onClick: () => void forceFail(),
                  },
                ]
              : []),
            ...(canArchive
              ? [
                  {
                    label: dismissing ? 'Arquivando…' : 'Arquivar card',
                    disabled: dismissing,
                    title:
                      'Tira este card do painel; o registro fica no histórico. Dá pra desfazer pelo toast.',
                    onClick: () => void dismiss(),
                  },
                ]
              : []),
            ...(canRelease
              ? [
                  {
                    label: releasing ? 'Desvinculando…' : 'Desvincular',
                    disabled: releasing,
                    title:
                      'Desfaz o vínculo mãe→filha: a sessão deixa de ser filha e VOLTA a ser uma sessão normal (barra, switcher, notificações próprias). Não encerra a sessão — mas ela segue com as permissões restritas de filha até ser encerrada e retomada.',
                    onClick: () => void release(),
                  },
                ]
              : []),
          ]}
        >
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            title="Mais ações"
            aria-label="Mais ações"
            className="flex items-center rounded px-1 py-0.5 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <Icon as={MoreHorizontal} size={14} />
          </button>
        </Menu>
      )}
      {/* Arquivar em UM clique. Fica por último, à direita, onde se procura
          fechar — e só existe com o processo morto (canArchiveCard): com a filha
          viva um "×" aqui leria como o X da aba, que encerra. */}
      {canArchive && (
        <button
          type="button"
          onClick={(e) => {
            // O card é alvo de clique (peek/foco) nas superfícies que o embrulham:
            // sem isto, fechar abriria o quick look da filha que acabou de sair.
            e.stopPropagation()
            void dismiss()
          }}
          disabled={dismissing}
          aria-label="Arquivar card"
          title="Arquivar card: sai do painel e o registro fica no histórico. Dá pra desfazer pelo toast."
          className="flex items-center rounded px-1 py-0.5 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          <Icon as={X} size={14} />
        </button>
      )}
    </div>
  ) : null

  // Disclosure do detalhe (resumo / erro / motivo). Extraído do rodapé porque o
  // card pausado ancora o gatilho no bloco de estado — o motivo explica o
  // ESTADO, não é uma ação sobre a sessão — e ali ele não briga com o menu de
  // overflow, que abre por portal logo abaixo do "⋯".
  const detailLabel = expanded
    ? 'Ocultar'
    : handoff.status === 'done'
      ? 'Ver resumo'
      : handoff.status === 'interrupted'
        ? 'Ver motivo'
        : 'Ver erro'
  const detailToggle = hasDetail ? (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className="text-xs text-[var(--color-accent)] hover:underline"
    >
      {detailLabel}
    </button>
  ) : null
  const detailBody =
    hasDetail && expanded ? (
      <pre
        className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-3 py-2 font-mono text-xs"
        style={{
          color:
            handoff.status === 'failed'
              ? 'var(--color-danger)'
              : handoff.status === 'interrupted'
                ? 'var(--color-warning)'
                : 'var(--color-text)',
        }}
      >
        {handoff.status === 'done' ? handoff.summary : handoff.error}
      </pre>
    ) : null

  // Coluna de conteúdo, na ordem em que se lê: QUEM (nome + um selo) → O QUE
  // ACONTECE AGORA (a pergunta, se ela espera; senão o passo corrente) → o que
  // ela foi fazer (briefing, com teto de 2 linhas) → medidores curtos.
  const content = (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate text-sm font-medium text-[var(--color-text)]">
          {/* O alias da sessão, o MESMO rótulo do cartão no mapa e da aba; o nome
              da pessoa fica em segundo plano na linha de baixo. */}
          {childTitle ?? (alias ? alias.name : `→ ${repoLabel}`)}
        </span>
        {/* O selo com rótulo vale em toda densidade (no dock só aparecia um
            ponto, e o mesmo cartão na Home dizia "trabalhando"). */}
        {liveBadgeWins && live ? (
            <span
              data-testid="handoff-live-badge"
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border font-medium ${tight ? 'px-1 py-px text-[10px]' : 'px-1.5 py-0.5 text-[11px]'}`}
              style={{
                color: live.color,
                borderColor: `color-mix(in srgb, ${live.color} 45%, transparent)`,
                background: `color-mix(in srgb, ${live.color} 12%, transparent)`,
              }}
              title="Estado ao vivo da sessão-filha"
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: live.color }} />
              {live.label}
            </span>
        ) : (
          <StatusBadge status={handoff.status} paused={paused} rest={restLabel} />
        )}
      </div>
      {alias && (
        <div
          className="truncate text-[11px] text-[var(--color-text-dim)]"
          title={`${childTitle ?? alias.name} · ${repoLabel}`}
        >
          {`${alias.name} · ${repoLabel}`}
        </div>
      )}

      {paused && (
        <div className="mt-1">
          {/* "Ver motivo" mora AQUI, na mesma linha do estado, e não no rodapé:
              é o porquê da pausa, então pertence ao bloco que a anuncia. Solto
              embaixo ele lia como link órfão e ainda ficava debaixo do menu de
              overflow. O "·" é o mesmo separador dos medidores. */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-[var(--color-text-dim)]">
            <span
              className="flex items-center gap-1"
              title="A sessão-filha encerrou, mas o histórico dela está salvo no disco — retomar re-spawna a filha com o contexto inteiro."
            >
              {/* Pause preenchido: as duas barras têm 5 de 24 unidades: a 12px o
                  contorno de 1.75 come quase todo o miolo e o glifo vira duas
                  tiras borradas. Sólido é o desenho canônico do pause e é o que
                  fica nítido nesse tamanho. */}
              <Icon as={Pause} size={12} strokeWidth={0} fill="currentColor" />
              dá pra retomar de onde parou
            </span>
            {detailToggle && (
              <>
                <span aria-hidden>·</span>
                {detailToggle}
              </>
            )}
          </div>
          {detailBody}
        </div>
      )}

      {asleep && (
        <div className="mt-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-[var(--color-text-dim)]">
            <span
              className="flex items-center gap-1"
              title="A filha entregou o trabalho e, ociosa, hibernou: o processo saiu e o histórico está salvo. Ela segue vinculada à mãe e volta quando você acordar ou quando a mãe chamar."
            >
              <Icon as={Moon} size={12} />
              entregou e hibernou
            </span>
            {detailToggle && (
              <>
                <span aria-hidden>·</span>
                {detailToggle}
              </>
            )}
          </div>
          {detailBody}
          {wakeError && <div className="mt-1 text-xs text-[var(--color-danger)]">{wakeError}</div>}
        </div>
      )}

      {question ? (
        <div
          data-testid="handoff-question"
          className="mt-1.5 rounded-md border px-2 py-1.5 text-sm"
          style={{
            borderColor: 'var(--color-danger)',
            background: 'color-mix(in srgb, var(--color-danger) 8%, transparent)',
            color: 'var(--color-text)',
          }}
        >
          <div className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-[var(--color-warning)]">
            <Icon as={AlertTriangle} size={12} />A filha perguntou:
          </div>
          {/* Teto mais apertado que o do peek (max-h-32): aqui é resumo, lá é
              leitura. O integral sai no title e, inteiro e rolável, no peek. */}
          <div className="line-clamp-3 max-h-24 overflow-hidden whitespace-pre-wrap" title={question}>
            {question}
          </div>
        </div>
      ) : (
        isLiveHandoff &&
        handoff.currentStep && (
          <div className="mt-1 truncate text-xs text-[var(--color-info)]" title={handoff.currentStep}>
            {handoff.currentStep}
          </div>
        )
      )}
      {/* Com pergunta aberta, o último texto dela É a pergunta — repeti-la
          gastaria uma linha pra dizer o mesmo. */}
      {!question && lastText && (
        <div
          className="mt-1 truncate text-xs text-[var(--color-text-dim)]"
          title={childLive?.lastText ?? undefined}
        >
          {lastText}
        </div>
      )}

      {/* Briefing: a task é um prompt de agente, longa por natureza e sem teto na
          origem (de propósito — ver a tool handoff). O teto é de RENDERIZAÇÃO:
          duas linhas aqui, integral no title e no peek. */}
      <div
        data-testid="handoff-task"
        className="mt-1 line-clamp-2 text-sm text-[var(--color-text-dim)]"
        title={handoff.task}
      >
        {handoff.task}
      </div>

      {!tight && (activityLabel || ctxLabel) && (
        <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-[var(--color-text-dim)]">
          {activityLabel && <span title="Última atividade da filha">{activityLabel}</span>}
          {activityLabel && ctxLabel && <span aria-hidden>·</span>}
          {ctxLabel && <span title="Tokens de contexto em uso">{ctxLabel}</span>}
        </div>
      )}
      {stale && (
        <div
          className="mt-1 flex items-center gap-1 text-xs text-[var(--color-warning)]"
          title="A sessão-filha não reporta progresso há um tempo — pode ter travado."
        >
          <Icon as={AlertTriangle} size={12} />
          {staleLabel(handoff, Date.now())}
        </div>
      )}
    </div>
  )

  // shrink-0 no card: numa coluna rolável (o dock), sem isto o flex comprime o
  // último card e corta o rodapé dele em vez de deixar a lista rolar.
  return (
    <div
      data-testid="handoff-card"
      className="shrink-0 rounded-[14px] border bg-[var(--color-surface)] p-3"
      style={{
        borderColor: highlight ? 'var(--color-danger)' : 'var(--color-border)',
        background: highlight
          ? 'color-mix(in srgb, var(--color-danger) 6%, transparent)'
          : undefined,
      }}
    >
      {compact ? (
        content
      ) : (
        <div className="flex items-start justify-between gap-3">
          {content}
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-dim)]">
              {formatDate(handoff.createdAt)}
            </span>
            {actions}
          </div>
        </div>
      )}

      {compact && actions && (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-1">{actions}</div>
      )}

      {canSend && (
        <form
          className={`mt-2 flex gap-2 ${tight ? 'flex-col items-stretch' : 'items-start'}`}
          onSubmit={(e) => {
            e.preventDefault()
            void sendMessage()
          }}
        >
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              // Enter envia; Shift+Enter quebra linha (multi-linha íntegra via
              // bracketed-paste no main).
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void sendMessage()
              }
            }}
            rows={1}
            placeholder={sendPlaceholder}
            className="min-h-[32px] flex-1 resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="submit"
            disabled={sending || message.trim().length === 0}
            title={`${sendLabel} (Enter)`}
            className="flex shrink-0 items-center justify-center gap-1 rounded border px-2 py-1.5 text-[11px] font-medium transition disabled:opacity-40"
            style={{
              color: highlight ? 'var(--color-danger)' : 'var(--color-accent)',
              borderColor: highlight ? 'var(--color-danger)' : 'var(--color-accent)',
            }}
          >
            <Icon as={answering ? CornerDownLeft : Send} size={12} />
            {sending ? 'Enviando…' : sendLabel}
          </button>
        </form>
      )}
      {canSend && sendError && (
        <div className="mt-1 text-xs text-[var(--color-danger)]">{sendError}</div>
      )}

      {/* Pausada já mostrou o gatilho junto do estado; aqui ficam os terminais
          (done / failed), onde o detalhe é sobre o handoff inteiro. */}
      {hasDetail && !paused && !asleep && (
        <div className="mt-2">
          {detailToggle}
          {detailBody}
        </div>
      )}

      {canRate && (
        <div className="mt-2 flex items-center gap-2 border-t border-[var(--color-border)] pt-2">
          <span className="text-[11px] text-[var(--color-text-dim)]">Foi útil?</span>
          <OutcomeButton
            active={handoff.outcome === 'useful'}
            disabled={rating}
            onClick={() => void rate('useful')}
            icon={ThumbsUp}
            label="Útil"
            color="var(--color-success)"
            iconOnly={tight}
          />
          <OutcomeButton
            active={handoff.outcome === 'partial'}
            disabled={rating}
            onClick={() => void rate('partial')}
            icon={CircleSlash}
            label="Parcial"
            color="var(--color-warning)"
            iconOnly={tight}
          />
          <OutcomeButton
            active={handoff.outcome === 'wrong'}
            disabled={rating}
            onClick={() => void rate('wrong')}
            icon={ThumbsDown}
            label="Errou"
            color="var(--color-danger)"
            iconOnly={tight}
          />
        </div>
      )}
    </div>
  )
}

function OutcomeButton({
  active,
  disabled,
  onClick,
  icon,
  label,
  color,
  iconOnly,
}: {
  active: boolean
  disabled: boolean
  onClick: () => void
  icon: typeof ThumbsUp
  label: string
  color: string
  iconOnly?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className="flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-50"
      style={{
        color: active ? color : 'var(--color-text-dim)',
        borderColor: active ? color : 'var(--color-border)',
        background: active ? `color-mix(in srgb, ${color} 12%, transparent)` : undefined,
      }}
    >
      <Icon as={icon} size={12} />
      {!iconOnly && label}
    </button>
  )
}
