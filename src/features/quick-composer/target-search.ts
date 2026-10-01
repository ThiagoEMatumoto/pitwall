import { liveSessionLabel } from '@/features/session-switcher/session-label'
import { fuzzyScore } from '@/features/sessions/mention-parser'
import type { AttentionReason, LiveSessionInfo } from '../../../shared/types/ipc'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import type { SendPromptError, SendPromptWhen } from '../../../shared/types/send-prompt'

// Para quem dá pra mandar um prompt: toda sessão viva visível, de qualquer projeto.

export interface SendTarget {
  sessionId: string
  ccSessionId: string
  // O que vai depois do @ (slug do nome da sessão).
  alias: string
  label: string
  projectName: string | null
  projectColor: string | null
  status: LiveSessionInfo['status']
  // Pasta onde o #arquivo resolve. null = sessão avulsa.
  cwd: string | null
  purpose: string | null
  attentionReason?: AttentionReason
}

export function aliasOf(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Nome repetido (duas sessões do mesmo repo sem nome) recebe o começo do id: o
// sufixo não muda com a ordem da lista, e cada item do menu resolve uma sessão só.
function uniqueAliases(targets: SendTarget[]): SendTarget[] {
  const count = new Map<string, number>()
  for (const t of targets) count.set(t.alias, (count.get(t.alias) ?? 0) + 1)
  return targets.map((t) =>
    (count.get(t.alias) ?? 0) > 1 ? { ...t, alias: `${t.alias}-${t.sessionId.slice(0, 4)}` } : t,
  )
}

export function buildTargets(live: LiveSessionInfo[], nodes: SessionGraphNode[]): SendTarget[] {
  const bySession = new Map(nodes.map((n) => [n.sessionId, n]))
  const targets = live
    .filter((s) => s.status !== 'ended')
    .map((s) => {
      const label = liveSessionLabel(s)
      const node = bySession.get(s.id)
      return {
        sessionId: s.id,
        ccSessionId: s.ccSessionId,
        alias: aliasOf(s.name ?? label) || 'sessao',
        label,
        projectName: s.projectName,
        projectColor: s.projectColor,
        status: s.status,
        // cwd real da sessão (worktree da feature); o repo é só o fallback.
        cwd: s.cwd ?? s.repo?.path ?? null,
        purpose: node?.purpose ?? node?.purposeHint ?? null,
        attentionReason: s.attentionReason,
      }
    })
  return uniqueAliases(targets)
}

// Quem pode receber já vem primeiro: esperando, ocioso, trabalhando, subindo.
const STATUS_RANK: Record<SendTarget['status'], number> = {
  waiting: 0,
  idle: 1,
  working: 2,
  starting: 3,
  ended: 4,
}

function targetScore(query: string, t: SendTarget): number | null {
  const fields = [t.alias, t.label, t.projectName ?? '', t.purpose ?? '']
  let best: number | null = null
  for (const [i, f] of fields.entries()) {
    const s = fuzzyScore(query, f)
    // Alias/rótulo pesam mais que projeto e propósito.
    if (s != null) best = Math.max(best ?? -Infinity, i < 2 ? s + 100 : s)
  }
  return best
}

export function searchTargets(query: string, targets: SendTarget[]): SendTarget[] {
  const q = query.trim()
  const ranked = targets
    .map((t) => ({ t, score: q ? targetScore(q, t) : 0 }))
    .filter((x): x is { t: SendTarget; score: number } => x.score != null)
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      STATUS_RANK[a.t.status] - STATUS_RANK[b.t.status] ||
      a.t.alias.localeCompare(b.t.alias),
  )
  return ranked.map((x) => x.t)
}

const MENU_REASONS: ReadonlySet<AttentionReason> = new Set(['permission', 'trust', 'question'])

export function defaultWhen(
  t: Pick<SendTarget, 'status' | 'attentionReason'>,
  hasMenu: boolean,
): SendPromptWhen {
  const free = t.status === 'idle' || t.status === 'waiting'
  const menu = hasMenu || (t.attentionReason != null && MENU_REASONS.has(t.attentionReason))
  return free && !menu ? 'now' : 'on-idle'
}

const REFUSAL_REASON: Record<SendPromptError, string> = {
  'menu-open': 'menu aberto na tela',
  unparsed: 'a tela não mostra o input livre — pode ser um menu',
  attention: 'ela está com uma pergunta de handoff pendente',
  'no-screen': 'sem espelho da tela — fale com ela pelo terminal dela',
  'not-running': 'sessão encerrada',
  'input-dirty': 'ela tem texto não enviado no prompt',
  cancelled: 'a mensagem foi cancelada',
}

export function sendRefusalReason(error: SendPromptError): string {
  return REFUSAL_REASON[error]
}

export const STATUS_DOT: Record<SendTarget['status'], string> = {
  working: 'var(--color-accent)',
  waiting: 'var(--color-warning)',
  idle: 'var(--color-success)',
  starting: 'var(--color-text-dim)',
  ended: 'var(--color-text-dim)',
}
