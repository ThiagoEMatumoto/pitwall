// Enquadramento inicial do canvas, separado do DiagramEditor pra ser testável
// sem montar o Excalidraw.

// Faixa do topo coberta pela toolbar flutuante do Excalidraw (ilha de ~48px
// + margem). Sem descontar, o header do primeiro bloco abria embaixo dela.
export const VIEWPORT_TOP_INSET = 72;
const FILL = 0.85;

export interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * scroll/zoom que centralizam o conteúdo na área visível abaixo da toolbar,
 * com zoom no máximo 100%. No Excalidraw, telaY = (cenaY + scrollY) * zoom.
 */
export function frameViewport(
  b: ContentBounds,
  viewport: { width: number; height: number },
): { scrollX: number; scrollY: number; zoom: number } {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const availH = Math.max(1, viewport.height - VIEWPORT_TOP_INSET);
  const zoom = Math.min(1, FILL * Math.min(viewport.width / bw, availH / bh));
  return {
    scrollX: viewport.width / (2 * zoom) - (b.minX + bw / 2),
    scrollY: (VIEWPORT_TOP_INSET + availH / 2) / zoom - (b.minY + bh / 2),
    zoom,
  };
}
