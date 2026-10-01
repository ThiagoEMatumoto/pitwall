import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { GradientBorder } from '@/features/brand'

interface Props {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  footer?: ReactNode
  widthClassName?: string
  // Botão de fechar no header. Desligar em modais forçados (ex.: onboarding),
  // onde não há saída — o backdrop e o Esc também ficam inertes via onClose noop.
  showClose?: boolean
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  widthClassName,
  showClose = true,
}: Props) {
  // Fecha com Escape (keyboard-first). Listener em fase bubble na window:
  // handlers internos que consomem Escape para outra função (ex.: captura de
  // keybinding no SettingsDialog, que faz preventDefault/stopPropagation em
  // capture) têm precedência — por isso ignoramos eventos já defaultPrevented.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      // Marca de overlay modal: os atalhos globais da fila de atenção cedem a vez
      // enquanto ele existe (attentionKeysBlocked).
      data-modal-overlay
      // z-[1000] keeps the dialog above dockview layers (.dv-sash z-index 99,
      // --dv-overlay-z-index 999); the portal escapes any stacking context
      // created by ancestors of the dialog's render site.
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-[3px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <GradientBorder
        radius={16}
        className={`pw-rise max-h-[85vh] max-w-[90vw] shadow-2xl ${widthClassName ?? 'w-[28rem]'}`}
        innerClassName="flex max-h-[85vh] flex-col overflow-hidden p-6"
        style={{ display: 'block' }}
      >
        {(title || showClose) && (
          <div className="mb-4 flex shrink-0 items-start justify-between gap-3">
            {title ? (
              <h2 className="text-lg font-semibold tracking-[-0.01em] text-[var(--color-text)]">
                {title}
              </h2>
            ) : (
              <span />
            )}
            {showClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Fechar"
                className="-mr-1 -mt-1 rounded-md p-1 text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-danger)]"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
        <div className="min-h-0 overflow-y-auto pr-1">{children}</div>
        {footer && <div className="mt-6 flex shrink-0 justify-end gap-2">{footer}</div>}
      </GradientBorder>
    </div>,
    document.body,
  )
}
