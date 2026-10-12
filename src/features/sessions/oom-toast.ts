import type { ScopeOomEvent } from '@shared/types/ipc'

export function oomToastText(
  title: string,
  event: Pick<ScopeOomEvent, 'maxGB' | 'claudeAlive'>,
): string {
  return event.claudeAlive
    ? `um processo da sessão ${title} passou de ${event.maxGB} GB e foi encerrado; a conversa continua`
    : `sessão ${title} encerrada por memória — retome`
}
