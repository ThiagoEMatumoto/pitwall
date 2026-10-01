import { useEffect, useId, useRef, useState } from 'react'
import { CornerDownLeft, MessageSquare, SquareTerminal, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { ChatView } from '@/features/sessions/chat/ChatView'
import { Terminal } from '@/features/sessions/Terminal'
import { handoffsApi } from '@/lib/ipc'
import { sessionFromLiveSession, useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { StatusBadge, contextLabel, liveActivityLabel, liveBadgeFor } from './HandoffCard'
import {
  crewNeedsAttention,
  crewResumedAfterQuestion,
  crewTerminalTarget,
  splitAlias,
} from './crew'
import { useCrewDockStore, type CrewPeekMode } from './crew-dock-store'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'
import { CLAUDE_ONLY_REASON, providerSupports } from '../../../shared/agent-providers'

// Quick look de uma sessão-filha: abre por cima de tudo, mostra a filha —
// conversa renderizada ou terminal cru —, deixa responder, e some. O degrau do
// meio entre "ver o dot piscar" e "abrir a aba" — olhar e desbloquear em
// segundos SEM mexer no layout de trabalho (nenhuma pane nasce, o dockview segue
// montado por trás).
//
// Montado como irmão de <main> no AppShell, no mesmo padrão do SessionSwitcher
// (fixed + backdrop + `if (!open) return null`), e não pelo Dialog.tsx — que
// trava max-h-[85vh] sem parametrização e o peek quer a altura toda.
//
// Custo de GPU: zero em chat (o ChatView lê o transcript JSONL por IPC e não
// importa xterm/WebGL). Em terminal, UM contexto dos 8 do cap enquanto a janela
// está aberta — o Terminal solta no unmount (detachWebgl no cleanup do mount
// effect), e fechar o overlay desmonta.
//
// Encerrar a sessão NÃO existe aqui, de propósito: o terminal entra com
// chrome="bare" (sem SessionHeader). Num fluxo de "só vou dar uma olhada", um
// botão de desligar ao alcance do clique é acidente esperando acontecer — quem
// quer de fato trabalhar na filha usa "abrir como aba", no rodapé.

// Focáveis do overlay, pro trap do Tab. Consultado NA HORA de cada Tab: o corpo
// do peek é o ChatView, que ganha e perde botões a cada mensagem — uma lista
// congelada na montagem apontaria pra nós que já saíram do DOM.
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Tab e Shift+Tab circulam DENTRO do overlay. Sem isto, um Tab a partir do peek
// já sai dele e chega aos botões de janela do Electron — um "modal" que não
// contém o teclado não é modal. Só as BORDAS são interceptadas (primeiro e
// último focáveis); no meio, o Tab é o nativo do navegador. Não toca em Escape
// nem no foco de desmontagem: fechar e devolver o foco ao card do dock continua
// sendo dos handlers de sempre.
function trapTab(e: React.KeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'Tab') return
  // Em modo terminal o teclado é da filha: Tab e Shift+Tab são teclas da TUI
  // (Shift+Tab cicla o modo de permissão). Mover o foco por baixo dela quebraria
  // justamente o que se veio fazer aqui.
  if (e.currentTarget.dataset.peekMode === 'terminal') return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
  const first = items[0]
  const last = items[items.length - 1]
  const onPanel = document.activeElement === e.currentTarget
  if (e.shiftKey && (document.activeElement === first || onPanel)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

export function CrewPeek() {
  const target = useCrewDockStore((s) => s.peekTarget)
  const peekMode = useCrewDockStore((s) => s.peekMode)
  const closePeek = useCrewDockStore((s) => s.closePeek)
  const handoffs = useHandoffsStore((s) => s.handoffs)
  const liveSessions = useAppStore((s) => s.liveSessions)
  const panes = useAppStore((s) => s.panes)
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)

  const handoff =
    target?.kind === 'handoff' ? (handoffs.find((h) => h.id === target.id) ?? null) : null
  const liveId = target?.kind === 'session' ? target.id : handoff?.childSessionId
  const live = liveId ? (liveSessions.find((s) => s.id === liveId) ?? null) : null
  const sessionTabOpen = target?.kind === 'session' && crewTerminalTarget(live, panes) === 'pane'

  // Fecha sozinho se o alvo sumiu enquanto o overlay estava aberto — o handoff
  // saiu da lista (concluiu, falhou) ou a sessão avulsa terminou. Melhor que
  // deixar um painel órfão na tela.
  const gone = target?.kind === 'handoff' ? !handoff : target?.kind === 'session' && !live
  useEffect(() => {
    if (gone) closePeek()
  }, [gone, closePeek])

  // Peek e aba da mesma sessão não coexistem: se a sessão já tem aba, o peek
  // cede e leva até ela (dois xterms na mesma PTY brigariam pelo resize).
  useEffect(() => {
    if (!sessionTabOpen || !live) return
    closePeek({ restoreFocus: false })
    void focusOrOpenSession(live)
  }, [sessionTabOpen, live, closePeek, focusOrOpenSession])

  if (!target || gone || sessionTabOpen) return null
  // key: trocar de alvo remonta o painel (e o ChatView), zerando o transcript
  // assinado e o texto meio digitado do anterior.
  return (
    <CrewPeekPanel
      key={`${target.kind}:${target.id}`}
      handoff={handoff}
      live={live}
      // Sem Chat View no provider (Codex): o peek abre direto no terminal.
      mode={providerSupports(live?.provider).chatView ? peekMode : 'terminal'}
      onClose={closePeek}
    />
  )
}

interface PanelProps {
  // null = peek de sessão avulsa (sem handoff): sem briefing, sem pergunta, e a
  // resposta vai pelo terminal da própria sessão.
  handoff: Handoff | null
  live: LiveSessionInfo | null
  mode: CrewPeekMode
  onClose: () => void
}

function CrewPeekPanel({ handoff, live, mode, onClose }: PanelProps) {
  const focusOrOpenSession = useAppStore((s) => s.focusOrOpenSession)
  const panes = useAppStore((s) => s.panes)
  const setPeekMode = useCrewDockStore((s) => s.setPeekMode)
  const load = useHandoffsStore((s) => s.load)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showBriefing, setShowBriefing] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Quem estava focado quando o peek abriu (o card do dock, ou o botão clicado).
  // Padrão novo no repo: sem isto o "fecha rápido" larga o usuário no vazio, que
  // é exatamente o atrito que esta tela existe pra eliminar.
  const originRef = useRef<HTMLElement | null>(null)
  // Fechar promovendo a aba é a exceção: lá o foco pertence ao terminal recém
  // aberto, e devolvê-lo ao card do dock roubaria a sessão de quem pediu ela.
  const skipRestoreRef = useRef(false)
  // Corpo do overlay (chat ou terminal). Delimita de quem é o Escape: dentro do
  // terminal ele pertence à filha — ver o handler abaixo.
  const bodyRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const active = document.activeElement
    originRef.current = active instanceof HTMLElement ? active : null
    // rAF: mesmo padrão do refocus do Composer — foca depois do paint. Em modo
    // terminal quem toma o foco é o xterm (effect do próprio Terminal): digitar
    // na TUI é o motivo de se estar ali.
    // Peek de sessão (sem handoff) não tem campo de resposta: o foco entra no
    // painel, senão fica atrás do backdrop e o trap do Tab nunca roda.
    requestAnimationFrame(() => {
      if (inputRef.current) inputRef.current.focus()
      else if (useCrewDockStore.getState().peekMode === 'chat') dialogRef.current?.focus()
    })
    return () => {
      if (skipRestoreRef.current || !useCrewDockStore.getState().peekRestoreFocus) return
      const origin = originRef.current
      requestAnimationFrame(() => {
        if (origin?.isConnected) origin.focus()
      })
    }
  }, [])

  // Esc fecha de qualquer lugar do overlay (inclusive de dentro do textarea).
  // Listener de janela em capture porque o peek é a camada de cima: nenhum outro
  // handler de Esc deve ver esta tecla antes.
  //
  // EXCEÇÃO em modo terminal: com o foco no corpo, o Esc é da filha (cancelar na
  // TUI, sair de menu). Roubá-lo faria do terminal do overlay um terminal pela
  // metade. A saída pelo teclado vira Shift+Esc — anunciada no rodapé.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (mode === 'terminal' && !e.shiftKey && bodyRef.current?.contains(document.activeElement)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, mode])

  const titleId = useId()
  const alias = splitAlias(live?.title)
  const repoLabel = handoff
    ? (handoff.targetRepoLabel ?? handoff.targetRepoId)
    : (live?.repo?.label ?? 'Avulsa')
  const badge = liveBadgeFor(live ?? undefined)
  const activityLabel = liveActivityLabel(live?.lastActivityAt ?? null, Date.now())
  const ctxLabel = contextLabel(live?.tokens)

  // A filha está bloqueada esperando a mãe. É o único momento em que pode haver
  // um menu TUI aberto na tela dela — e o único em que o aviso de read-only
  // (abaixo) tem serventia. Mesma pergunta que o dock faz pra ordenar e acender
  // o âmbar: uma função só, senão as duas superfícies divergem.
  const answering = handoff ? crewNeedsAttention(handoff, live ?? undefined) : false
  // A pergunta ficou pendente no banco mas a filha já seguiu (respondida fora do
  // app). O registro continua visível abaixo, em tom neutro — o que ele não pode
  // mais fazer é comandar o selo.
  const resumed = handoff ? crewResumedAfterQuestion(handoff) : false
  // needs_input vence o status do PTY no selo (mesma regra do HandoffCard): quem
  // está travado esperando você não está "trabalhando". Sem isto o cabeçalho
  // contradiz o corpo — "trabalhando" a dois centímetros de "A filha perguntou".
  const blocked = handoff?.status === 'needs_input' && !resumed

  // Onde o terminal desta filha mora agora: aqui na janela, ou na aba que já
  // existe (dois xterms na mesma PTY brigariam pelo resize — crewTerminalTarget).
  const terminalTarget = crewTerminalTarget(live, panes)

  // "Ver o terminal": alterna o overlay pra modo terminal. Se a filha já tem aba
  // aberta, o overlay sai da frente e leva o usuário até ela.
  function showTerminal() {
    if (terminalTarget === 'none') return
    if (terminalTarget === 'pane') {
      promoteToTab()
      return
    }
    setPeekMode('terminal')
  }

  // Promover a filha a aba de verdade: ação explícita, no rodapé. É a única
  // porta pro header completo de sessão (com encerrar) — de propósito.
  function promoteToTab() {
    if (!live) return
    skipRestoreRef.current = true
    void focusOrOpenSession(live)
    onClose()
  }

  // RESPOSTA: handoffs:send-message, chaveado pelo handoffId — NUNCA
  // sessionsApi.write. Só este caminho chama store.resume(id) e encerra o
  // needs_input; qualquer outro canal entregaria o texto mas deixaria o card
  // âmbar aceso à toa (o main não observa o SendMessage do MCP).
  async function send() {
    const text = message.trim()
    if (!handoff || !text || sending) return
    setSending(true)
    setError(null)
    try {
      await handoffsApi.sendMessage({ id: handoff.id, text })
      setMessage('')
    } catch (err) {
      // Filha morreu entre o render e o envio é o caso comum: mostra o motivo e
      // preserva o texto pro usuário não perder o que digitou.
      setError(err instanceof Error ? err.message : 'Não foi possível entregar a mensagem.')
    } finally {
      setSending(false)
      await load()
    }
  }

  return (
    <div
      // z-[1000] é o mesmo do Dialog e pelo mesmo motivo: o dockview desenha
      // .dv-sash em 99 e seus overlays em 999 (--dv-overlay-z-index). Qualquer
      // valor abaixo disso põe o peek por baixo das divisórias assim que houver
      // split — não reproduz com painel único, mas quebra na primeira divisão.
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* role/aria-modal no painel, não no backdrop (padrão do Dialog e do APG):
          o backdrop é área de clique-pra-fechar, não conteúdo do diálogo. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-peek-mode={mode}
        tabIndex={-1}
        onKeyDown={trapTab}
        className="pw-rise flex outline-none h-[88vh] w-[56rem] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span id={titleId} className="truncate text-base font-medium text-[var(--color-text)]">
                {!handoff
                  ? (live?.title ?? live?.name ?? repoLabel)
                  : (live?.title ?? (alias ? alias.name : `→ ${repoLabel}`))}
              </span>
              {blocked && handoff ? (
                <span className="shrink-0" title="A filha está bloqueada esperando sua resposta">
                  <StatusBadge status={handoff.status} />
                </span>
              ) : (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium"
                  style={{
                    color: badge.color,
                    borderColor: `color-mix(in srgb, ${badge.color} 45%, transparent)`,
                    background: `color-mix(in srgb, ${badge.color} 12%, transparent)`,
                  }}
                  title="Estado ao vivo da sessão-filha"
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: badge.color }} />
                  {badge.label}
                </span>
              )}
            </div>
            <div className="truncate text-[11px] text-[var(--color-text-dim)]">
              {!handoff
                ? [live?.projectName, repoLabel].filter(Boolean).join(' · ')
                : alias
                  ? `${alias.name} · → ${repoLabel}`
                  : `→ ${repoLabel}`}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums text-[var(--color-text-dim)]">
              {activityLabel && <span title="Última atividade da filha">{activityLabel}</span>}
              {ctxLabel && <span title="Tokens de contexto em uso">{ctxLabel}</span>}
              {/* O card do dock clampa o briefing em duas linhas; o integral vive
                  AQUI. Truncar sem caminho pro completo seria trocar um problema
                  por outro — fechado por padrão porque o peek é pra conversa. */}
              {handoff && (
                <button
                  type="button"
                  onClick={() => setShowBriefing((v) => !v)}
                  aria-expanded={showBriefing}
                  className="font-sans text-[var(--color-accent)] hover:underline"
                >
                  {showBriefing ? 'ocultar briefing' : 'ver briefing'}
                </button>
              )}
            </div>
            {showBriefing && handoff && (
              <div className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1.5 text-xs text-[var(--color-text)]">
                {handoff.task}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {/* Chat ⇄ Terminal, os dois DENTRO da janela. Segmentado (e não um
                ícone que alterna) porque aqui os dois modos são destinos de
                mesmo peso: ler a conversa e mexer na TUI. */}
            {live && (
              <div
                role="group"
                aria-label="Modo de exibição da filha"
                className="flex items-center gap-0.5 rounded border border-[var(--color-border)] p-0.5 text-[11px]"
              >
                <PeekModeButton
                  active={mode === 'chat'}
                  icon={MessageSquare}
                  label="Chat"
                  disabled={!providerSupports(live.provider).chatView}
                  title={
                    providerSupports(live.provider).chatView
                      ? 'Conversa renderizada do transcript (a PTY segue viva)'
                      : CLAUDE_ONLY_REASON
                  }
                  onClick={() => setPeekMode('chat')}
                />
                <PeekModeButton
                  active={mode === 'terminal'}
                  icon={SquareTerminal}
                  label="Terminal"
                  title={
                    terminalTarget === 'pane'
                      ? 'Esta filha já tem uma aba aberta — o terminal dela está lá'
                      : 'Terminal cru da filha, aqui na janela (menus TUI clicáveis)'
                  }
                  onClick={showTerminal}
                />
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              title="Fechar (Esc)"
              aria-label="Fechar"
              className="rounded p-1 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
            >
              <Icon as={X} size={16} />
            </button>
          </div>
        </header>

        {/* relative + min-h-0: ChatView e Terminal se posicionam com absolute inset-0. */}
        <div ref={bodyRef} className="relative min-h-0 flex-1">
          {mode === 'terminal' && live ? (
            <div className="absolute inset-0">
              {/* chrome="bare": o header de sessão (com ENCERRAR) fica de fora —
                  a moldura é a desta janela. Anexa à MESMA PTY viva, sem pane e
                  sem segundo processo claude; o backlog é replicado no mount. */}
              <Terminal
                session={sessionFromLiveSession(live, null)}
                repoLabel={live.repo?.label ?? 'Avulsa'}
                repoPath={live.repo?.path ?? ''}
                projectName={live.projectName ?? ''}
                projectIcon={live.projectIcon}
                projectColor={live.projectColor}
                mode="terminal"
                chrome="bare"
                onClose={onClose}
              />
            </div>
          ) : (live?.id ?? handoff?.childSessionId) ? (
            <ChatView
              sessionId={(live?.id ?? handoff?.childSessionId)!}
              status={live?.status}
              // Sem onRespond: os cards interativos ficam read-only aqui (o
              // clique deles digita no xterm, que o modo chat não monta). O botão
              // do banner de espera do ChatView troca pro modo terminal — mesma
              // janela, onde o menu TUI é de fato clicável.
              onToggleMode={live ? showTerminal : undefined}
              emptyHint="Sem conversa ainda. Abra o terminal para escrever."
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--color-text-dim)]">
              A sessão-filha ainda não subiu — não há conversa pra mostrar.
            </div>
          )}
        </div>

        {/* Em modo terminal o rodapé encolhe: o input é o composer do próprio
            Terminal, e a pergunta pendente está desenhada na TUI ali em cima.
            Dois campos de texto empilhados seriam duas verdades competindo. */}
        {mode === 'terminal' ? (
          <div className="flex shrink-0 items-center gap-3 border-t border-[var(--color-border)] px-3 py-1.5 text-[10px] text-[var(--color-text-dim)]">
            <span>esc vai pra {handoff ? 'filha' : 'sessão'}</span>
            <span>shift+esc fecha</span>
            <PromoteToTabLink live={live} onClick={promoteToTab} />
          </div>
        ) : !handoff ? (
          <SessionChatFooter live={live} onTerminal={showTerminal} onPromote={promoteToTab} />
        ) : (
        <div className="shrink-0 border-t border-[var(--color-border)] p-3">
          {/* Limitação assumida: menu TUI (escolher opção numerada) é desenhado
              no xterm e parseado do buffer dele — sem xterm, o card é só leitura.
              Dizer isso na cara, com a saída ao lado, em vez de deixar o usuário
              clicando em algo inerte. */}
          {answering && (
            <div
              className="mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-warning) 45%, transparent)',
                background: 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
                color: 'var(--color-text)',
              }}
            >
              <span className="flex-1">
                Responder em texto funciona daqui. Escolher opção de menu (plano, permissão,
                pergunta numerada) só no terminal — o menu é desenhado por ele.
              </span>
              {live && (
                <button
                  type="button"
                  onClick={showTerminal}
                  className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-medium transition hover:border-[var(--color-warning)]"
                >
                  <Icon as={SquareTerminal} size={13} />
                  Ver o terminal
                </button>
              )}
            </div>
          )}

          {/* A pergunta continua aqui mesmo depois de respondida fora do app — o
              registro é o histórico da conversa. O que muda é o TOM: âmbar
              enquanto ela de fato bloqueia; neutro quando a filha já retomou. */}
          {handoff.status === 'needs_input' && handoff.pendingQuestion && (
            <div
              data-testid="peek-question"
              className="mb-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border px-3 py-2 text-sm"
              style={{
                borderColor: resumed ? 'var(--color-border)' : 'var(--color-warning)',
                background: resumed
                  ? undefined
                  : 'color-mix(in srgb, var(--color-warning) 10%, transparent)',
                color: resumed ? 'var(--color-text-dim)' : 'var(--color-text)',
              }}
            >
              <div
                className="mb-1 text-[11px] font-medium"
                style={{ color: resumed ? 'var(--color-text-dim)' : 'var(--color-warning)' }}
              >
                {resumed
                  ? 'A filha perguntou (e já retomou — respondida fora do app):'
                  : 'A filha perguntou:'}
              </div>
              {handoff.pendingQuestion}
            </div>
          )}

          {error && <div className="mb-2 text-xs text-[var(--color-danger)]">{error}</div>}

          <form
            className="flex items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
          >
            <textarea
              ref={inputRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={2}
              disabled={!live}
              placeholder={
                live
                  ? answering
                    ? 'Responder à filha…'
                    : 'Enviar mensagem para a filha…'
                  : 'A sessão-filha não está mais viva.'
              }
              className="min-h-[44px] flex-1 resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!live || sending || message.trim().length === 0}
              title="Enviar (Enter)"
              className="flex shrink-0 items-center gap-1 rounded border px-3 py-2 text-xs font-medium transition disabled:opacity-40"
              style={{
                color: answering ? 'var(--color-warning)' : 'var(--color-accent)',
                borderColor: answering ? 'var(--color-warning)' : 'var(--color-accent)',
              }}
            >
              <Icon as={CornerDownLeft} size={13} />
              {sending ? 'Enviando…' : answering ? 'Responder' : 'Enviar'}
            </button>
          </form>

          <div className="mt-2 flex items-center gap-3 text-[10px] text-[var(--color-text-dim)]">
            <span>↵ enviar</span>
            <span>shift+↵ nova linha</span>
            <span>esc fechar</span>
            <PromoteToTabLink live={live} onClick={promoteToTab} />
          </div>
        </div>
        )}
      </div>
    </div>
  )
}

// Segmento do alternador Chat/Terminal. Ativo = fundo de superfície + texto
// pleno; inativo = só texto apagado, sem borda — a borda é do grupo.
function PeekModeButton({
  active,
  icon,
  label,
  title,
  onClick,
  disabled = false,
}: {
  active: boolean
  icon: typeof MessageSquare
  label: string
  title: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 transition disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]'
          : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
      }`}
    >
      <Icon as={icon} size={12} />
      {label}
    </button>
  )
}

// Rodapé do peek de sessão avulsa em modo chat: não há canal de handoff pra
// responder, então escrever é no terminal da própria sessão (mesma janela).
function SessionChatFooter({
  live,
  onTerminal,
  onPromote,
}: {
  live: LiveSessionInfo | null
  onTerminal: () => void
  onPromote: () => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-dim)]">
      <span className="flex-1">Para escrever para a sessão, use o terminal dela.</span>
      {live && (
        <button
          type="button"
          onClick={onTerminal}
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)]"
        >
          <Icon as={SquareTerminal} size={13} />
          Ver o terminal
        </button>
      )}
      <span>esc fechar</span>
      <PromoteToTabLink live={live} onClick={onPromote} />
    </div>
  )
}

// Promover a filha a aba de verdade. Fica no rodapé, em texto, e não junto do
// alternador: quem só está espiando não deve esbarrar nela — é ela que abre o
// header completo de sessão, com encerrar.
function PromoteToTabLink({ live, onClick }: { live: LiveSessionInfo | null; onClick: () => void }) {
  if (!live) return null
  return (
    <button
      type="button"
      onClick={onClick}
      title="Promover a filha a aba de trabalho (re-attacha a PTY viva; só lá aparece o header completo da sessão)"
      className="ml-auto text-[var(--color-accent)] hover:underline"
    >
      abrir como aba
    </button>
  )
}
