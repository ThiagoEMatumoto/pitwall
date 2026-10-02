import type { CSSProperties } from 'react'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import { cardDetail, compensatedPx } from './card-display'

// Curto: o cartão tem largura fixa e "MÃE · 3 FILHAS" em caixa alta engolia o
// título. Compacto (zoom brief, cartão recolhido) é só a contagem ao lado da
// coroa. O extenso ("lidera 3 filhas") vai no tooltip.
export function motherBadgeText(childCount: number, compact = false): string {
  return compact ? String(childCount) : `MÃE · ${childCount}`
}

// >= 11px na tela em toda a faixa em que o cartão ainda tem texto (brief começa
// em 0,45): a fonte cresce na razão inversa do zoom até 25 (25 × 0,45 = 11,25).
// O teto antigo (19,2) dava 8,6px no zoom 0,45.
const BADGE_MAX_PX = 25
export function motherBadgePx(zoom: number): number {
  return compensatedPx(zoom, 12, BADGE_MAX_PX)
}
export function batonChipPx(zoom: number): number {
  return compensatedPx(zoom, 11.5, BADGE_MAX_PX)
}

// Identidade da mãe: uma faixa de 3px no topo, na cor da coroa. Não é contorno:
// a borda dupla (rodada 2) ainda lia como foco/seleção no resumo e na visão geral.
// Contorno fica só para o foco; a borda e o glow seguem sendo do estado.
export const MOTHER_STRIP = 'inset 0 3px 0 0 var(--color-accent)'
export function motherFrame(node: SessionGraphNode, base: CSSProperties): CSSProperties {
  if (!node.isMother) return base
  return {
    ...base,
    boxShadow: base.boxShadow ? `${MOTHER_STRIP}, ${base.boxShadow}` : MOTHER_STRIP,
  }
}

// O cartão da mãe é a peça principal do card da feature: fica no cartão cheio
// (saída ao vivo + barra de prompt) até um zoom bem baixo. Abaixo dele, o mini —
// nome, selo, status, a última linha e o composer, contra-escalados para a tela.
export const MOTHER_MINI_BELOW = 0.55
export type MotherDetail = 'full' | 'mini'
export function motherDetail(zoom: number): MotherDetail {
  return zoom < MOTHER_MINI_BELOW ? 'mini' : 'full'
}

// A alça de tamanho segue o degrau dos cartões comuns, não o da mãe: abaixo dele
// a raia está no layout compacto e o soltar fixaria os irmãos nessas coordenadas.
export function motherResizable(zoom: number): boolean {
  return cardDetail(zoom) === 'full'
}

// Saída ao vivo da mãe: 16 linhas em 14px (>= 12px efetivos no zoom de leitura
// do enquadrar, MOTHER_READ_ZOOM).
export const MOTHER_TAIL_LINES = 16
export const MOTHER_TAIL_PX = 14
// A tela inteira que o main espelha (TAIL_LINES de ipc/send-prompt.ts): as linhas
// vazias caem antes do corte de 16, então a janela precisa ser maior que 16.
export const MOTHER_TAIL_WINDOW = 20
