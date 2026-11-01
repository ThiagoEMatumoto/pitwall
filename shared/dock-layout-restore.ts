import type { PaneSnapshot } from './types/ipc'

// open_panes e dock_layout gravam em transações separadas (o layout vem do
// dockview, depois que o painel da aba nova existe). Um kill entre as duas deixa
// um layout que não fala das abas salvas. O layout é só arranjo: sem paneId em
// comum ele é descartado e as abas voltam no grid padrão, em vez de o restore
// esperar por painéis que nunca vão voltar.
export function layoutToRestore(
  dockLayout: string | null,
  openPanes: PaneSnapshot[],
): string | null {
  if (!dockLayout || openPanes.length === 0) return null
  // Snapshots antigos (sem paneId) caem no grid padrão.
  if (!openPanes.every((p) => p.paneId)) return null
  const open = new Set(openPanes.map((p) => p.paneId))
  try {
    const parsed = JSON.parse(dockLayout) as { panels?: Record<string, unknown> } | null
    const ids = Object.keys(parsed?.panels ?? {})
    return ids.some((id) => open.has(id)) ? dockLayout : null
  } catch {
    return null
  }
}

export type LayoutRestoreStep = 'apply' | 'arm-fallback' | 'wait'

// Com o layout pendente, o AppShell espera as panes dele voltarem do resume.
// 'apply' com todas de volta; 'arm-fallback' (aplica o parcial ou desiste do
// layout depois de um tempo) quando alguma já voltou ou o restore terminou sem
// elas. Nunca 'wait' depois do fim do restore: o pendingLayout não fica pendurado.
export function layoutRestoreStep(
  wantedIds: string[],
  storeIds: ReadonlySet<string>,
  restoreComplete: boolean,
): LayoutRestoreStep {
  if (wantedIds.length > 0 && wantedIds.every((id) => storeIds.has(id))) return 'apply'
  if (restoreComplete || wantedIds.some((id) => storeIds.has(id))) return 'arm-fallback'
  return 'wait'
}
