// Geometria "à mão livre" no dialeto do Excalidraw: cada traço é uma bezier com
// o ponto de controle deslocado, e cada forma é desenhada DUAS vezes com
// sementes diferentes — é a passada dupla que dá a sensação de caneta, não a
// amplitude do tremor. O ruído é determinístico (mulberry32 semeado pelo id da
// forma) porque em vídeo um jitter por frame vira fervura.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

type Pt = readonly [number, number];

/** Segmento trêmulo entre dois pontos: bezier com controle fora do eixo. */
function wobble(a: Pt, b: Pt, rnd: () => number, amp: number): string {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  // Deslocamento perpendicular ao segmento — é o que curva o traço.
  const off = (rnd() - 0.5) * amp * 2;
  const cx = mx + (-dy / len) * off;
  const cy = my + (dx / len) * off;
  return `Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
}

function jitter(p: Pt, rnd: () => number, amp: number): Pt {
  return [p[0] + (rnd() - 0.5) * amp, p[1] + (rnd() - 0.5) * amp];
}

/**
 * Retângulo de cantos irregulares. Os cantos passam do ponto (overshoot) como
 * numa caneta que não freia na quina, e o traço não fecha exatamente onde
 * começou.
 */
export function roughRect(
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  amp = 2.2,
): string {
  const rnd = mulberry32(seed);
  const tl: Pt = [x, y];
  const tr: Pt = [x + w, y];
  const br: Pt = [x + w, y + h];
  const bl: Pt = [x, y + h];
  // Cantos tremem POUCO e arestas tremem muito: jitter cheio nas quinas
  // inclina a caixa inteira e o retângulo vira trapézio.
  const j = (p: Pt) => jitter(p, rnd, amp * 0.5);
  const a = j(tl);
  const b = j(tr);
  const c = j(br);
  const d = j(bl);
  // Fecha um pouco além do início: a quina de saída sobra sobre a de entrada.
  const close: Pt = [
    a[0] + (rnd() - 0.5) * amp + amp * 1.2,
    a[1] + (rnd() - 0.5) * amp,
  ];
  return [
    `M ${a[0].toFixed(2)} ${a[1].toFixed(2)}`,
    wobble(a, b, rnd, amp),
    wobble(b, c, rnd, amp),
    wobble(c, d, rnd, amp),
    wobble(d, close, rnd, amp),
  ].join(" ");
}

/** Linha trêmula, para setas e sublinhados. */
export function roughLine(a: Pt, b: Pt, seed: number, amp = 2.2): string {
  const rnd = mulberry32(seed);
  const p0 = jitter(a, rnd, amp * 0.6);
  const p1 = jitter(b, rnd, amp * 0.6);
  return `M ${p0[0].toFixed(2)} ${p0[1].toFixed(2)} ${wobble(p0, p1, rnd, amp)}`;
}

/** As duas hastes da ponta da seta, já apontando na direção do segmento. */
export function arrowHead(
  from: Pt,
  to: Pt,
  seed: number,
  len = 16,
  spread = 0.42,
): string {
  const rnd = mulberry32(seed);
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const wing = (sign: number): string => {
    const a = ang + Math.PI + sign * spread;
    const l = len * (0.85 + rnd() * 0.3);
    const px = to[0] + Math.cos(a) * l;
    const py = to[1] + Math.sin(a) * l;
    return `M ${to[0].toFixed(2)} ${to[1].toFixed(2)} L ${px.toFixed(2)} ${py.toFixed(2)}`;
  };
  return `${wing(1)} ${wing(-1)}`;
}

/**
 * Props de traço para revelar um path por "desenho" (0..1). pathLength="1"
 * normaliza o comprimento, então o dash não depende da geometria real.
 */
export function drawProps(progress: number): {
  pathLength: number;
  strokeDasharray: number;
  strokeDashoffset: number;
} {
  const p = Math.max(0, Math.min(1, progress));
  return { pathLength: 1, strokeDasharray: 1, strokeDashoffset: 1 - p };
}
