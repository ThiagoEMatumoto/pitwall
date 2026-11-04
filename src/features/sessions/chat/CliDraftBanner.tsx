import { stripUnsafeDisplay } from '../../../../shared/tui/permission-request'

interface Props {
  draft: string
  onSend?: () => void
  onClear?: () => void
}

// Texto que a CLI deixou na própria caixa de input (Ctrl+R preenchido, mensagem devolvida
// pelo "Restore conversation" do /rewind). No chat a caixa não aparece: sem este aviso, o
// próximo envio do Composer sairia grudado nesse texto.
export function CliDraftBanner({ draft, onSend, onClear }: Props) {
  return (
    <div
      data-testid="cli-draft"
      className="flex flex-col gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/40 px-3 py-2 text-xs"
    >
      <span className="text-[var(--color-text-dim)]">
        Na caixa de input do terminal (ainda não enviado):
      </span>
      <span className="whitespace-pre-wrap font-mono text-[var(--color-text)]">
        {stripUnsafeDisplay(draft)}
      </span>
      <div className="flex gap-1.5">
        <button
          type="button"
          data-testid="cli-draft-send"
          disabled={onSend == null}
          onClick={onSend}
          className="rounded border border-[var(--color-accent)]/50 px-2 py-0.5 font-medium transition hover:bg-[var(--color-accent)]/10 disabled:opacity-40"
        >
          Enviar ao Claude
        </button>
        <button
          type="button"
          data-testid="cli-draft-clear"
          disabled={onClear == null}
          onClick={onClear}
          className="rounded border border-[var(--color-border)] px-2 py-0.5 transition hover:border-[var(--color-danger)]/40 disabled:opacity-40"
        >
          Limpar
        </button>
      </div>
    </div>
  )
}
