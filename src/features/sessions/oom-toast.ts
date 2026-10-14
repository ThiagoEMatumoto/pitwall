import type { ScopeOomEvent } from '@shared/types/ipc'

export function oomToastText(
  title: string,
  event: Pick<ScopeOomEvent, 'maxGB' | 'claudeAlive' | 'resumeCcSessionId' | 'resumeQueued'>,
): string {
  if (event.claudeAlive) {
    return `um processo da sessão ${title} passou de ${event.maxGB} GB e foi encerrado; a conversa continua`
  }
  if (event.resumeCcSessionId) return `sessão ${title} encerrada por memória — retomando a conversa`
  return event.resumeQueued
    ? `sessão ${title} encerrada por memória — a conversa volta quando houver memória livre`
    : `sessão ${title} encerrada por memória — retome`
}
