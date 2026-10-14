import type { ScopeOomEvent } from '@shared/types/ipc'

export function oomToastText(
  title: string,
  event: Pick<ScopeOomEvent, 'claudeAlive' | 'resumeCcSessionId' | 'resumeQueued'>,
): string {
  // Sem citar o teto: o kill pode vir do cap da sessão ou do cap do conjunto
  // (pitwall-sessions.slice), e o evento não distingue os dois.
  if (event.claudeAlive) {
    return `um processo da sessão ${title} foi encerrado por memória; a conversa continua`
  }
  if (event.resumeCcSessionId) return `sessão ${title} encerrada por memória — retomando a conversa`
  return event.resumeQueued
    ? `sessão ${title} encerrada por memória — a conversa volta quando houver memória livre`
    : `sessão ${title} encerrada por memória — retome`
}
