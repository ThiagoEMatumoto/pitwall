// Enquadramento inicial do canvas, separado do DiagramEditor pra ser testável
// sem montar o Excalidraw.

// Faixa do topo coberta pela toolbar flutuante do Excalidraw (ilha de ~48px
// + margem). Sem descontar, o header do primeiro bloco abria embaixo dela.
export const VIEWPORT_TOP_INSET = 72;
const FILL = 0.9;
// Nome do frame: desenhado acima da caixa, fora do x/y/width/height dele.
const FRAME_NAME_HEIGHT = 24;

export interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface SceneElement {
  type?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  points?: readonly (readonly [number, number])[];
}

/**
 * Caixa do conteúdo visível. Setas/linhas pelos pontos: o x de uma seta é o
 * 1º ponto, e uma seta que volta pra esquerda (deploy, retreino) tem pontos
 * negativos — x + width estourava a borda direita e o diagrama abria
 * encostado à esquerda.
 */
export function contentBounds(
  elements: readonly SceneElement[],
): ContentBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const e of elements) {
    if (e.isDeleted) continue;
    if (e.points && e.points.length > 0) {
      for (const [px, py] of e.points) add(e.x + px, e.y + py);
      continue;
    }
    add(e.x, e.type === "frame" ? e.y - FRAME_NAME_HEIGHT : e.y);
    add(e.x + e.width, e.y + e.height);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
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
