import { useState } from 'react'
import { ArrowLeft, ArrowRight, ListTree, Sparkles } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { TuiMenu } from '../../../../shared/tui/tui-menu-parser'
import { keysForAction } from '../../../../shared/tui/menu-actions'
import { stripUnsafeDisplay } from '../../../../shared/tui/permission-request'

interface Props {
  // kind 'menu' (parser tolerante) ou 'nudge' (Teach auto mode…).
  menu: TuiMenu
  onSelect?: (optionIndex: number) => void
  // Opção que abre campo ("Summarize from here" do /rewind): vai com o texto digitado.
  onInput?: (optionIndex: number, text: string) => void
  onEsc?: () => void
  onTab?: (direction: 'next' | 'prev') => void
  // Lista rolada: anda o cursor até a janela mostrar o resto (ver buildGenericScrollKeys).
  onScroll?: (direction: 'up' | 'down') => void
  sent?: boolean
  // Popover/cartões: sem moldura própria, texto menor.
  bare?: boolean
}

// O Esc da CLI muda de efeito conforme a tela; o rodapé diz qual. Na busca do /permissions
// o 1º Esc limpa o texto e, com ela vazia, o Esc leva o foco para a lista (sem fechar).
function escLabel(menu: TuiMenu): string {
  const footer = menu.footer
  if (footer && /Esc to clear/i.test(footer))
    return menu.search ? 'Limpar busca (Esc)' : 'Sair da busca (Esc)'
  if (footer && /Esc to go back/i.test(footer)) return 'Voltar (Esc)'
  if (footer && /Esc to cancel/i.test(footer) && !/to switch|to select|to navigate/i.test(footer))
    return 'Cancelar (Esc)'
  return 'Fechar (Esc)'
}

// Diálogo da CLI que nenhum card dedicado conhece (/permissions, /hooks, seletor e
// submenu do /rewind, nudge do auto mode). Mostra o que a tela mostra e oferece só o
// que tem tecla segura: opção sem caminho de teclas fica desabilitada; Esc sempre.
export function GenericMenuCard({
  menu,
  onSelect,
  onInput,
  onEsc,
  onTab,
  onScroll,
  sent,
  bare,
}: Props) {
  const [inputs, setInputs] = useState<Record<number, string>>({})
  const nudge = menu.kind === 'nudge'
  const live = !sent
  const title = menu.question ?? 'Menu do Claude Code'
  const body = (
    <div className="flex flex-col gap-2">
      {menu.tabs && menu.tabs.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs">
          {menu.tabSwitch && (
            <button
              type="button"
              data-testid="generic-tab-prev"
              aria-label="Aba anterior"
              disabled={!live || onTab == null}
              onClick={() => onTab?.('prev')}
              className="shrink-0 rounded p-0.5 text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-30"
            >
              <Icon as={ArrowLeft} size={13} />
            </button>
          )}
          <div className="flex flex-1 flex-wrap gap-x-2 gap-y-1 text-[var(--color-text-dim)]">
            {menu.tabs.map((t) => (
              <span key={t.label}>{stripUnsafeDisplay(t.label)}</span>
            ))}
          </div>
          {menu.tabSwitch && (
            <button
              type="button"
              data-testid="generic-tab-next"
              aria-label="Próxima aba"
              disabled={!live || onTab == null}
              onClick={() => onTab?.('next')}
              className="shrink-0 rounded p-0.5 text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-30"
            >
              <Icon as={ArrowRight} size={13} />
            </button>
          )}
        </div>
      )}
      {/* No popover o painel já mostra o texto do menu (MenuContext). */}
      {!bare && menu.context && (
        <p className="m-0 whitespace-pre-wrap text-xs text-[var(--color-text-dim)]">
          {stripUnsafeDisplay(menu.context)}
        </p>
      )}
      {menu.search && (
        <p data-testid="generic-search" className="m-0 text-xs text-[var(--color-text-dim)]">
          Busca: <span className="text-[var(--color-text)]">{stripUnsafeDisplay(menu.search)}</span>
        </p>
      )}
      {menu.moreAbove &&
        (onScroll && menu.cursorIndex != null ? (
          <ScrollButton
            testId="generic-scroll-up"
            label={moreLabel('acima', menu.moreAboveCount)}
            disabled={!live}
            onClick={() => onScroll('up')}
          />
        ) : (
          <MoreHint text="mais itens acima (role pelo terminal)" />
        ))}
      {menu.options.length > 0 && (
        <div className={nudge ? 'flex flex-wrap gap-1.5' : 'flex flex-col gap-1'}>
          {menu.options.map((o, k) => {
            const reachable =
              keysForAction(menu, { kind: 'select', optionIndex: o.index }).length > 0
            const current = menu.cursorIndex === o.index
            const groupStart = o.group != null && o.group !== menu.options[k - 1]?.group
            return (
              <div key={o.index} className="contents">
                {groupStart && (
                  <span className="mt-1 text-[11px] font-medium text-[var(--color-text-dim)]">
                    {stripUnsafeDisplay(o.group!)}
                  </span>
                )}
                <button
                  type="button"
                  data-testid={`generic-option-${o.index}`}
                  disabled={!live || onSelect == null || !reachable}
                  onClick={() => onSelect?.(o.index)}
                  title={
                    reachable ? undefined : 'Sem caminho de teclas seguro a partir do cursor atual'
                  }
                  className={`flex items-start gap-2 rounded border px-2 py-1 text-left text-xs transition hover:border-[var(--color-accent)]/60 hover:bg-[var(--color-accent)]/10 disabled:opacity-40 ${
                    current ? 'border-[var(--color-accent)]/50' : 'border-[var(--color-border)]'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="font-medium text-[var(--color-text)]">
                      {stripUnsafeDisplay(o.label)}
                    </span>
                    {o.description && (
                      <span className="block text-[var(--color-text-dim)]">
                        {stripUnsafeDisplay(o.description)}
                      </span>
                    )}
                  </span>
                </button>
                {o.opensInput && onInput != null && (
                  <OptionInput
                    index={o.index}
                    value={inputs[o.index] ?? ''}
                    disabled={
                      !live ||
                      keysForAction(menu, { kind: 'other', optionIndex: o.index, text: 'x' })
                        .length === 0
                    }
                    onChange={(v) => setInputs((prev) => ({ ...prev, [o.index]: v }))}
                    onSubmit={(v) => onInput(o.index, v)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
      {menu.moreBelow &&
        (onScroll && menu.cursorIndex != null ? (
          <ScrollButton
            testId="generic-scroll-down"
            label={moreLabel('abaixo', menu.moreBelowCount)}
            disabled={!live}
            onClick={() => onScroll('down')}
          />
        ) : (
          <MoreHint text="mais itens abaixo (role pelo terminal)" />
        ))}
      {menu.warning && (
        <p data-testid="generic-warning" className="m-0 text-xs text-[var(--color-warning)]">
          {stripUnsafeDisplay(menu.warning)}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="generic-esc"
          disabled={!live || onEsc == null}
          onClick={onEsc}
          className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs transition hover:border-[var(--color-accent)]/60 disabled:opacity-40"
        >
          {escLabel(menu)}
        </button>
        <span
          className="min-w-0 truncate text-[11px] text-[var(--color-text-dim)]"
          title={menu.footer}
        >
          {sent ? 'Enviado…' : menu.footer ? stripUnsafeDisplay(menu.footer) : null}
        </span>
      </div>
    </div>
  )
  if (bare) return <div data-testid="generic-menu">{body}</div>
  return (
    <div
      data-testid="generic-menu"
      data-kind={menu.kind}
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/60 text-sm"
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-1.5">
        <Icon
          as={nudge ? Sparkles : ListTree}
          size={13}
          className="shrink-0 text-[var(--color-text-dim)]"
        />
        <span className="text-xs font-medium text-[var(--color-text)]">
          {stripUnsafeDisplay(title)}
        </span>
      </div>
      <div className="px-3 py-2">{body}</div>
    </div>
  )
}

function OptionInput({
  index,
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  index: number
  value: string
  disabled: boolean
  onChange: (v: string) => void
  onSubmit: (v: string) => void
}) {
  const ready = !disabled && value.trim() !== ''
  return (
    <div className="ml-4 flex items-center gap-1.5">
      <input
        data-testid={`generic-input-${index}`}
        value={value}
        disabled={disabled}
        placeholder="contexto (opcional)"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && ready) {
            e.preventDefault()
            onSubmit(value)
          }
        }}
        className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60 disabled:opacity-40"
      />
      <button
        type="button"
        data-testid={`generic-input-send-${index}`}
        disabled={!ready}
        onClick={() => onSubmit(value)}
        className="shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5 text-xs transition hover:border-[var(--color-accent)]/60 disabled:opacity-40"
      >
        Com este contexto
      </button>
    </div>
  )
}

function moreLabel(where: string, count: number | undefined): string {
  return count != null ? `Mostrar mais ${count} ${where}` : `Mostrar mais ${where}`
}

function ScrollButton({
  testId,
  label,
  disabled,
  onClick,
}: {
  testId: string
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="self-start text-[11px] text-[var(--color-text-dim)] underline-offset-2 transition hover:text-[var(--color-text)] hover:underline disabled:opacity-40"
    >
      {label}
    </button>
  )
}

function MoreHint({ text }: { text: string }) {
  return <span className="text-[11px] text-[var(--color-text-dim)]">{text}</span>
}
