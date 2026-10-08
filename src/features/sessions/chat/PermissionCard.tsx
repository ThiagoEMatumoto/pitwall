import { useState } from 'react'
import { ChevronRight, FolderLock, ShieldQuestion } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { ApexDot, GradientBorder, Ruler } from '@/features/brand'
import type { TuiMenuOption } from '../tui-menu-parser'

interface Props {
  // 'permission' = y/n de tool (Edit/Bash/etc.); 'trust' = trust de diretório.
  kind: 'permission' | 'trust'
  // Pergunta original do buffer ("Do you want to make this edit to …?").
  question?: string
  // Box acima da pergunta (diff/comando/config sendo aprovado) — o usuário
  // precisa VER o que está aprovando. Ausente = parser não capturou (fail-soft).
  context?: string
  options: TuiMenuOption[]
  // Clique-pra-responder: presente = o ChatView liberou (menu íntegro + guards).
  // O handler de lá re-checa via re-parse fresco antes de digitar no PTY.
  onRespond?: (optionIndex: number, label: string) => void
  // Label da opção clicada, enquanto o menu não some do buffer.
  sentLabel?: string
}

// Contexto curto fica aberto; diffs longos começam colapsados.
const CONTEXT_OPEN_MAX_LINES = 8

// Estilo do botão por semântica do label: "Yes" primeiro = ação primária;
// "No…" = danger (rejeitar/sair); demais ("Yes, allow all edits…", "Yes, and
// remember…") neutras — são as opções que mudam estado persistente do CLI.
function buttonClass(label: string, first: boolean): string {
  if (first && /^Yes/i.test(label))
    return 'border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10 hover:bg-[var(--color-accent)]/25'
  if (/^No/i.test(label))
    return 'border-[var(--color-danger)]/40 hover:border-[var(--color-danger)]/70 hover:bg-[var(--color-danger)]/10'
  return 'border-[var(--color-border)] hover:border-[var(--color-text-dim)]'
}

// Render dedicado dos prompts TTY-only espelhados do buffer da TUI (permissão de
// tool e trust de diretório) — eles NUNCA aparecem no JSONL, nem após a resposta.
// O clique envia o DÍGITO da opção ao PTY (seleciona e submete), mesmo caminho
// dos cards da F3b.
export function PermissionCard({ kind, question, context, options, onRespond, sentLabel }: Props) {
  const contextLines = context ? context.split('\n').length : 0
  const [open, setOpen] = useState(contextLines <= CONTEXT_OPEN_MAX_LINES)
  const sent = sentLabel != null
  const clickable = onRespond != null && !sent

  const title = kind === 'trust' ? 'Confiar neste diretório?' : 'Permissão — sua decisão'

  return (
    // Card de decisão: borda-gradiente ativa (é sempre o momento pendente).
    <GradientBorder active radius={16} style={{ display: 'block', width: '100%' }} innerClassName="text-sm">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2.5">
        <span className="flex items-center gap-2.5 font-semibold text-[var(--color-text)]">
          {/* Único ApexDot pulsante da vista enquanto pende (some ao enviar). */}
          <ApexDot size={7} active={!sent} />
          <Icon
            as={kind === 'trust' ? FolderLock : ShieldQuestion}
            size={14}
            className="shrink-0 text-[var(--color-warning)]"
          />
          {title}
        </span>
        {!sent && <Ruler variant="equalizer" count={6} height={11} />}
      </div>
      <div className="flex flex-col gap-2 px-4 py-3">
        {question && <div className="text-[var(--color-text)]">{question}</div>}
        {context && (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="flex w-full items-center gap-1 px-2 py-1 text-left text-xs text-[var(--color-text-dim)]"
            >
              <Icon
                as={ChevronRight}
                size={11}
                className={`shrink-0 transition ${open ? 'rotate-90' : ''}`}
              />
              O que está sendo aprovado
            </button>
            {open && (
              <pre className="max-h-64 overflow-auto px-2 pb-2 font-mono text-xs leading-relaxed text-[var(--color-text)]/90">
                {context}
              </pre>
            )}
          </div>
        )}
        <div className="flex flex-col gap-1">
          {options.map((opt, oi) => {
            const sentSelected = sent && opt.label === sentLabel
            const content = (
              <div className="min-w-0">
                <div className="font-medium text-[var(--color-text)]/90">{opt.label}</div>
                {opt.description && (
                  <div className="text-xs text-[var(--color-text-dim)]">{opt.description}</div>
                )}
              </div>
            )
            if (clickable) {
              return (
                <button
                  key={oi}
                  type="button"
                  // Atalho 1/2/3 da Room: clica a opção N pelo mesmo caminho guardado.
                  data-permission-option={oi + 1}
                  onClick={() => onRespond(oi, opt.label)}
                  className={`flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left transition ${buttonClass(opt.label, oi === 0)}`}
                >
                  {content}
                </button>
              )
            }
            return (
              <div
                key={oi}
                className={`flex items-start gap-2 rounded border px-2 py-1.5 ${
                  sentSelected
                    ? 'border-[var(--color-accent)]/60 bg-[var(--color-surface-2)]'
                    : 'border-[var(--color-border)] opacity-70'
                }`}
              >
                {content}
              </div>
            )
          })}
        </div>
        <div className="font-mono text-[10px] text-[var(--color-text-dim)]/70">
          {sent
            ? 'Resposta enviada…'
            : '⏎ responde · esc rejeita — enviado direto ao terminal.'}
        </div>
      </div>
    </GradientBorder>
  )
}
