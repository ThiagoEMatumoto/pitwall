import { useState } from 'react'
import { CheckCircle2, Clock, CornerDownLeft, XCircle } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'
import { Kbd } from '@/components/ui/ShortcutHints'
import { ApexDot, Button, GradientBorder, Ruler } from '@/features/brand'

interface Props {
  plan: string
  // undefined = aguardando aprovação; true = aprovado; false = rejeitado/feedback.
  decision?: boolean
  // Clique-pra-decidir: presente = o ChatView liberou (card é o momento pendente +
  // sessão 'waiting'). O handler de lá re-checa os guards no clique.
  onDecide?: (d: 'approve' | 'reject') => void
  // Decisão já clicada, aguardando a decision real chegar no JSONL (forId).
  sent?: boolean
  // Falso quando a opção de aprovação MANUAL não foi achada no menu TUI parseado:
  // sem dígito seguro pra aprovar (Enter cego acertaria "auto-accept edits"), o
  // botão de aprovar não é oferecido — só rejeitar (Esc) + dica de ir ao terminal.
  canApprove?: boolean
}

// Planos longos começam colapsados pra não tomar a conversa inteira.
const COLLAPSE_THRESHOLD = 1200

// Render dedicado de um ExitPlanMode (substitui o tool card genérico). Mostra o
// plano em markdown (colapsável) + o estado de aprovação derivado do tool_result.
// Com onDecide presente e decisão pendente, expõe botões de aprovar/rejeitar que
// enviam a decisão ao PTY; a decision real do JSONL substitui o estado otimista.
export function PlanCard({ plan, decision, onDecide, sent, canApprove = true }: Props) {
  const [open, setOpen] = useState(plan.length <= COLLAPSE_THRESHOLD)
  const pending = decision === undefined

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
      {/* Botões de decisão: só enquanto a decisão real não chegou. `sent` mantém os
          botões visíveis porém desabilitados até o JSONL confirmar. */}
      {pending && (onDecide != null || sent) && (
        <div className="flex flex-wrap items-center gap-2.5 border-t border-[var(--color-border)] px-4 py-3">
          {canApprove ? (
            <Button
              variant="primary"
              size="sm"
              disabled={sent || onDecide == null}
              onClick={() => onDecide?.('approve')}
            >
              Aprovar plano
            </Button>
          ) : (
            <span className="text-xs text-[var(--color-text-dim)]">
              Pra aprovar, use o terminal.
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={sent || onDecide == null}
            onClick={() => onDecide?.('reject')}
          >
            Continuar planejando
          </Button>
          <span
            data-testid="plan-shortcuts"
            className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-dim)]"
          >
            {sent ? (
              'Decisão enviada…'
            ) : (
              <>
                {/* O glifo ⏎ não existe nas fontes da UI: tecla com ícone. */}
                <Kbd>
                  <Icon as={CornerDownLeft} size={10} aria-label="Enter" />
                </Kbd>
                aprova · <Kbd>esc</Kbd> rejeita
              </>
            )}
          </span>
        </div>
      )}
    </GradientBorder>
  )
}
