import { C, DISPLAY, MONO, alpha, mix } from "./tokens";
import { arrowHead, drawProps, roughLine, roughRect, seedFrom } from "./rough";
import type { Tone } from "./Composer";

// A área de diagramas — o mesmo desenho à mão do Excalidraw que o app usa.
// Cada nó e cada seta aceita seu próprio progresso 0..1, então a cena decide a
// ordem em que o desenho aparece: primeiro as caixas, depois as setas que as
// ligam, e o rótulo só quando o traço já fechou.

const TONE: Record<Tone, string> = {
  accent: C.accent,
  accent2: C.accent2,
  warning: C.warning,
  success: C.success,
  info: C.info,
  danger: C.danger,
};

export interface DiagramNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** Segunda linha, em mono (ex.: o path do arquivo). */
  sub?: string;
  tone?: Tone;
  /** Sobrescreve o progresso global só para este nó. */
  progress?: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  tone?: Tone;
  progress?: number;
}

export interface DiagramCanvasProps {
  width?: number;
  height?: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Progresso padrão de tudo que não trouxer o seu. */
  progress?: number;
  /** Grade de pontos do canvas. */
  grid?: boolean;
  background?: string;
}

type Pt = readonly [number, number];

/** Ponto de saída na borda do nó, na direção do alvo, com uma folga de 8px. */
function anchor(n: DiagramNode, toward: Pt): Pt {
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const pad = 8;
  const sx =
    dx !== 0 ? (n.w / 2 + pad) / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const sy =
    dy !== 0 ? (n.h / 2 + pad) / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** Rampa auxiliar: 0 antes de `from`, 1 depois de `to`. */
const ramp = (v: number, from: number, to: number) =>
  clamp01((v - from) / (to - from));

export const DiagramCanvas: React.FC<DiagramCanvasProps> = ({
  width = 880,
  height = 460,
  nodes,
  edges,
  progress = 1,
  grid = true,
  background = C.bg,
}) => {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div
      style={{
        width,
        height,
        position: "relative",
        background,
        backgroundImage: grid
          ? `radial-gradient(${alpha(C.textDim, 0.16)} 1px, transparent 1px)`
          : undefined,
        backgroundSize: grid ? "22px 22px" : undefined,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        fill="none"
      >
        {/* Setas por baixo das caixas: onde o traço encosta, a caixa cobre. */}
        {edges.map((e) => {
          const a = byId.get(e.from);
          const b = byId.get(e.to);
          if (!a || !b) return null;
          const p = clamp01(e.progress ?? progress);
          if (p <= 0) return null;

          const ca: Pt = [a.x + a.w / 2, a.y + a.h / 2];
          const cb: Pt = [b.x + b.w / 2, b.y + b.h / 2];
          const p0 = anchor(a, cb);
          const p1 = anchor(b, ca);
          const seed = seedFrom(`${e.from}->${e.to}`);
          const color = TONE[e.tone ?? "accent2"];
          // A ponta só fecha depois que a haste chegou lá.
          const headP = ramp(p, 0.82, 1);
          const mid: Pt = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];

          return (
            <g key={`${e.from}->${e.to}`}>
              <path
                d={roughLine(p0, p1, seed, 2.4)}
                stroke={color}
                strokeWidth={2}
                strokeLinecap="round"
                {...drawProps(p)}
              />
              {headP > 0 && (
                <path
                  d={arrowHead(p0, p1, seed + 7, 15)}
                  stroke={color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  {...drawProps(headP)}
                />
              )}
              {e.label && (
                <text
                  x={mid[0]}
                  y={mid[1] - 9}
                  textAnchor="middle"
                  fill={mix(C.textDim, background, 0.9)}
                  style={{ fontFamily: MONO, fontSize: 12 }}
                  opacity={ramp(p, 0.7, 1)}
                >
                  {e.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Caixas: passada dupla (duas sementes) é o que dá o traço de caneta. */}
        {nodes.map((n) => {
          const p = clamp01(n.progress ?? progress);
          if (p <= 0) return null;
          const seed = seedFrom(n.id);
          const color = TONE[n.tone ?? "accent"];
          const d1 = roughRect(n.x, n.y, n.w, n.h, seed, 3.2);
          const d2 = roughRect(n.x, n.y, n.w, n.h, seed + 101, 4.6);
          const fillP = ramp(p, 0.45, 1);
          const textP = ramp(p, 0.6, 1);

          return (
            <g key={n.id}>
              <path
                d={d1}
                fill={alpha(color, 0.1)}
                stroke="none"
                opacity={fillP}
              />
              <path
                d={d1}
                stroke={color}
                strokeWidth={2}
                strokeLinecap="round"
                {...drawProps(p)}
              />
              <path
                d={d2}
                stroke={alpha(color, 0.55)}
                strokeWidth={1.5}
                strokeLinecap="round"
                {...drawProps(clamp01(p * 1.08))}
              />
              <text
                x={n.x + n.w / 2}
                y={n.y + n.h / 2 + (n.sub ? -4 : 6)}
                textAnchor="middle"
                fill={C.text}
                style={{ fontFamily: DISPLAY, fontSize: 17, fontWeight: 600 }}
                opacity={textP}
              >
                {n.label}
              </text>
              {n.sub && (
                <text
                  x={n.x + n.w / 2}
                  y={n.y + n.h / 2 + 18}
                  textAnchor="middle"
                  fill={C.textDim}
                  style={{ fontFamily: MONO, fontSize: 12 }}
                  opacity={textP}
                >
                  {n.sub}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
};
