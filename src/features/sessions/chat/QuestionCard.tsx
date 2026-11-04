import { useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  MessageCircleQuestion,
  MessagesSquare,
  Square,
  SquareCheck,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { ChatQuestion } from '../../../../shared/types/ipc'
import { questionPositionLabel } from '../tui-menu-parser'

interface Props {
  questions: ChatQuestion[]
  // Mapa pergunta→opção(ões) escolhida(s); ausente = ainda não respondido. Em
  // multiSelect o valor vem como "Opção A, Opção B" (labels juntos por ", ").
  answers?: Record<string, string>
  // Clique-pra-responder single-select (com ou sem preview — quem decide a
  // sequência de teclas certa é o ChatView via buildSelectKeys). Presente =
  // liberado (card é o momento pendente + sessão 'waiting').
  onRespond?: (optionIndex: number, label: string) => void
  // Clique num checkbox de multi-select: dígito faz TOGGLE, nunca submete —
  // submeter de fato é só na tela de revisão (QuestionReviewCard).
  onToggle?: (optionIndex: number, label: string) => void
  // Envio do campo "Other" (texto livre). Single-select: é a resposta. Multi-select: só
  // marca a opção com o texto (o envio continua no "Enviar respostas").
  onOtherSubmit?: (optionIndex: number, text: string) => void
  // Sentinela "Chat about this": recusa a pergunta pra conversar; o usuário escreve
  // depois pelo composer.
  onChat?: () => void
  // Label da opção clicada, enquanto a resposta real não chega no JSONL (forId).
  sentLabel?: string
  // Barra de abas (multi-pergunta/multi-select) — a pergunta atual já vem em
  // `questions[0]`; os botões só navegam (nunca submetem).
  tabs?: { label: string; done: boolean }[]
  onTabNav?: (direction: 'next' | 'prev') => void
  // Multi-select PURO (Bug 3): botão dedicado que sai da tela de checkboxes —
  // navegar as abas sozinho nunca chega na revisão, precisa de Enter separado
  // (ver buildMultiSelectSubmitKeys). Ausente/sem tabs = sem botão.
  onSubmitMulti?: () => void
}

// Uma opção foi escolhida se bate exata (single) ou aparece na lista juntada
// (multiSelect). includes como rede de segurança pra separadores fora do padrão.
function isSelected(answer: string | undefined, label: string): boolean {
  if (answer == null) return false
  return answer === label || answer.split(', ').includes(label) || answer.includes(label)
}

// Campo inline pra "Other" (texto livre): dígito já selecionou a linha (o
// clique inicial), o texto aqui vira a resposta digitada. Enter vazio NUNCA
// envia — na TUI real isso é lido como "declinou responder".
function OtherField({
  onSubmit,
  disabled,
  multi,
  typed,
}: {
  onSubmit: (text: string) => void
  disabled?: boolean
  multi?: boolean
  // Texto já digitado no terminal: o campo de lá tem dono, este só mostra.
  typed?: string
}) {
  const [text, setText] = useState('')
  const canSubmit = !disabled && typed == null && text.trim() !== ''
  function submit() {
    if (canSubmit) onSubmit(text)
  }
  if (typed != null) {
    return (
      <div
        data-testid="question-other-typed"
        className="rounded border border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-text-dim)]"
      >
        Outra: <span className="text-[var(--color-text)]">{typed}</span> (digitado no terminal)
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 rounded border border-[var(--color-border)] px-2 py-1.5">
      <input
        type="text"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
        data-testid="question-other-input"
        placeholder={multi ? 'Outra opção…' : 'Digite sua resposta…'}
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
      />
      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5 text-xs font-medium transition hover:border-[var(--color-accent)]/60 disabled:opacity-40"
      >
        {multi ? 'Marcar' : 'Enviar'}
      </button>
    </div>
  )
}

// Render dedicado de um AskUserQuestion (substitui o tool card genérico). Mostra
// header + pergunta + opções (label em destaque, description abaixo). Quando
// respondido, marca a(s) opção(ões) escolhida(s). Interatividade V1 só pra
// pergunta ÚNICA (multi-pergunta = tabs, ver `tabs`/`onTabNav`):
// - single-select: clique = onRespond (o ChatView decide dígito-só ou
//   dígito+Enter, conforme `submitOnDigit` do menu parseado).
// - multiSelect: clique = onToggle (checkbox, nunca submete sozinho).
// - "Other" (texto livre): campo de texto inline via onOtherSubmit. No multi-select
//   ele só marca a opção com o texto (sondas 2.1.317/318); o envio é o botão.
// - "Chat about this": botão próprio (onChat), fora da lista de opções.
export function QuestionCard({
  questions,
  answers,
  onRespond,
  onToggle,
  onOtherSubmit,
  sentLabel,
  tabs,
  onTabNav,
  onSubmitMulti,
  onChat,
}: Props) {
  const answered = answers != null
  const sent = sentLabel != null && !answered
  const q = questions.length === 1 ? questions[0] : null
  const selectClickable = onRespond != null && !answered && !sent && q != null && !q.multiSelect
  const toggleClickable = onToggle != null && !answered && !sent && q != null && q.multiSelect
  const preview = q?.options.find((o) => o.preview != null)?.preview
  // Multi-pergunta numa só chamada: a barra de abas já indica progresso
  // (rótulos + done), mas "Pergunta X de Y" deixa explícito sem precisar
  // decodificar os chips — undefined pra multi-select puro (ver questionPositionLabel).
  const positionLabel = questionPositionLabel(tabs, q?.multiSelect ?? false)

  return (
    <div className="rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-surface)]/60 text-sm">
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
        <Icon as={MessageCircleQuestion} size={14} className="shrink-0 text-[var(--color-accent)]" />
        <span className="font-medium text-[var(--color-text)]">
          {answered ? 'Pergunta respondida' : 'Claude perguntou'}
        </span>
      </div>
      {tabs && tabs.length > 0 && (
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-1.5 text-xs">
          {positionLabel && (
            <span className="shrink-0 text-[var(--color-text-dim)]">{positionLabel}</span>
          )}
          <button
            type="button"
            onClick={() => onTabNav?.('prev')}
            disabled={onTabNav == null}
            className="shrink-0 rounded p-0.5 text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-30"
            aria-label="Aba anterior"
          >
            <Icon as={ArrowLeft} size={13} />
          </button>
          <div className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            {tabs.map((t, ti) => (
              <span
                key={ti}
                className={`rounded px-1.5 py-0.5 ${
                  t.done
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : 'text-[var(--color-text-dim)]'
                }`}
              >
                {t.label}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onTabNav?.('next')}
            disabled={onTabNav == null}
            className="shrink-0 rounded p-0.5 text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-30"
            aria-label="Próxima aba"
          >
            <Icon as={ArrowRight} size={13} />
          </button>
        </div>
      )}
      <div className="flex flex-col gap-3 px-3 py-2.5">
        {questions.map((qq, qi) => {
          const answer = answers?.[qq.question]
          return (
            <div key={qi} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                {qq.header && (
                  <span className="shrink-0 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]">
                    {qq.header}
                  </span>
                )}
                <span className="text-[var(--color-text)]">{qq.question}</span>
                {qq.multiSelect && (
                  <span className="shrink-0 text-[10px] text-[var(--color-text-dim)]">
                    (múltipla)
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1">
                {qq.options.map((opt, oi) => {
                  const selected = isSelected(answer, opt.label)
                  // Eco otimista do clique: check em tom dim até a resposta real
                  // chegar no transcript e virar `selected`.
                  const sentSelected = sent && opt.label === sentLabel

                  if (opt.sentinel === 'other' && qq === q) {
                    return (
                      <OtherField
                        key={oi}
                        multi={qq.multiSelect}
                        typed={opt.otherText}
                        disabled={onOtherSubmit == null || answered || sent}
                        onSubmit={(text) => onOtherSubmit?.(oi, text)}
                      />
                    )
                  }

                  if (qq.multiSelect) {
                    const content = (
                      <>
                        <Icon
                          as={opt.checked ? SquareCheck : Square}
                          size={13}
                          className={`mt-0.5 shrink-0 ${
                            opt.checked ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)]'
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-[var(--color-text)]/90">{opt.label}</div>
                          {opt.description && (
                            <div className="text-xs text-[var(--color-text-dim)]">
                              {opt.description}
                            </div>
                          )}
                        </div>
                      </>
                    )
                    if (toggleClickable) {
                      return (
                        <button
                          key={oi}
                          type="button"
                          onClick={() => onToggle?.(oi, opt.label)}
                          className="flex w-full items-start gap-2 rounded border border-[var(--color-border)] px-2 py-1.5 text-left transition hover:border-[var(--color-accent)]/60 hover:bg-[var(--color-accent)]/10"
                        >
                          {content}
                        </button>
                      )
                    }
                    return (
                      <div
                        key={oi}
                        className="flex items-start gap-2 rounded border border-[var(--color-border)] px-2 py-1.5"
                      >
                        {content}
                      </div>
                    )
                  }

                  const content = (
                    <>
                      <Icon
                        as={Check}
                        size={13}
                        className={`mt-0.5 shrink-0 ${
                          selected
                            ? 'text-[var(--color-accent)]'
                            : sentSelected
                              ? 'text-[var(--color-text-dim)]'
                              : 'text-transparent'
                        }`}
                      />
                      <div className="min-w-0">
                        <div
                          className={`font-medium ${selected ? 'text-[var(--color-text)]' : 'text-[var(--color-text)]/90'}`}
                        >
                          {opt.label}
                        </div>
                        {opt.description && (
                          <div className="text-xs text-[var(--color-text-dim)]">
                            {opt.description}
                          </div>
                        )}
                      </div>
                    </>
                  )
                  if (selectClickable && qq === q) {
                    return (
                      <button
                        key={oi}
                        type="button"
                        onClick={() => onRespond?.(oi, opt.label)}
                        className="flex w-full items-start gap-2 rounded border border-[var(--color-border)] px-2 py-1.5 text-left transition hover:border-[var(--color-accent)]/60 hover:bg-[var(--color-accent)]/10"
                      >
                        {content}
                      </button>
                    )
                  }
                  return (
                    <div
                      key={oi}
                      className={`flex items-start gap-2 rounded border px-2 py-1.5 ${
                        selected
                          ? 'border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10'
                          : sentSelected
                            ? 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
                            : 'border-[var(--color-border)]'
                      }`}
                    >
                      {content}
                    </div>
                  )
                })}
              </div>
              {qq === q && qq.multiSelect && toggleClickable && onSubmitMulti && (
                <button
                  type="button"
                  data-testid="question-submit-multi"
                  onClick={onSubmitMulti}
                  className="self-start rounded border border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10 px-2 py-1 text-xs font-medium text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/20"
                >
                  Enviar respostas
                </button>
              )}
              {qq === q && onChat && !answered && (
                <button
                  type="button"
                  data-testid="question-chat"
                  disabled={sent}
                  onClick={onChat}
                  title="Recusa a pergunta dizendo que você quer esclarecer; depois escreva pelo compositor."
                  className="flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-xs text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-40"
                >
                  <Icon as={MessagesSquare} size={12} />
                  Conversar sobre isso
                </button>
              )}
              {qq === q && preview && (
                <pre className="max-h-48 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1.5 font-mono text-xs leading-relaxed text-[var(--color-text)]/90">
                  {preview}
                </pre>
              )}
            </div>
          )
        })}
        {!answered && (
          <div className="text-xs text-[var(--color-text-dim)]">
            {sent
              ? 'Resposta enviada…'
              : selectClickable
                ? 'Clique numa opção pra responder — ou escreva no compositor.'
                : toggleClickable
                  ? 'Marque as opções e clique em "Enviar respostas": a revisão vem em seguida.'
                  : 'Aguardando a resposta.'}
          </div>
        )}
      </div>
    </div>
  )
}
