import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import script from "../../content/script.json";
import type { Locale } from "../config";
import { StaggerText } from "../motion";
import {
  C,
  DiagramCanvas,
  MONO,
  alpha,
  mix,
  type DiagramEdge,
  type DiagramNode,
} from "../ui";
import { roughRect, seedFrom } from "../ui/rough";

// O plano longo do filme. Quase nada se move: o agente desenha, a mão humana
// arrasta UM nó, e o patch seguinte contorna sem desfazer o arrasto. O fantasma
// tracejado na posição original é o que torna esse "sem desfazer" legível em
// vídeo — sem ele o espectador não sabe que o nó saiu do lugar.

const scene = script.scenes.find((s) => s.id === "diagrams")!;

const EASE_ENTER = Easing.bezier(0.05, 0.7, 0.1, 1);
const EASE_EXIT = Easing.bezier(0.3, 0, 0.8, 0.15);
const EASE_MOVE = Easing.bezier(0.2, 0, 0, 1);

const HOLD = 34;
const SPAN = 350;

const CANVAS_W = 1440;
const CANVAS_H = 660;
const PAD = 24;
const PANEL_X = (1920 - (CANVAS_W + PAD * 2)) / 2;
const PANEL_Y = 126;

const WORKER_HOME = { x: 500, y: 420 };
const WORKER_MOVED = { x: 415, y: 530 };
const NODE_W = 250;
const NODE_H = 96;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Ponteiro do mouse no dialeto do sistema: bico no ponto exato do evento. */
const CURSOR_D =
  "M 0 0 L 0 19 L 5 14.6 L 7.9 21.2 L 11 19.8 L 8.1 13.4 L 14.4 13.4 Z";

export const Diagrams: React.FC<{
  durationInFrames: number;
  locale: Locale;
}> = ({ durationInFrames, locale }) => {
  const frame = useCurrentFrame();
  const labels = scene.onScreen[locale];

  const s = (durationInFrames - HOLD) / SPAN;
  const at = (a: number, b: number, easing = EASE_ENTER) =>
    interpolate(frame, [a * s, b * s], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing,
    });

  const panel = at(0, 18);

  // O agente desenha: caixas em cascata, setas depois que as caixas fecharam.
  // A cascata começa cedo e com stagger curto — abrir num canvas vazio com uma
  // caixa só custava quase dois segundos de tela morta.
  const nodeP = [at(10, 44), at(24, 58), at(38, 72), at(52, 86)];
  const edgeP = [at(92, 126), at(102, 136), at(112, 146), at(122, 156)];

  // A mão humana.
  const cursorIn = at(178, 202);
  const drag = at(206, 246, EASE_MOVE);
  const cursorOut = at(258, 282, EASE_EXIT);
  // O fantasma tracejado nasce junto com o arrasto e dissolve junto com o glow
  // do patch: enquanto o patch chega ele é a prova de que o nó saiu do lugar e
  // ninguém desfez; depois disso é sobra de render no meio do diagrama.
  const ghost = clamp01(at(212, 236)) * (1 - clamp01(at(316, 346, EASE_EXIT)));

  // O patch do agente, depois do arrasto.
  const patchNode = at(276, 316);
  const patchEdges = [at(298, 332), at(308, 342)];
  const glow = clamp01(at(276, 300)) * (1 - clamp01(at(316, 346, EASE_EXIT)));

  const worker = {
    x: lerp(WORKER_HOME.x, WORKER_MOVED.x, drag),
    y: lerp(WORKER_HOME.y, WORKER_MOVED.y, drag),
  };

  const nodes: DiagramNode[] = [
    {
      id: "gateway",
      x: 80,
      y: 260,
      w: NODE_W,
      h: NODE_H,
      label: "api-gateway",
      progress: nodeP[0],
    },
    {
      id: "auth",
      x: 500,
      y: 96,
      w: NODE_W,
      h: NODE_H,
      label: "auth-svc",
      progress: nodeP[1],
    },
    {
      id: "worker",
      x: worker.x,
      y: worker.y,
      w: NODE_W,
      h: NODE_H,
      label: "worker",
      progress: nodeP[2],
    },
    {
      id: "postgres",
      x: 930,
      y: 260,
      w: 240,
      h: NODE_H,
      label: "postgres",
      progress: nodeP[3],
    },
    {
      id: "cache",
      x: 880,
      y: 500,
      w: 230,
      h: 92,
      label: "cache",
      progress: patchNode,
    },
  ];

  const edges: DiagramEdge[] = [
    { from: "gateway", to: "auth", tone: "accent", progress: edgeP[0] },
    { from: "gateway", to: "worker", tone: "accent", progress: edgeP[1] },
    { from: "auth", to: "postgres", tone: "accent", progress: edgeP[2] },
    { from: "worker", to: "postgres", tone: "accent", progress: edgeP[3] },
    { from: "worker", to: "cache", tone: "accent", progress: patchEdges[0] },
    { from: "cache", to: "postgres", tone: "accent", progress: patchEdges[1] },
  ];

  // O cursor pega o nó pelo centro e viaja junto com ele.
  // Pega o no pelo canto de cima, nao pelo centro: no centro o ponteiro tapa
  // o rotulo justamente no frame em que o espectador precisa ler o nome.
  const grab = {
    x: lerp(1380, WORKER_HOME.x + 58, clamp01(cursorIn)),
    y: lerp(690, WORKER_HOME.y + 26, clamp01(cursorIn)),
  };
  const cursor = {
    x: grab.x + (worker.x - WORKER_HOME.x) + cursorOut * 90,
    y: grab.y + (worker.y - WORKER_HOME.y) + cursorOut * 70,
  };
  const cursorAlpha = clamp01(cursorIn) * (1 - clamp01(cursorOut));
  const grabbing = drag > 0 && cursorOut < 0.4;

  const labelBeats = [14, 150, 268];
  const activeLabel = labelBeats.reduce(
    (acc, beat, i) => (frame >= beat * s ? i : acc),
    -1,
  );

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div
        style={{
          position: "absolute",
          left: PANEL_X,
          top: PANEL_Y,
          width: CANVAS_W + PAD * 2,
          height: CANVAS_H + PAD * 2,
          borderRadius: 16,
          // O glow do patch e maior que o no: sem clip ele vaza pra fora do painel.
          overflow: "hidden",
          background: C.surface,
          border: `1px solid ${C.border}`,
          boxShadow: `0 40px 120px -30px rgba(0,0,0,0.9)`,
          opacity: clamp01(panel),
          transform: `translateY(${((1 - clamp01(panel)) * 12).toFixed(2)}px)`,
        }}
      >
        <div style={{ position: "absolute", left: PAD, top: PAD }}>
          {/* Glow do momento do valor: o nó que VOCÊ moveu, quando o patch chega. */}
          {glow > 0.001 && (
            <div
              style={{
                position: "absolute",
                left: worker.x + NODE_W / 2 - 210,
                top: worker.y + NODE_H / 2 - 210,
                width: 420,
                height: 420,
                borderRadius: "50%",
                background: `radial-gradient(circle, ${alpha(C.accent, 0.15)} 0%, ${alpha(C.accent, 0.09)} 38%, transparent 72%)`,
                opacity: glow,
              }}
            />
          )}

          <DiagramCanvas
            width={CANVAS_W}
            height={CANVAS_H}
            nodes={nodes}
            edges={edges}
            background={C.bg}
          />

          {/* Fantasma da posição original + cursor: por cima do canvas. */}
          <svg
            width={CANVAS_W}
            height={CANVAS_H}
            viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
            style={{ position: "absolute", left: 0, top: 0 }}
            fill="none"
          >
            {/* Realce do no preservado: o mesmo traco do DiagramCanvas, mais
                grosso e translucido por cima. O glow radial sozinho nao aparece
                em 1080p sobre #08080B. */}
            {glow > 0.001 && (
              <path
                d={roughRect(
                  worker.x,
                  worker.y,
                  NODE_W,
                  NODE_H,
                  seedFrom("worker"),
                  3.2,
                )}
                stroke={C.accent}
                strokeWidth={5}
                strokeLinecap="round"
                opacity={glow * 0.5}
              />
            )}

            {ghost > 0.001 && (
              <path
                d={roughRect(
                  WORKER_HOME.x,
                  WORKER_HOME.y,
                  NODE_W,
                  NODE_H,
                  seedFrom("worker"),
                  3.2,
                )}
                stroke={mix(C.textDim, C.bg, 0.55)}
                strokeWidth={1.5}
                strokeDasharray="6 9"
                opacity={clamp01(ghost) * 0.9}
              />
            )}

            {cursorAlpha > 0.001 && (
              <g
                transform={`translate(${cursor.x.toFixed(2)}, ${cursor.y.toFixed(2)})`}
                opacity={cursorAlpha}
              >
                {grabbing && (
                  <circle
                    cx={0}
                    cy={0}
                    r={17}
                    stroke={alpha(C.text, 0.35)}
                    strokeWidth={1.5}
                    fill={alpha(C.text, 0.06)}
                  />
                )}
                <path
                  d={CURSOR_D}
                  fill={C.text}
                  stroke={C.bg}
                  strokeWidth={1.4}
                  strokeLinejoin="round"
                />
              </g>
            )}
          </svg>
        </div>
      </div>

      {/* Os três rótulos em mono: só o mais recente fica aceso. */}
      <div
        style={{
          position: "absolute",
          left: PANEL_X,
          top: PANEL_Y + CANVAS_H + PAD * 2 + 34,
          display: "flex",
          flexDirection: "column",
          gap: 13,
        }}
      >
        {labels.map((label, i) => (
          <div
            key={label}
            style={{
              fontFamily: MONO,
              fontSize: 17,
              letterSpacing: "0.02em",
              color: i === activeLabel ? C.text : mix(C.textDim, C.bg, 0.5),
              opacity: frame >= labelBeats[i] * s ? 1 : 0,
            }}
          >
            <StaggerText
              text={label}
              by="char"
              stagger={1}
              delay={labelBeats[i] * s}
              y={10}
              blur={4}
            />
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
