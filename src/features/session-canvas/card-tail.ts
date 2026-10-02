// PURO: quais cartões assinam a saída ao vivo, e como pintar o que chega.
import type { CardViewState } from '../../../shared/types/canvas'
import type { ScreenTailLine, ScreenTailSegment } from '../../../shared/types/send-prompt'
import { BRIEF_BELOW } from './card-display'

// Mesmo teto do main (MAX_TAIL_SUBSCRIPTIONS): acima disso o main corta, e
// cortar aqui deixa escolher QUAIS ficam — os mais perto do centro da tela.
export const TAIL_CAP = 25

export interface TailCandidate {
  sessionId: string
  view: CardViewState
  // Caixa do cartão em coordenadas do fluxo (absolutas).
  x: number
  y: number
  w: number
  h: number
  // Zoom mínimo em que este cartão ainda desenha a saída (padrão BRIEF_BELOW). A
  // mãe fica no cartão cheio até MOTHER_MINI_BELOW.
  minZoom?: number
}

export interface ViewportBox {
  x: number
  y: number
  zoom: number
  width: number
  height: number
}

// Só cartão ABERTO e com algum pixel na tela, e só com zoom em que o texto se
// lê (abaixo disso o corpo vira o resumo 'brief' e a saída não aparece).
export function tailSubscription(
  cards: TailCandidate[],
  vp: ViewportBox,
  cap = TAIL_CAP,
): string[] {
  if (vp.width <= 0 || vp.height <= 0) return []
  const left = -vp.x / vp.zoom
  const top = -vp.y / vp.zoom
  const right = left + vp.width / vp.zoom
  const bottom = top + vp.height / vp.zoom
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  const visible = cards.filter(
    (c) =>
      c.view === 'open' &&
      vp.zoom >= (c.minZoom ?? BRIEF_BELOW) &&
      c.x < right && c.x + c.w > left && c.y < bottom && c.y + c.h > top,
  )
  const dist = (c: TailCandidate) => Math.hypot(c.x + c.w / 2 - cx, c.y + c.h / 2 - cy)
  return visible
    .sort((a, b) => dist(a) - dist(b))
    .slice(0, cap)
    .map((c) => c.sessionId)
    .sort()
}

export function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

// Paleta ANSI padrão do xterm.js, exceto 0/8: o tema do app redefine as duas
// (themes.ts → xtermTheme) e o cartão segue o mesmo.
const ANSI_16 = [
  'var(--color-surface)',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
  'var(--color-text-dim)',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff',
]
const CUBE = [0, 95, 135, 175, 215, 255]

function hex(n: number): string {
  return n.toString(16).padStart(2, '0')
}

export function paletteColor(index: number): string {
  if (index < 16) return ANSI_16[index]
  if (index < 232) {
    const i = index - 16
    return `#${hex(CUBE[Math.floor(i / 36)])}${hex(CUBE[Math.floor(i / 6) % 6])}${hex(CUBE[i % 6])}`
  }
  const gray = 8 + (index - 232) * 10
  return `#${hex(gray)}${hex(gray)}${hex(gray)}`
}

export function segmentColor(seg: ScreenTailSegment): string | undefined {
  if (seg.fg === undefined) return undefined
  return typeof seg.fg === 'number' ? paletteColor(seg.fg) : seg.fg
}

export function tailText(lines: ScreenTailLine[]): string[] {
  return lines.map((l) => l.map((s) => s.t).join(''))
}

// Prévia do cartão: as últimas linhas NÃO vazias da tela. Com as 10 últimas
// cruas, o cartão mostrava o cabeçalho de boot (sessão/cwd/nome) em vez do que o
// agente faz agora, e todos os cartões ficavam iguais.
export const CARD_PREVIEW_LINES = 4
// Moldura do banner de boot (╭│╰ do Claude Code, ┌│└ do stub).
const BANNER_LINE = /^\s*[╭╰│┃┌└├┐┘╮╯]/

/** null = a tela só tem o banner de boot: o cartão mostra o propósito no lugar. */
export function cardPreviewLines(
  lines: ScreenTailLine[],
  max = CARD_PREVIEW_LINES,
): ScreenTailLine[] | null {
  const filled = lines.filter((l) => l.some((s) => s.t.trim() !== ''))
  const text = (l: ScreenTailLine) => l.map((s) => s.t).join('')
  if (filled.length === 0 || filled.every((l) => BANNER_LINE.test(text(l)))) return null
  return filled.slice(-max)
}

/** "~/…/lexter-copilot-api": o cwd discreto no pé do cartão. */
export function cwdFooter(repoLabel: string | null): string | null {
  return repoLabel ? `~/…/${repoLabel}` : null
}
