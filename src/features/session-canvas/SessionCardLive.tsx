import { useState, type ReactNode } from 'react'
import { Clock, CornerDownLeft, ShieldAlert } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { handoffsApi, sendToApi } from '@/lib/ipc'
import { sessionFromLiveSession, useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import { dockCrew } from '@/features/handoffs/crew'
import { Terminal } from '@/features/sessions/Terminal'
import {
  AttentionMenuPanel,
  isActionableDetail,
} from '@/features/session-switcher/AttentionPopover'
import { resultNotice } from '@/features/quick-composer/QuickComposer'
import { useSendTargets } from '@/features/quick-composer/quick-composer-store'
import { defaultWhen } from '@/features/quick-composer/target-search'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import type { SendPromptWhen } from '../../../shared/types/send-prompt'
import { useCardViewStore } from './card-view-store'
import { segmentColor } from './card-tail'
import { useMapLive } from './map-live'

// Tudo que é interativo dentro do cartão fica fora dos gestos do mapa: sem isto
// clicar no campo arrastava o cartão, a roda dava zoom e o clique abria o peek.
export function Interactive({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`nodrag nopan nowheel ${className}`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

// Saída ao vivo: as últimas linhas da tela espelhada no main (já sem moldura —
// tail-chrome.ts), empurradas só enquanto o cartão está aberto e visível
// (assinatura no SessionMap). A caixa tem a altura das linhas que existem: com
// altura fixa sobrava 60-70% de preto e o texto colado no fundo.
export const CARD_TAIL_LINES = 10

export function LiveTail({ node }: { node: SessionGraphNode }) {
  const tail = useCardViewStore((s) => s.tails[node.sessionId])
  if (!tail || tail.lines.length === 0) {
    return (
      <p className="shrink-0 text-[11px] text-[var(--color-text-dim)]">
        {!tail
          ? node.provider === 'claude'
            ? 'Lendo a tela…'
            : 'Sem espelho da tela para este agente.'
          : 'Tela vazia.'}
      </p>
    )
  }
  const lines = tail.lines.slice(-CARD_TAIL_LINES)
  return (
    <div
      data-testid="card-live-tail"
      className="nowheel flex min-h-0 shrink flex-col justify-end overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
    >
      <pre className="overflow-hidden whitespace-pre font-mono text-[11px] leading-[1.35] text-[var(--color-text)]">
        {lines.map((line, i) => (
          <div key={i}>
            {line.length === 0
              ? ' '
              : line.map((seg, j) => (
                  <span
                    key={j}
                    style={{
                      color: segmentColor(seg),
                      fontWeight: seg.b ? 600 : undefined,
                      opacity: seg.d ? 0.55 : undefined,
                    }}
                  >
                    {seg.t}
                  </span>
                ))}
          </div>
        ))}
      </pre>
    </div>
  )
}

// Menu na tela (permissão/pergunta/confiar): os mesmos botões do popover de
// atenção, com fingerprint + menuSeq. Pergunta de handoff: o texto, e a resposta
// vai pela barra abaixo (canal do handoff).
export function CardAttention({ node }: { node: SessionGraphNode }) {
  const item = useMapLive().attention.get(node.sessionId)
  const handoff = useHandoffsStore((s) =>
    node.childOfHandoffId ? s.handoffs.find((h) => h.id === node.childOfHandoffId) : undefined,
  )
  const question =
    node.attentionReason === 'handoff-input' ? (handoff?.pendingQuestion ?? null) : null
  if (!question && !(item && isActionableDetail(item.detail))) return null
  return (
    <Interactive className="max-h-[55%] shrink-0 overflow-y-auto">
      <div
        data-testid="card-attention"
        className="flex flex-col gap-1.5 rounded-md border p-2 text-xs text-[var(--color-text)]"
        style={{
          borderColor: 'color-mix(in srgb, var(--color-danger) 55%, transparent)',
          background: 'color-mix(in srgb, var(--color-danger) 8%, var(--color-surface))',
        }}
      >
        {question ? (
          <>
            <span className="text-[11px] font-medium text-[var(--color-danger)]">
              A filha perguntou:
            </span>
            <p className="whitespace-pre-wrap">{question}</p>
          </>
        ) : (
          item && <AttentionMenuPanel item={item} />
        )}
      </div>
    </Interactive>
  )
}

function useCrewHandoffId(node: SessionGraphNode): string | null {
  return useHandoffsStore((s) =>
    node.childOfHandoffId && dockCrew(s.handoffs).some((h) => h.id === node.childOfHandoffId)
      ? node.childOfHandoffId
      : null,
  )
}

// Barra de prompt do cartão: mesmas regras do QuickComposer (sessions:send-prompt
// decide e recusa — menu aberto, texto não enviado, tela não reconhecida — e o
// "quando terminar" espera o fim do turno). Filha do dock fala pelo canal do
// handoff, como no CrewPeek: só ele encerra o needs_input.
export function CardPromptBar({ node }: { node: SessionGraphNode }) {
  const targets = useSendTargets()
  const tail = useCardViewStore((s) => s.tails[node.sessionId])
  const live = useAppStore((s) => s.liveSessions.find((x) => x.id === node.sessionId))
  const crewHandoffId = useCrewHandoffId(node)
  const [text, setText] = useState('')
  const [whenChoice, setWhenChoice] = useState<SendPromptWhen | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const target = targets.find((t) => t.sessionId === node.sessionId) ?? {
    sessionId: node.sessionId,
    alias: node.title,
    status: live?.status ?? node.status,
    attentionReason: live?.attentionReason,
  }
  const hasMenu = tail?.hasMenu ?? false
  const when = whenChoice ?? defaultWhen(target, hasMenu)
  const disabled = !live || sending

  async function submit() {
    const body = text.trim()
    if (!body || disabled) return
    setSending(true)
    setNotice(null)
    try {
      if (crewHandoffId) {
        await handoffsApi.sendMessage({ id: crewHandoffId, text: body })
        setText('')
        setNotice('Enviado para a filha.')
        await useHandoffsStore.getState().load()
        return
      }
      const res = await sendToApi.send({ sessionId: node.sessionId, text: body, when })
      if (res.ok) setText('')
      setNotice(resultNotice(res, target))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Não deu pra enviar — tente de novo.')
    } finally {
      setSending(false)
    }
  }

  const warning = hasMenu
    ? 'Responda o menu acima — ou deixe na fila para quando ela terminar'
    : tail?.inputDirty
      ? 'Há texto não enviado no prompt dela'
      : null
  const queued = when === 'on-idle'

  return (
    <Interactive className="shrink-0">
      {warning && !crewHandoffId && (
        <p
          data-testid="card-prompt-warning"
          className="mb-1 flex items-center gap-1 text-[10px] text-[var(--color-warning)]"
        >
          <Icon as={ShieldAlert} size={11} /> {warning}
        </p>
      )}
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <textarea
          data-testid="card-prompt"
          value={text}
          rows={1}
          disabled={!live}
          onChange={(e) => {
            setText(e.target.value)
            setNotice(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={!live ? 'Sessão sem PTY viva' : `Mensagem para ${target.alias}…`}
          className="min-h-[28px] min-w-0 flex-1 resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
        />
        {!crewHandoffId && (
          <button
            type="button"
            data-testid="card-prompt-when"
            data-when={when}
            aria-pressed={queued}
            aria-label={queued ? 'Enviar quando ela terminar' : 'Enviar agora'}
            onClick={() => setWhenChoice(queued ? 'now' : 'on-idle')}
            title={
              queued
                ? 'Enviar quando ela terminar (ligado): espera o fim do turno, sem menu na tela. Clique para enviar agora'
                : 'Enviar agora (a TUI enfileira se ela estiver trabalhando). Clique para enviar quando ela terminar'
            }
            className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-1 text-[10px] transition ${
              queued
                ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
            }`}
          >
            <Icon as={Clock} size={12} />
            {queued ? 'ao terminar' : 'agora'}
          </button>
        )}
        <button
          type="submit"
          disabled={disabled || text.trim() === ''}
          title="Enviar (Enter)"
          aria-label="Enviar"
          className="shrink-0 rounded border border-[var(--color-accent)] p-1 text-[var(--color-accent)] transition disabled:opacity-40"
        >
          <Icon as={CornerDownLeft} size={13} />
        </button>
      </form>
      {notice && (
        <p
          data-testid="card-prompt-notice"
          className="mt-0.5 truncate text-[10px] text-[var(--color-text-dim)]"
          title={notice}
        >
          {notice}
        </p>
      )}
    </Interactive>
  )
}

// O terminal REAL da sessão no lugar do cartão: o mesmo Terminal das abas,
// anexado à MESMA PTY (backlog replicado no mount), sem header (encerrar não fica
// a um clique) e no renderer DOM — ver a prop `renderer` do Terminal.
export function CardTerminal({ node, onLeave }: { node: SessionGraphNode; onLeave: () => void }) {
  const live = useAppStore((s) => s.liveSessions.find((x) => x.id === node.sessionId))
  if (!live) return null
  return (
    <div
      data-card-terminal
      className="nodrag nopan nowheel relative min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--color-border)]"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Terminal
        session={sessionFromLiveSession(live, null)}
        repoLabel={live.repo?.label ?? 'Avulsa'}
        repoPath={live.repo?.path ?? ''}
        projectName={live.projectName ?? ''}
        projectIcon={live.projectIcon}
        projectColor={live.projectColor}
        mode="terminal"
        chrome="bare"
        composer="compact"
        renderer="dom"
        onClose={onLeave}
      />
    </div>
  )
}
