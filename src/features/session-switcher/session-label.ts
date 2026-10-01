import type { LiveSessionInfo } from '../../../shared/types/ipc'

// Nome de uma sessão viva nas superfícies de sessão (chip da barra, HUD da fila de
// atenção). Sem título nem nome ainda, cai no repo — o mesmo que a aba mostra —,
// e string vazia conta como ausente.
export function liveSessionLabel(s: Pick<LiveSessionInfo, 'title' | 'name' | 'repo'>): string {
  return (s.title ?? s.name ?? s.repo?.label) || (s.repo?.label ?? 'Avulsa')
}
