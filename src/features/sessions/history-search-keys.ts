import type { TuiHistorySearch } from './tui-picker-parser'

// Teclas da busca de histórico (Ctrl+R), pelo que as sondas history-populated e
// history-fullscreen (claude 2.1.318) mostraram em cada tela. [] = a ação não cabe agora.
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const BACKSPACE = '\x7f'

// O que aceitar faz: inline, Enter manda o match como prompt; no modal, Enter só preenche.
export type HistoryAcceptEffect = 'send' | 'fill'

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]+/g, '')

// Do texto anterior do campo para o novo: apaga até o prefixo comum e digita o resto.
export function historyQueryKeys(prev: string, next: string): string[] {
  const a = clean(prev)
  const b = clean(next)
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  const erase = Array<string>([...a.slice(common)].length).fill(BACKSPACE)
  const typed = b.slice(common)
  return typed === '' ? erase : [...erase, typed]
}

function hasResult(p: TuiHistorySearch): boolean {
  return p.mode === 'inline'
    ? p.match != null
    : p.cursorIndex != null && (p.results?.length ?? 0) > 0
}

export function historyAcceptEffect(p: TuiHistorySearch): HistoryAcceptEffect {
  return p.mode === 'inline' ? 'send' : 'fill'
}

export function historyAcceptKeys(p: TuiHistorySearch): string[] {
  return hasResult(p) ? ['\r'] : []
}

// Só preencher: Tab nas duas telas. No modal é o mesmo efeito do Enter.
export function historyFillKeys(p: TuiHistorySearch): string[] {
  return hasResult(p) ? ['\t'] : []
}

// Inline: Ctrl+R vai para o match anterior. Modal: ↑ (a lista cresce para cima).
export function historyOlderKeys(p: TuiHistorySearch): string[] {
  if (p.mode === 'inline') return p.query !== '' && !p.noMatch ? ['\x12'] : []
  if (p.cursorIndex == null) return []
  return p.cursorIndex > 0 || p.moreAbove ? [UP] : []
}

export function historyNewerKeys(p: TuiHistorySearch): string[] {
  if (p.mode !== 'modal' || p.cursorIndex == null || !p.results) return []
  return p.cursorIndex < p.results.length - 1 || p.moreBelow ? [DOWN] : []
}

export function historySelectKeys(p: TuiHistorySearch, index: number): string[] {
  if (p.mode !== 'modal' || p.cursorIndex == null || !p.results?.some((r) => r.index === index))
    return []
  const delta = index - p.cursorIndex
  return Array<string>(Math.abs(delta)).fill(delta > 0 ? DOWN : UP)
}

// Inline: com query, Esc deixaria o match na caixa; Ctrl+C fecha e esvazia. Sem query, Esc
// devolve o rascunho. Modal: Esc fecha e devolve o rascunho.
export function historyCancelKeys(p: TuiHistorySearch): string[] {
  return p.mode === 'inline' && p.query !== '' ? ['\x03'] : ['\x1b']
}

export function historyScopeKeys(p: TuiHistorySearch): string[] {
  return p.mode === 'modal' ? ['\x13'] : []
}
