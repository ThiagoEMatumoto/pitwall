import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CircleSlash,
  CornerDownLeft,
  Eye,
  MoreHorizontal,
  Pause,
  Play,
  Send,
  TerminalSquare,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu } from '@/components/ui/Menu'
import { handoffsApi, prefsApi } from '@/lib/ipc'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import type { PanelTier } from '@/features/sessions/use-panel-tier'
import { crewResumedAfterQuestion, splitAlias } from './crew'
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

// Liveness derivada do status da sessão-filha viva (LiveSessionInfo). `undefined`
// = filha não está mais no liveSessions (PTY encerrou). Mapeia pra label + token
// de cor existente. Puro → testável.
export interface LiveBadge {
  label: string
  color: string
  // waiting/ended pedem destaque/ação no card.
  attention: boolean
}

export function liveBadgeFor(status: LiveSessionInfo['status'] | undefined): LiveBadge {
  switch (status) {
    case 'working':
      return { label: 'trabalhando', color: 'var(--color-info)', attention: false }
    case 'waiting':
      return { label: 'aguardando você', color: 'var(--color-warning)', attention: true }
    case 'starting':
      return { label: 'iniciando', color: 'var(--color-info)', attention: false }
    case 'idle':
      return { label: 'ociosa', color: 'var(--color-text-dim)', attention: false }
    case 'ended':
    case undefined:
    default:
      return { label: 'filha encerrou', color: 'var(--color-danger)', attention: true }
  }
}

const STATUS_LABEL: Record<HandoffStatus, string> = {
  pending: 'Pendente',
  approved: 'Aprovado',
  running: 'Em andamento',
  needs_input: 'Aguardando resposta',
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
  needs_input: 'var(--color-warning)',
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
export function StatusBadge({
  status,
  paused = false,
}: {
  status: HandoffStatus
  paused?: boolean
}) {
  const color = paused ? 'var(--color-text-dim)' : STATUS_COLOR[status]
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
      {paused ? 'Pausada' : STATUS_LABEL[status]}
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
  // Abre o TERMINAL da filha do jeito que o dono do card decidir (o dock manda
  // pro overlay em janela; sem isto, o botão promove a filha a aba como antes).
  onOpenTerminal?: () => void
}

export function HandoffCard({ handoff, ttlHours, tier = 'wide', onPeek, onOpenTerminal }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [failing, setFailing] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [rating, setRating] = useState(false)
  const [resuming, setResuming] = useState(false)
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

  // Recovery manual: força failed via IPC handoffs:fail. Disponível pra running e
  // pra approved travado (aprovado mas a filha nunca subiu). Confirmação evita
  // matar uma filha viva em trabalho longo por engano.
  const canForceFail = handoff.status === 'running' || handoff.status === 'approved'

  // Dispensar: tira o card de vista sem tocar no status. Só some o que ainda não
  // foi dispensado — repetir não faria nada visível.
  const canDismiss = handoff.dismissedAt == null

  // Soltar: a operação INVERSA da adoção — corta o vínculo mãe→filha e devolve a
  // sessão à condição de sessão normal. Só faz sentido com filha atrelada; sem
  // childSessionId não há vínculo pra cortar. Ao contrário de "Dispensar", NÃO é
  // bloqueado com a filha viva: soltar não cria órfão invisível, é justamente o
  // contrário — a sessão volta a aparecer na barra e no switcher.
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
      `Forçar falha deste handoff para "${repoLabel}"? A sessão-filha não será encerrada automaticamente; use isto quando ela travou ou já morreu.`,
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
  // filha até ser relançada. O caminho de limpar é o normal: fechar a sessão e
  // retomá-la pela barra; o sessions:resume NÃO re-vincula depois do release
  // (o relink exige dismissed_at IS NULL), então ela volta como sessão comum.
  async function release() {
    if (releasing) return
    const ok = window.confirm(
      `Soltar esta sessão do painel? O vínculo com "${repoLabel}" é desfeito: ela volta a aparecer na barra e no switcher como sessão normal, e o handoff vira histórico.\n\nAtenção: a sessão continua rodando com as permissões restritas de filha (isso é do processo, não do registro) — para limpá-las, feche-a e retome pela barra.`,
    )
    if (!ok) return
    setReleasing(true)
    try {
      await handoffsApi.release(handoff.id)
      await load()
    } catch {
      setReleasing(false)
    }
  }

  // A filha está num PTY enquanto o handoff está vivo (running OU needs_input —
  // needs_input é um estado vivo dentro de running). "Abrir terminal" RE-ATTACHA
  // uma pane à sessão viva (focusOrOpenSession → paneFromLiveSession), nunca
  // re-spawn/--resume. Só aparece em liveSessions enquanto a PTY existe.
  const isLiveHandoff = handoff.status === 'running' || handoff.status === 'needs_input'
  const childSession = handoff.childSessionId
    ? liveSessions.find((s) => s.id === handoff.childSessionId)
    : undefined
  const childLive = isLiveHandoff ? childSession : undefined

  // Identidade endereçável da filha: `sessions.title` carrega o alias fixado no
  // spawn (`<nome>-<escopo>`). Nome em destaque, escopo apagado embaixo.
  const alias = splitAlias(childSession?.title)

  // Sinais vivos da filha. badge.attention (waiting/ended) ou needs_input pedem
  // realce âmbar. needs_input vence: a mãe pediu input explícito.
  const live = isLiveHandoff ? liveBadgeFor(childLive?.status) : null
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
    try {
      await handoffsApi.sendMessage({ id: handoff.id, text })
      setMessage('')
    } catch {
      // Falha (filha morreu entre o render e o envio): o load() seguinte atualiza
      // o liveness e o input some. Mantém o texto pro usuário não perder o que digitou.
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
  const hasActions = !!(childLive || canForceFail || canDismiss || canRelease || canPeek || paused)
  const actions = hasActions ? (
    <div className="flex items-center gap-1">
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
      {childLive && (
        <button
          type="button"
          onClick={() => (onOpenTerminal ? onOpenTerminal() : void focusOrOpenSession(childLive))}
          title="Anexar o terminal desta sessão-filha"
          className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          <Icon as={TerminalSquare} size={12} />
          {!tight && 'Abrir terminal'}
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
          no mesmo peso de "Abrir terminal" seria convite a clique errado.
          portal: a lista do dock rola (overflow), e o painel absolute seria
          recortado por ela. */}
      {(canForceFail || canDismiss || canRelease) && (
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          portal
          items={[
            ...(canForceFail
              ? [
                  {
                    label: failing ? 'Falhando…' : 'Forçar falha',
                    danger: true,
                    onClick: () => void forceFail(),
                  },
                ]
              : []),
            ...(canDismiss
              ? [
                  {
                    // Rótulo com o efeito no próprio nome: "Dispensar" sozinho
                    // e "Soltar" sozinho leem como sinônimos no mesmo menu. O que
                    // os separa é o efeito — e é isso que cada rótulo diz.
                    //
                    // Dizia "mantém o vínculo", e era MENTIRA na parte que o
                    // usuário sente: o vínculo sobrevive só como REGISTRO (o
                    // child_session_id fica gravado, e com ele a trilha do
                    // handoff), mas a sessão dispensada volta a ser tratada como
                    // sessão comum em todas as superfícies vivas — e, ao ser
                    // retomada, sobe sem apelido de peer e sem as settings de
                    // filha (o relink do sessions:resume exige dismissed_at
                    // IS NULL). Prometer vínculo e entregar sessão comum é a
                    // pior das duas opções: o rótulo agora diz o que acontece.
                    label: dismissing ? 'Dispensando…' : 'Dispensar (arquiva o card)',
                    // Já foi DESABILITADO com a filha viva, pra proteger o
                    // acompanhamento — e o efeito foi o oposto: em needs_input
                    // com filha viva "Forçar falha" nem é renderizado, então o
                    // menu abria com um item só ("Soltar do painel"), e não havia
                    // como tirar o card da frente. O bloqueio também não se
                    // justificava: dispensar só carimba dismissed_at, não encosta
                    // na PTY. Agora dispensa sempre, o rótulo diz o que acontece
                    // e o toast oferece "Desfazer".
                    disabled: dismissing,
                    title:
                      'Arquiva este handoff: o card sai do dock e o registro fica no histórico. A SESSÃO-FILHA CONTINUA RODANDO — ela volta a ser uma sessão comum (barra, switcher, notificações próprias) e, se for retomada, sobe sem o apelido nem as permissões de filha. Dá pra desfazer pelo toast.',
                    onClick: () => void dismiss(),
                  },
                ]
              : []),
            ...(canRelease
              ? [
                  {
                    label: releasing ? 'Soltando…' : 'Soltar do painel (desfaz o vínculo)',
                    disabled: releasing,
                    title:
                      'Desfaz o vínculo mãe→filha: a sessão sai do painel e VOLTA a ser uma sessão normal (barra, switcher, notificações próprias). Não encerra a sessão — mas ela segue com as permissões restritas de filha até ser fechada e retomada.',
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
      {/* Dispensa rápida. O "×" é o caminho de UM clique pro que antes só existia
          enterrado no menu — e que, em needs_input com filha viva, o menu nem
          chegava a oferecer. Fica por último, à direita, onde se procura fechar. */}
      {canDismiss && (
        <button
          type="button"
          onClick={(e) => {
            // O card é alvo de clique (peek/foco) nas superfícies que o embrulham:
            // sem isto, fechar abriria o quick look da filha que acabou de sair.
            e.stopPropagation()
            void dismiss()
          }}
          disabled={dismissing}
          aria-label="Dispensar"
          title="Tira este card do painel. A SESSÃO-FILHA CONTINUA RODANDO — ela volta a ser uma sessão comum (barra, switcher). Dá pra desfazer pelo toast."
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
          {alias ? alias.name : `→ ${repoLabel}`}
        </span>
        {liveBadgeWins && live ? (
          tight ? (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: live.color }}
              title={`Estado ao vivo da sessão-filha: ${live.label}`}
            />
          ) : (
            <span
              className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium"
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
          )
        ) : (
          <StatusBadge status={handoff.status} paused={paused} />
        )}
      </div>
      {alias && (
        <div
          className="truncate text-[11px] text-[var(--color-text-dim)]"
          title={`${childSession?.title ?? alias.name} → ${repoLabel}`}
        >
          {alias.scope ? `${alias.scope} · → ${repoLabel}` : `→ ${repoLabel}`}
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

      {question ? (
        <div
          data-testid="handoff-question"
          className="mt-1.5 rounded-md border px-2 py-1.5 text-sm"
          style={{
            borderColor: 'var(--color-warning)',
            background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)',
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
        borderColor: highlight ? 'var(--color-warning)' : 'var(--color-border)',
        background: highlight
          ? 'color-mix(in srgb, var(--color-warning) 8%, transparent)'
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
              color: highlight ? 'var(--color-warning)' : 'var(--color-accent)',
              borderColor: highlight ? 'var(--color-warning)' : 'var(--color-accent)',
            }}
          >
            <Icon as={answering ? CornerDownLeft : Send} size={12} />
            {sending ? 'Enviando…' : sendLabel}
          </button>
        </form>
      )}

      {/* Pausada já mostrou o gatilho junto do estado; aqui ficam os terminais
          (done / failed), onde o detalhe é sobre o handoff inteiro. */}
      {hasDetail && !paused && (
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
