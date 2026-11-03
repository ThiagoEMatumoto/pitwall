import { useState } from 'react'
import { CheckCircle2, Clock, XCircle } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'
import { Kbd } from '@/components/ui/ShortcutHints'
import { ApexDot, Button, GradientBorder, Ruler } from '@/features/brand'
import type { PlanIntent } from '../tui-menu-parser'
import type { PlanChoice } from './plan-choices'
import { useChatFallback } from './useChatFallback'

export type PlanDecision = Exclude<PlanIntent, 'feedback'> | 'feedback' | 'reject'

interface Props {
  plan: string
  // undefined = aguardando aprovação; true = aprovado; false = rejeitado/feedback.
  decision?: boolean
  // Clique-pra-decidir: presente = o ChatView liberou (card é o momento pendente +
  // sessão 'waiting'). O handler de lá re-checa os guards no clique.
  onDecide?: (d: PlanDecision, feedback?: string) => void
  // Decisão já clicada, aguardando a decision real chegar no JSONL (forId).
  sent?: boolean
  // Uma por opção real do diálogo (planChoices). Vazio + sem feedback = nada a clicar.
  choices?: PlanChoice[]
  // O diálogo tem o campo "Tell Claude what to change".
  canFeedback?: boolean
  notice?: string | null
}

// Planos longos começam colapsados pra não tomar a conversa inteira.
const COLLAPSE_THRESHOLD = 1200

function FeedbackField({
  disabled,
  onSend,
}: {
  disabled: boolean
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
  const canSend = !disabled && text.trim() !== ''
  return (
    <div className="flex items-end gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5">
      <textarea
        rows={2}
        value={text}
        disabled={disabled}
        maxLength={4000}
        data-testid="plan-feedback"
        aria-label="Pedir mudanças no plano"
        placeholder="Pedir mudanças: o que o Claude deve mudar no plano?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey) return
          e.preventDefault()
          if (canSend) onSend(text)
        }}
        className="min-w-0 flex-1 resize-none bg-transparent text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={!canSend}
        data-testid="plan-feedback-send"
        onClick={() => onSend(text)}
      >
        Pedir mudanças
      </Button>
    </div>
  )
}

// Render dedicado de um ExitPlanMode (substitui o tool card genérico). Mostra o
// plano em markdown (colapsável) + o estado de aprovação derivado do tool_result.
// Pendente e com o diálogo vivo, mostra uma ação por opção real da TUI, o campo de
// mudanças e o descarte (Esc); a decision real do JSONL substitui o estado otimista.
export function PlanCard({
  plan,
  decision,
  onDecide,
  sent,
  choices = [],
  canFeedback = false,
  notice,
}: Props) {
  const [open, setOpen] = useState(plan.length <= COLLAPSE_THRESHOLD)
  const [armed, setArmed] = useState<PlanChoice['intent'] | null>(null)
  const pending = decision === undefined
  const live = onDecide != null || sent === true
  const disabled = sent === true || onDecide == null
  const noOptions = pending && live && choices.length === 0 && !canFeedback
  useChatFallback(noOptions ? 'plan' : null, 'no-options')

  const status =
    decision === true
      ? { icon: CheckCircle2, label: 'Aprovado', cls: 'text-[var(--color-success)]' }
      : decision === false
        ? { icon: XCircle, label: 'Rejeitado', cls: 'text-[var(--color-danger)]' }
        : { icon: Clock, label: 'Aguardando decisão', cls: 'text-[var(--color-text-dim)]' }

  return (
    // Card de decisão: borda-gradiente ativa enquanto pende, sólida após decidir.
    <GradientBorder
      active={pending}
      radius={16}
      style={{ display: 'block', width: '100%' }}
      innerClassName="text-sm"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2.5">
        <span className="flex items-center gap-2.5 font-semibold text-[var(--color-text)]">
          {/* Único ApexDot pulsante da vista (só quando pendente). */}
          <ApexDot size={7} active={pending} />
          Plano pronto — sua decisão
        </span>
        <span className={`flex shrink-0 items-center gap-2 font-mono text-[10px] ${status.cls}`}>
          {pending && <Ruler variant="equalizer" count={6} height={11} />}
          <span className="flex items-center gap-1">
            <Icon as={status.icon} size={12} />
            {status.label}
          </span>
        </span>
      </div>
      {open ? (
        <div className="px-4 py-3">
          <MarkdownViewer content={plan} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full px-4 py-2.5 text-left text-xs text-[var(--color-text-dim)]"
        >
          Plano longo — clique para expandir.
        </button>
      )}
      {pending && live && (
        <div className="flex flex-col gap-2.5 border-t border-[var(--color-border)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {choices.map((c) => (
              <Button
                key={c.intent}
                variant={c.tone}
                size="sm"
                disabled={disabled}
                title={c.optionLabel}
                data-testid={`plan-choice-${c.intent}`}
                data-highlighted={c.highlighted || undefined}
                onClick={() => {
                  if (c.confirm && armed !== c.intent) return setArmed(c.intent)
                  setArmed(null)
                  onDecide?.(c.intent)
                }}
              >
                {armed === c.intent ? 'Confirmar bypass: sem mais prompts nesta sessão' : c.label}
                {c.highlighted && (
                  <span className="rounded-full border border-current/40 px-1.5 text-[9px] font-normal opacity-80">
                    destaque no terminal
                  </span>
                )}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid="plan-choice-reject"
              title="Esc: rejeita o plano sem mandar mudanças"
              onClick={() => onDecide?.('reject')}
            >
              Descartar
            </Button>
          </div>
          {canFeedback && (
            <FeedbackField disabled={disabled} onSend={(t) => onDecide?.('feedback', t)} />
          )}
          {noOptions && (
            <p className="text-xs text-[var(--color-text-dim)]">
              Nenhuma opção de aprovação reconhecida neste diálogo.
            </p>
          )}
          <span
            data-testid="plan-shortcuts"
            className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-dim)]"
          >
            {sent ? (
              'Decisão enviada…'
            ) : (
              <>
                <Kbd>esc</Kbd> no compositor vazio descarta
              </>
            )}
          </span>
          {notice && (
            <p
              role="alert"
              data-testid="plan-notice"
              className="text-xs text-[var(--color-warning)]"
            >
              {notice}
            </p>
          )}
        </div>
      )}
    </GradientBorder>
  )
}
