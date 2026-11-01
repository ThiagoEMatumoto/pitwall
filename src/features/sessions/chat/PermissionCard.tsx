import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  ChevronRight,
  CornerDownLeft,
  Zap,
  FileDiff,
  FolderLock,
  Plug,
  TerminalSquare,
  ShieldQuestion,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { ApexDot } from '@/features/brand'
import { menuFingerprint, type TuiMenu } from '../tui-menu-parser'
import { permissionView, type DiffLine, type PermissionView } from './permission-view'

export type PermissionDecision =
  | { type: 'select'; optionIndex: number; label: string }
  | { type: 'amend'; optionIndex: number; label: string; text: string }
  // Aprova e grava a regra no allow de todas as filhas (handoffs:learn-child-rule).
  | { type: 'children'; optionIndex: number; label: string }

interface Props {
  menu: TuiMenu
  // Ausente = só leitura (sessão sem caminho de resposta).
  onDecide?: (decision: PermissionDecision) => void
  // Rótulo do que foi enviado, enquanto o prompt não some da tela.
  sentLabel?: string
  // Falha do caminho guardado (menu mudou, sessão encerrou…), em pt-BR.
  notice?: string | null
  // Sessão filha com regra derivável: oferece "Sempre permitir para filhas".
  childRule?: string | null
  autoFocus?: boolean
}

// Diff curto fica aberto; longo começa nas primeiras linhas, com "mostrar tudo".
const DIFF_PREVIEW_LINES = 14

const KIND_ICON = {
  command: TerminalSquare,
  file: FileDiff,
  tool: Plug,
  trust: FolderLock,
  generic: ShieldQuestion,
} as const

function isEditable(el: Element | null): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el as HTMLElement | null)?.isContentEditable === true
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center gap-0.5 rounded border border-[var(--color-border)] px-1 font-mono text-[10px] leading-4 text-[var(--color-text-dim)]">
      {children}
    </kbd>
  )
}

// O glifo ⏎ não existe nas fontes da UI e vira um quadrado: ícone no lugar.
function EnterKey() {
  return <Icon as={CornerDownLeft} size={10} aria-label="Enter" />
}

export function DiffBlock({ lines }: { lines: DiffLine[] }) {
  const long = lines.length > DIFF_PREVIEW_LINES
  const [all, setAll] = useState(!long)
  const shown = all ? lines : lines.slice(0, DIFF_PREVIEW_LINES)
  const added = lines.filter((l) => l.sign === '+').length
  const removed = lines.filter((l) => l.sign === '-').length
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-3 py-1.5 font-mono text-[11px]">
        <span className="text-[var(--color-success)]">+{added}</span>
        <span className="text-[var(--color-danger)]">−{removed}</span>
      </div>
      <div
        className="max-h-72 overflow-auto py-1 font-mono text-xs leading-relaxed"
        data-testid="permission-diff"
      >
        {shown.map((l, i) => (
          <div
            key={i}
            data-sign={l.sign}
            className="flex gap-3 px-3"
            style={
              l.sign === ' '
                ? undefined
                : {
                    background: `color-mix(in srgb, var(--color-${l.sign === '+' ? 'success' : 'danger'}) 12%, transparent)`,
                  }
            }
          >
            <span className="w-8 shrink-0 select-none text-right text-[var(--color-text-dim)]/70">
              {l.num}
            </span>
            <span
              className={`w-3 shrink-0 select-none ${l.sign === '+' ? 'text-[var(--color-success)]' : l.sign === '-' ? 'text-[var(--color-danger)]' : 'text-transparent'}`}
            >
              {l.sign === '-' ? '−' : l.sign}
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-all text-[var(--color-text)]/90">
              {l.text}
            </span>
          </div>
        ))}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="flex w-full items-center gap-1 border-t border-[var(--color-border)] px-3 py-1.5 text-left text-xs text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)]"
        >
          <Icon
            as={ChevronRight}
            size={11}
            className={`transition-transform motion-reduce:transition-none ${all ? 'rotate-90' : ''}`}
          />
          {all ? 'Mostrar menos' : `Mostrar as ${lines.length} linhas`}
        </button>
      )}
    </div>
  )
}

function Preview({ view }: { view: PermissionView }) {
  return (
    <>
      {view.description && (
        <p className="text-[13px] text-[var(--color-text-dim)]">{view.description}</p>
      )}
      {view.command && (
        <pre
          data-testid="permission-command"
          className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--color-text)]"
        >
          <span className="select-none text-[var(--color-text-dim)]">$ </span>
          {view.command}
        </pre>
      )}
      {view.kind === 'file' && view.target && (
        <p className="truncate font-mono text-xs text-[var(--color-text-dim)]" title={view.target}>
          {view.target}
        </p>
      )}
      {view.diff && view.diff.length > 0 && <DiffBlock lines={view.diff} />}
      {view.notes.length > 0 && (
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-text-dim)]">
          {view.notes.map((n) => n.trim()).join('\n')}
        </p>
      )}
    </>
  )
}

// Card de decisão dos prompts TTY-only (permissão de tool / trust de pasta). Ele
// só declara a intenção; quem hospeda envia pelo caminho guardado do main, que
// relê a tela e recusa se o menu mudou.
export function PermissionCard({
  menu,
  onDecide,
  sentLabel,
  notice,
  childRule,
  autoFocus = true,
}: Props) {
  const view = useMemo(() => permissionView(menu), [menu])
  const titleId = useId()
  const rootRef = useRef<HTMLElement>(null)
  const [explaining, setExplaining] = useState(false)
  const [confirmAuto, setConfirmAuto] = useState(false)
  const [reason, setReason] = useState('')
  // Pedido novo na mesma sessão: o motivo digitado era para o anterior.
  const fp = menuFingerprint(menu)
  const [reasonFp, setReasonFp] = useState(fp)
  if (reasonFp !== fp) {
    setReasonFp(fp)
    setExplaining(false)
    setReason('')
    setConfirmAuto(false)
  }
  const sent = sentLabel != null
  const live = onDecide != null && !sent
  const isTrust = view.kind === 'trust'
  const always = view.always[0]

  // Foco no card para Enter/Esc funcionarem sem mirar o mouse — mas nunca tirando
  // de quem está digitando no compositor.
  useEffect(() => {
    if (!autoFocus || !live) return
    if (isEditable(document.activeElement) && (document.activeElement as HTMLInputElement).value)
      return
    rootRef.current?.focus({ preventScroll: true })
  }, [autoFocus, live, menu])

  function decide(d: PermissionDecision) {
    if (live) onDecide(d)
  }
  function approve() {
    if (view.approve)
      decide({
        type: 'select',
        optionIndex: view.approve.optionIndex,
        label: view.approve.optionLabel,
      })
  }
  function deny() {
    if (view.deny)
      decide({ type: 'select', optionIndex: view.deny.optionIndex, label: view.deny.optionLabel })
  }
  function sendReason() {
    const text = reason.trim()
    if (!view.deny || text === '') return
    decide({ type: 'amend', optionIndex: view.deny.optionIndex, label: `Negado: ${text}`, text })
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (!live) return
    const inField = isEditable(e.target as Element)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (explaining) setExplaining(false)
      else if (confirmAuto) setConfirmAuto(false)
      else deny()
      return
    }
    if (e.key !== 'Enter' || e.shiftKey) return
    if (inField) {
      e.preventDefault()
      e.stopPropagation()
      sendReason()
      return
    }
    // Enter num botão focado já o aciona; não aprovar por cima.
    if (e.target instanceof HTMLButtonElement) return
    e.preventDefault()
    e.stopPropagation()
    if ((e.metaKey || e.ctrlKey) && always) {
      decide({ type: 'select', optionIndex: always.optionIndex, label: always.optionLabel })
    } else approve()
  }

  if (sent) {
    return (
      <div
        role="status"
        data-testid="permission-sent"
        className="pw-pop flex items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm text-[var(--color-text-dim)]"
      >
        <ApexDot size={6} active={false} />
        <span className="min-w-0 flex-1 truncate">
          {view.title} · <span className="text-[var(--color-text)]">{sentLabel}</span>
        </span>
        <span className="shrink-0 text-xs">Enviado</span>
      </div>
    )
  }

  const mapped = new Set(
    [view.approve, view.deny, view.autoMode, ...view.always]
      .filter(Boolean)
      .map((c) => c!.optionIndex),
  )
  const unmapped = menu.options.filter((o) => !mapped.has(o.index))

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      role="group"
      aria-labelledby={titleId}
      data-testid="permission-card"
      data-kind={view.kind}
      onKeyDown={onKeyDown}
      className="pw-pop flex flex-col gap-3 rounded-2xl border bg-[var(--color-surface)] px-4 py-3.5 text-sm shadow-lg outline-none transition-shadow focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
      style={{ borderColor: 'color-mix(in srgb, var(--color-warning) 45%, var(--color-border))' }}
    >
      <header className="flex items-center gap-2.5">
        <ApexDot size={7} active={live} />
        <Icon
          as={KIND_ICON[view.kind]}
          size={15}
          className="shrink-0 text-[var(--color-warning)]"
        />
        <h3
          id={titleId}
          className="min-w-0 flex-1 truncate font-semibold text-[var(--color-text)]"
          title={menu.question}
        >
          {view.title}
        </h3>
      </header>

      <Preview view={view} />

      {live ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {view.approve && (
              <Button
                data-testid="permission-approve"
                data-permission-option={view.approve.optionIndex + 1}
                title={view.approve.optionLabel}
                onClick={approve}
              >
                {isTrust ? 'Confiar' : 'Aprovar'}{' '}
                <Kbd>
                  <EnterKey />
                </Kbd>
              </Button>
            )}
            {always && (
              <Button
                variant="ghost"
                data-testid="permission-always"
                data-permission-option={always.optionIndex + 1}
                title={always.optionLabel}
                onClick={() =>
                  decide({
                    type: 'select',
                    optionIndex: always.optionIndex,
                    label: always.optionLabel,
                  })
                }
              >
                Sempre permitir{' '}
                <Kbd>
                  Ctrl
                  <EnterKey />
                </Kbd>
              </Button>
            )}
            {view.deny && (
              <Button
                variant="danger"
                data-testid="permission-deny"
                data-permission-option={view.deny.optionIndex + 1}
                title={view.deny.optionLabel}
                onClick={deny}
              >
                {isTrust ? 'Sair' : 'Negar'} <Kbd>esc</Kbd>
              </Button>
            )}
          </div>
          {always && (
            <p
              data-testid="permission-always-scope"
              className="text-xs text-[var(--color-text-dim)]"
            >
              Sempre permitir: {always.scope}.
            </p>
          )}
          {(view.always.length > 1 ||
            unmapped.length > 0 ||
            childRule ||
            view.canExplainDeny ||
            view.autoMode) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {view.always.slice(1).map((a) => (
                <button
                  key={a.optionIndex}
                  type="button"
                  data-permission-option={a.optionIndex + 1}
                  title={a.optionLabel}
                  onClick={() =>
                    decide({ type: 'select', optionIndex: a.optionIndex, label: a.optionLabel })
                  }
                  className="text-[var(--color-text-dim)] underline-offset-2 transition-colors hover:text-[var(--color-text)] hover:underline"
                >
                  Ou: {a.scope}
                </button>
              ))}
              {unmapped.map((o) => (
                <button
                  key={o.index}
                  type="button"
                  data-permission-option={o.index + 1}
                  onClick={() => decide({ type: 'select', optionIndex: o.index, label: o.label })}
                  className="text-[var(--color-text-dim)] underline-offset-2 transition-colors hover:text-[var(--color-text)] hover:underline"
                >
                  {o.label}
                </button>
              ))}
              {childRule && view.approve && (
                <button
                  type="button"
                  data-testid="permission-always-children"
                  title={`Aprova agora e grava ${childRule} no allow de todas as filhas`}
                  onClick={() =>
                    decide({
                      type: 'children',
                      optionIndex: view.approve!.optionIndex,
                      label: `Sempre para filhas: ${childRule}`,
                    })
                  }
                  className="text-[var(--color-text-dim)] underline-offset-2 transition-colors hover:text-[var(--color-text)] hover:underline"
                >
                  Sempre permitir para filhas <span className="font-mono">({childRule})</span>
                </button>
              )}
              {view.canExplainDeny && !explaining && (
                <button
                  type="button"
                  data-testid="permission-explain"
                  onClick={() => setExplaining(true)}
                  className="text-[var(--color-text-dim)] underline-offset-2 transition-colors hover:text-[var(--color-text)] hover:underline"
                >
                  Negar e explicar…
                </button>
              )}
              {view.autoMode && !confirmAuto && (
                <button
                  type="button"
                  data-testid="permission-auto-mode"
                  // Na Room a tecla do número só abre a confirmação, nunca liga direto.
                  data-permission-option={view.autoMode.optionIndex + 1}
                  title={view.autoMode.optionLabel}
                  onClick={() => setConfirmAuto(true)}
                  className="inline-flex items-center gap-1 text-[var(--color-text-dim)] underline-offset-2 transition-colors hover:text-[var(--color-warning)] hover:underline"
                >
                  <Icon as={Zap} size={11} />
                  Aprovar e ligar modo automático…
                </button>
              )}
            </div>
          )}
          {view.autoMode && confirmAuto && (
            <div
              className="flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-warning) 45%, var(--color-border))',
                background: 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
              }}
            >
              <p
                data-testid="permission-auto-mode-warning"
                className="min-w-0 flex-1 basis-56 text-xs leading-relaxed text-[var(--color-text)]"
              >
                Aprova este pedido e liga o modo automático: daqui em diante o Claude decide os
                próximos pedidos desta sessão sem perguntar.
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  className="!px-3 !py-1 text-xs"
                  onClick={() => setConfirmAuto(false)}
                >
                  Cancelar
                </Button>
                <Button
                  variant="danger"
                  className="!px-3 !py-1 text-xs"
                  data-testid="permission-auto-mode-confirm"
                  onClick={() =>
                    decide({
                      type: 'select',
                      optionIndex: view.autoMode!.optionIndex,
                      label: view.autoMode!.optionLabel,
                    })
                  }
                >
                  Ligar modo automático
                </Button>
              </div>
            </div>
          )}
          {explaining && (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5">
              <input
                autoFocus
                type="text"
                value={reason}
                maxLength={2000}
                data-testid="permission-reason"
                aria-label="Por que negar e o que o Claude deve fazer"
                placeholder="O que o Claude deve fazer em vez disso?"
                onChange={(e) => setReason(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
              />
              <Button
                variant="danger"
                className="!px-3 !py-1 text-xs"
                disabled={reason.trim() === ''}
                data-testid="permission-reason-send"
                onClick={sendReason}
              >
                Negar e enviar
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-[var(--color-text-dim)]">Responda no terminal desta sessão.</p>
      )}

      {notice && (
        <p
          role="alert"
          data-testid="permission-notice"
          className="text-xs text-[var(--color-warning)]"
        >
          {notice}
        </p>
      )}
    </section>
  )
}
