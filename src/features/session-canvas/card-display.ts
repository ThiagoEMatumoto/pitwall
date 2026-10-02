// PURO: o que o cartão de sessão mostra além dos dados crus do grafo.
import type { SessionGraphNode } from '../../../shared/types/session-graph'

const TITLE_WORDS = 6

// O fallback do título é o label do repo: quatro cartões "legal-app" lado a lado
// não dizem nada. Sem título próprio, as primeiras palavras do propósito.
export function cardTitle(n: Pick<SessionGraphNode, 'title' | 'repoLabel' | 'purpose'>): string {
  const generic = n.title === n.repoLabel || n.title === 'Avulsa'
  if (!generic || !n.purpose) return n.title
  const words = n.purpose.replace(/…$/, '').trim().split(/\s+/)
  const head = words.slice(0, TITLE_WORDS).join(' ')
  return words.length > TITLE_WORDS ? `${head}…` : head
}

export type CardFooter =
  | { kind: 'note'; text: string }
  | { kind: 'summary'; text: string }
  | { kind: 'last'; text: string }
  | null

// Rodapé do cartão, do mais intencional pro mais barato: a nota do usuário, o
// resumo "onde parei", a última mensagem do transcript. Nada disso → sem linha.
export function cardFooter(
  n: Pick<SessionGraphNode, 'lastSummary' | 'lastPrompt' | 'purpose'>,
  noteExcerpt: string | null,
): CardFooter {
  if (noteExcerpt) return { kind: 'note', text: noteExcerpt }
  if (n.lastSummary) return { kind: 'summary', text: n.lastSummary }
  const last = n.lastPrompt?.trim()
  // A última mensagem = o 1º prompt (sessão de uma mensagem só) repetiria o propósito.
  if (last && last !== n.purpose) return { kind: 'last', text: last }
  return null
}

export type CardDetail = 'blocks' | 'brief' | 'full'

// Zoom semântico: abaixo de 0.75 o corpo vira textura ilegível (≈7px efetivos),
// então só pill + título; abaixo de 0.45 nem o título se lê — blocos por status.
export const BRIEF_BELOW = 0.75
export const BLOCKS_BELOW = 0.45
const TITLE_PX = 13
const TITLE_MAX_PX = 22

// O zoom que os cartões leem (useZoom): em degraus de 0.05, senão cada frame de
// pan/zoom re-renderizaria todos. Quem decide o layout pela densidade tem de
// usar o MESMO degrau: com o zoom cru, 0.74 dava raia compacta e cartão cheio.
export function quantizeZoom(zoom: number): number {
  return Math.round(zoom * 20) / 20
}

/** Zoom (cru) em que os cartões desenham o resumo ou blocos, não o cartão cheio. */
export function isCompactZoom(zoom: number): boolean {
  return cardDetail(quantizeZoom(zoom)) !== 'full'
}

// Maior zoom cru que ainda cai no resumo depois do degrau (0.72 → 0.70).
export const MAX_COMPACT_ZOOM = BRIEF_BELOW - 0.03

export function cardDetail(zoom: number): CardDetail {
  if (zoom < BLOCKS_BELOW) return 'blocks'
  if (zoom < BRIEF_BELOW) return 'brief'
  return 'full'
}

// Fonte compensada pelo zoom (fica ~13px na tela), com teto pra não estourar o cartão.
export function compensatedPx(zoom: number, base = TITLE_PX, max = TITLE_MAX_PX): number {
  return Math.min(max, Math.round((base / Math.max(zoom, 0.01)) * 10) / 10)
}

// Uma frase só para "sessão sem saída": com propósito ou sem, duas frases
// diferentes faziam o mesmo estado parecer dois.
export const NO_OUTPUT_TEXT = 'Sem saída ainda.'

/** Texto do cartão quando a tela só tem o banner de boot. */
export function bannerOnlyText(n: Pick<SessionGraphNode, 'purpose' | 'purposeHint'>): string {
  return n.purpose ? NO_OUTPUT_TEXT : (n.purposeHint ?? NO_OUTPUT_TEXT)
}
