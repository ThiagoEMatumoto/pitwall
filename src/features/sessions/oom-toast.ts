import type { ScopeOomEvent } from '@shared/types/ipc'

export function oomToastText(
  title: string,
  event: Pick<ScopeOomEvent, 'maxGB' | 'claudeAlive' | 'resumeCcSessionId'>,
): string {
  if (event.claudeAlive) {
    return `um processo da sessão ${title} passou de ${event.maxGB} GB e foi encerrado; a conversa continua`
  }
  return event.resumeCcSessionId
    ? `sessão ${title} encerrada por memória — retomando a conversa`
    : `sessão ${title} encerrada por memória — retome`
}
