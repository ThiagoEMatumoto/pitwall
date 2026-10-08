import { isActionableDetail } from '@/features/session-switcher/AttentionPopover'
import type { AttentionItem } from '@/features/session-switcher/attention-queue'
import type { Handoff, LiveSessionInfo } from '../../../shared/types/ipc'

// Item da fila de atenção pro painel de resposta do quick look, só quando a tela
// da filha tem um menu respondível. O menu e as teclas saem do main (espelho
// headless + checagem de fingerprint/menuSeq), não do ChatView: no chat o xterm
// não está montado, então não há buffer local pra re-parsear antes de digitar.
export function peekAttentionItem(
  live: LiveSessionInfo | null,
  handoff: Handoff | null,
): AttentionItem | null {
  if (!live || !isActionableDetail(live.attentionReason)) return null
  return {
    key: handoff ? `crew:${handoff.id}` : `session:${live.id}`,
    kind: handoff ? 'crew' : 'session',
    sessionId: live.id,
    ccSessionId: live.ccSessionId,
    ...(handoff ? { handoffId: handoff.id } : {}),
    projectName: live.projectName,
    title: live.title ?? live.name ?? '',
    reason: handoff ? 'crew' : 'waiting',
    detail: live.attentionReason,
    since: live.lastActivityAt,
    liveStatus: live.status,
  }
}
