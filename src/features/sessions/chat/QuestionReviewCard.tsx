import { CheckCheck } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

interface Props {
  // Resumo "pergunta → resposta" (TuiMenu.context da tela de revisão).
  summary?: string
  // Clique-pra-responder: dígito 1 (Submit answers) ou 2 (Cancel) — validado
  // ao vivo. Ausente = read-only (sessão não está mais 'waiting' nesse menu).
  onDecide?: (decision: 'submit' | 'cancel') => void
  sent?: boolean
}

// Tela final do multi-select/multi-pergunta ("Review your answers") — kind
// próprio no parser (`question_review`), depois de navegar pela barra de
// abas até "Submit". Confirmar aqui é o que de fato envia as respostas
// marcadas nas perguntas anteriores. Cancelar NÃO volta pra edição: no 2.1.318 recusa
// a pergunta inteira (tool_result user-rejected, sonda question-multi-keys2).
export function QuestionReviewCard({ summary, onDecide, sent }: Props) {
  const clickable = onDecide != null && !sent

  return (
    <div className="rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-surface)]/60 text-sm">
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
        <Icon as={CheckCheck} size={14} className="shrink-0 text-[var(--color-accent)]" />
        <span className="font-medium text-[var(--color-text)]">Revise suas respostas</span>
      </div>
      <div className="flex flex-col gap-2 px-3 py-2.5">
        {summary && (
          <pre className="whitespace-pre-wrap rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1.5 font-mono text-xs leading-relaxed text-[var(--color-text)]/90">
            {summary}
          </pre>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!clickable}
            onClick={() => onDecide?.('submit')}
            className="rounded border border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10 px-2.5 py-1 text-xs font-medium transition hover:bg-[var(--color-accent)]/25 disabled:opacity-40"
          >
            Enviar respostas
          </button>
          <button
            type="button"
            disabled={!clickable}
            onClick={() => onDecide?.('cancel')}
            className="rounded border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium transition hover:border-[var(--color-danger)]/40 disabled:opacity-40"
          >
            Recusar responder
          </button>
        </div>
        <div className="text-xs text-[var(--color-text-dim)]">
          {sent
            ? 'Resposta enviada…'
            : 'Enviar manda as respostas marcadas. Recusar encerra a pergunta sem resposta.'}
        </div>
      </div>
    </div>
  )
}
