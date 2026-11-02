import { matchesQuery } from '@/lib/text-match'
import type { LiveSessionInfo } from '../../../shared/types/ipc'

// Campos pesquisáveis de uma sessão — SessionSwitcher e CommandPalette usam o
// mesmo conjunto pra busca ficar consistente entre os dois.
function searchFields(s: LiveSessionInfo): (string | null | undefined)[] {
  return [s.autoTitle, s.title, s.name, s.projectName, s.repo?.label]
}

export function matchesSession(query: string, s: LiveSessionInfo): boolean {
  return matchesQuery(query, ...searchFields(s))
}

// Texto único de busca pro CommandPalette (que filtra por uma string só).
// Separador \n evita match acidental atravessando fronteira de campos.
export function sessionSearchText(s: LiveSessionInfo): string {
  return searchFields(s)
    .filter(Boolean)
    .join('\n')
}

// Prioridade de exibição: o acionável primeiro (aguardando > trabalhando > ociosa).
const STATUS_RANK: Record<LiveSessionInfo['status'], number> = {
  waiting: 0,
  working: 1,
  starting: 1,
  idle: 2,
  ended: 3,
}

export function sortByUrgency(sessions: LiveSessionInfo[]): LiveSessionInfo[] {
  // Sort estável: dentro do mesmo status preserva a ordem vinda do backend.
  return [...sessions].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
}
