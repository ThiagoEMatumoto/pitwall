import { Moon } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { ActivePane } from '@/store/appStore'

export const DORMANT_BADGE = 'dormindo — clique para acordar'

// Aba restaurada sem processo (lazy restore). Não monta Terminal nem faz IPC: o
// id da sessão é sintético. Montar NÃO acorda (o dockview monta todas as abas);
// só o clique aqui ou a ativação da aba (AppShell).
export function DormantPane({ pane, onWake }: { pane: ActivePane; onWake: () => void }) {
  const repoLabel = pane.repo?.label ?? 'Avulsa'
  const title = pane.session.title ?? repoLabel
  return (
    <div
      data-testid="dormant-pane"
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[var(--color-bg)] p-6 text-center"
    >
      <Icon as={Moon} className="text-[var(--color-text-dim)]" />
      <div className="min-w-0">
        <div className="truncate text-sm text-[var(--color-text)]">{title}</div>
        <div className="truncate text-xs text-[var(--color-text-dim)]">
          {pane.projectName ? `${pane.projectName} · ${repoLabel}` : repoLabel}
        </div>
      </div>
      <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-dim)]">
        {DORMANT_BADGE}
      </span>
      <button
        type="button"
        onClick={onWake}
        className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm text-[var(--color-bg)] hover:opacity-90"
      >
        Retomar
      </button>
    </div>
  )
}
