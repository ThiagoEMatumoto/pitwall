// PURO: o resumo da aba "Estado" do painel da feature — o que quem chega quer
// saber de relance (quantas sessões em cada estado, as regras que valem, o que
// mudou por último), em vez do parágrafo explicando como a seção funciona.
import {
  BUSINESS_RULES_SECTION,
  FIXED_NOTES_SECTION,
  getSection,
  splitFixedNotes,
} from '../../../shared/feature-sections'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

export interface SessionStatusCounts {
  needsYou: number
  working: number
  idle: number
}

export function sessionStatusCounts(
  nodes: Pick<SessionGraphNode, 'featureId' | 'status' | 'attentionReason'>[],
  featureId: string,
): SessionStatusCounts {
  const out = { needsYou: 0, working: 0, idle: 0 }
  for (const n of nodes) {
    if (n.featureId !== featureId || n.status === 'ended') continue
    if (n.attentionReason || n.status === 'waiting') out.needsYou++
    else if (n.status === 'working' || n.status === 'starting') out.working++
    else out.idle++
  }
  return out
}

// Itens de lista viram uma regra cada; texto corrido, uma regra por parágrafo.
function ruleLines(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n|\n(?=\s*[-*]\s)/)
    .map((l) => l.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** Notas fixadas primeiro (o que não pode ser esquecido), depois as regras de negócio. */
export function featureReminders(body: string): string[] {
  const notes = splitFixedNotes(getSection(body, FIXED_NOTES_SECTION)).map((n) =>
    n.replace(/\s+/g, ' '),
  )
  return [...notes, ...ruleLines(getSection(body, BUSINESS_RULES_SECTION))]
}

// Chip de lembrete no card: corta no fim de palavra (com reticências) em vez de
// no meio dela ("a antiga dup…"); o texto inteiro fica no title.
export function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  const head = space > max * 0.5 ? cut.slice(0, space) : cut
  return `${head.replace(/[\s,;:.\-–—]+$/, '')}…`
}
