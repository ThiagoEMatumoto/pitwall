import { Moon } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { ActivePane } from '@/store/appStore'

export const DORMANT_BADGE = 'dormindo — clique para acordar'

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]'

// Aba restaurada sem processo (lazy restore). Não monta Terminal nem faz IPC: o
// id da sessão é sintético. Montar NÃO acorda (o dockview monta todas as abas);
// só o clique aqui ou a ativação da aba (AppShell).
// tabTitle = o rótulo que a aba mostra (título salvo no layout do dockview), para
// a pane e a aba dizerem o mesmo nome.
export function DormantPane({
  pane,
  tabTitle,
  onWake,
}: {
  pane: ActivePane
  tabTitle?: string
  onWake: () => void
}) {
  const repoLabel = pane.repo?.label ?? 'Avulsa'
  const subtitle = pane.projectName ? `${pane.projectName} · ${repoLabel}` : repoLabel
  const title = tabTitle || pane.session.title || repoLabel
  return (
    <div
      data-testid="dormant-pane"
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[var(--color-bg)] p-6 text-center"
    >
      <Icon as={Moon} aria-hidden className="text-[var(--color-text-dim)]" />
      <div className="min-w-0">
        <div className="truncate text-sm text-[var(--color-text)]">{title}</div>
        {subtitle !== title && (
          <div className="truncate text-xs text-[var(--color-text-dim)]">{subtitle}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onWake}
        className={`rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] ${FOCUS_RING}`}
      >
        {DORMANT_BADGE}
      </button>
      <button
        type="button"
        onClick={onWake}
        aria-label={`Retomar ${title}`}
        className={`rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm text-[var(--color-bg)] hover:opacity-90 ${FOCUS_RING}`}
      >
        Retomar
      </button>
    </div>
  )
}
