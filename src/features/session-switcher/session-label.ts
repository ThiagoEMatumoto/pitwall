import type { LiveSessionInfo } from '../../../shared/types/ipc'
import { preferredSessionTitle } from '../../../shared/session-title'

type LabelInput = Pick<LiveSessionInfo, 'title' | 'name' | 'repo'> &
  Partial<Pick<LiveSessionInfo, 'titleSource' | 'autoTitle'>>

// O nome próprio de exibição (rename manual > auto-título), regra de
// shared/session-title. O main só grava auto-título em sessão não-filha, então
// a filha cai sempre no apelido de antes.
function ownTitle(s: Omit<LabelInput, 'name' | 'repo'>): string | null {
  return preferredSessionTitle({
    manualTitle: s.titleSource === 'manual' ? s.title : null,
    autoTitle: s.autoTitle,
  })
}

// Nome de uma sessão viva nas superfícies de sessão (chip da barra, HUD da fila de
// atenção, seletor, paleta, overview). Sem nome próprio, cai no comportamento de
// sempre: título do transcript > nome do CLI > repo — o mesmo que a aba mostra —,
// e string vazia conta como ausente.
export function liveSessionLabel(s: LabelInput): string {
  return ownTitle(s) || (s.title ?? s.name ?? s.repo?.label) || (s.repo?.label ?? 'Avulsa')
}

// O rótulo veio do auto-título (e não de um rename manual)?
export function liveSessionTitleIsAuto(s: Omit<LabelInput, 'name' | 'repo'>): boolean {
  return !!s.autoTitle?.trim() && ownTitle(s) === s.autoTitle.trim()
}
