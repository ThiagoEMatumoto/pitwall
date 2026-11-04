import { ArrowLeft, ArrowRight, ListTree, Sparkles } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { TuiMenu } from '../../../../shared/tui/tui-menu-parser'
import { keysForAction } from '../../../../shared/tui/menu-actions'
import { stripUnsafeDisplay } from '../../../../shared/tui/permission-request'

interface Props {
  // kind 'menu' (parser tolerante) ou 'nudge' (Teach auto mode…).
  menu: TuiMenu
  onSelect?: (optionIndex: number) => void
  onEsc?: () => void
  onTab?: (direction: 'next' | 'prev') => void
  sent?: boolean
  // Popover/cartões: sem moldura própria, texto menor.
  bare?: boolean
}

// Diálogo da CLI que nenhum card dedicado conhece (/permissions, /hooks, seletor e
// submenu do /rewind, nudge do auto mode). Mostra o que a tela mostra e oferece só o
// que tem tecla segura: opção sem caminho de teclas fica desabilitada; Esc sempre.
export function GenericMenuCard({ menu, onSelect, onEsc, onTab, sent, bare }: Props) {
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
      {menu.options.length > 0 && (
        <div className={nudge ? 'flex flex-wrap gap-1.5' : 'flex flex-col gap-1'}>
          {menu.options.map((o) => {
            const reachable = keysForAction(menu, { kind: 'select', optionIndex: o.index }).length > 0
            const current = menu.cursorIndex === o.index
            return (
              <button
                key={o.index}
                type="button"
                data-testid={`generic-option-${o.index}`}
                disabled={!live || onSelect == null || !reachable}
                onClick={() => onSelect?.(o.index)}
                title={reachable ? undefined : 'Sem caminho de teclas seguro a partir do cursor atual'}
                className={`flex items-start gap-2 rounded border px-2 py-1 text-left text-xs transition hover:border-[var(--color-accent)]/60 hover:bg-[var(--color-accent)]/10 disabled:opacity-40 ${
                  current ? 'border-[var(--color-accent)]/50' : 'border-[var(--color-border)]'
                }`}
              >
                <span className="min-w-0">
                  <span className="font-medium text-[var(--color-text)]">{stripUnsafeDisplay(o.label)}</span>
                  {o.description && (
                    <span className="block text-[var(--color-text-dim)]">{stripUnsafeDisplay(o.description)}</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="generic-esc"
          disabled={!live || onEsc == null}
          onClick={onEsc}
          className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs transition hover:border-[var(--color-accent)]/60 disabled:opacity-40"
        >
          Fechar (Esc)
        </button>
        <span className="min-w-0 truncate text-[11px] text-[var(--color-text-dim)]" title={menu.footer}>
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
        <span className="text-xs font-medium text-[var(--color-text)]">{stripUnsafeDisplay(title)}</span>
      </div>
      <div className="px-3 py-2">{body}</div>
    </div>
  )
}
