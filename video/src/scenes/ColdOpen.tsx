import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import scriptJson from "../../content/script.json";
import type { Locale } from "../config";
import { StaggerText, springAt } from "../motion";
import { C, MONO, TerminalLines, alpha, type TermLine } from "../ui";

// Cena 1 — tensão. Um cursor no centro vira dois, quatro, oito: a câmera recua
// a cada estágio e o quadro satura. O SENTIDO fica na legenda; o RUÍDO, nos
// panes. Por isso só o pane focal tem cursor e chevron — oito caretas ciano
// seriam poluição, e o ciano é evento raro no filme inteiro.

const SCENE = scriptJson.scenes.find(
  (s) => s.id === "cold-open",
) as unknown as { onScreen: Record<Locale, string[]> };

// Curvas da direção de arte. Nada de linear em posição/escala.
const EASE_MOVE = Easing.bezier(0.2, 0, 0, 1);
const EASE_OUT = Easing.bezier(0.3, 0, 0.8, 0.15);

const HOLD = 26;

/**
 * Cinco estágios, não quatro: 1 → 2 → 4 → 8 → saturação. As frações encurtam
 * (37/33/27/23 frames em pt-BR) — é o ritmo acelerando.
 */
const STAGE_AT = [0, 0.22, 0.42, 0.58, 0.72];
/** Quantos panes existem a partir de cada estágio. */
const STAGE_COUNT = [1, 2, 4, 8, 8];
/** Escala da câmera por estágio. O recuo é o que traduz "está virando muita coisa". */
const STAGE_SCALE = [2.3, 1.7, 1.35, 1.0];
/** Frames que a câmera leva pra assentar depois de cada estágio. */
const CAM_SETTLE = 16;

/**
 * A legenda i pertence ao estágio LABEL_STAGE[i]. "oito" precisa cair quando
 * há OITO panes — o estágio de quatro passa sem legenda, e esse respiro é o
 * que faz o quarto beat bater.
 */
const LABEL_STAGE = [0, 1, 3, 4];
const LABEL_SIZE = [34, 38, 46, 56];

const CELL_W = 400;
const CELL_H = 186;
const GAP = 24;
const COLS = 4;
const GRID_W = COLS * CELL_W + (COLS - 1) * GAP;
const GRID_H = 2 * CELL_H + GAP;

/** Ordem de revelação: cresce do miolo pra fora, mantendo o quadro equilibrado. */
const ORDER: Array<[row: number, col: number]> = [
  [0, 1],
  [1, 2],
  [0, 2],
  [1, 1],
  [0, 0],
  [1, 3],
  [0, 3],
  [1, 0],
];

const cellLeft = (col: number) => col * (CELL_W + GAP);
const cellTop = (row: number) => row * (CELL_H + GAP);
const cellCenter = ([row, col]: [number, number]) => ({
  x: cellLeft(col) + CELL_W / 2 - GRID_W / 2,
  y: cellTop(row) + CELL_H / 2 - GRID_H / 2,
});

// Conteúdo dos panes: log de tool-calls de agente. NÃO é texto de roteiro (esse
// vem do script.json, abaixo) — é cenário, e é igual nos dois locales porque
// nome de ferramenta e comando de shell não se traduzem. Seis linhas em todos
// para que a caixa fique cheia: caixa com metade vazia denuncia mock.
// No máximo UMA linha colorida por pane — 90% do quadro é cinza por contrato.
const POOL: TermLine[][] = [
  [
    { prefix: "❯", text: "claude --resume session-cache", tone: "command" },
    { text: "read src/lib/session-cache.ts", tone: "dim" },
    { text: 'grep "TTL" src/', tone: "dim" },
    { text: "read src/lib/session-store.ts", tone: "dim" },
    { text: "edit session-cache.ts", tone: "output" },
    { text: "✓ 1 file changed", tone: "success" },
  ],
  [
    { text: "read src/api/auth.ts", tone: "dim" },
    { text: "bash npm test -- auth", tone: "output" },
    { text: "2 failing · 14 passed", tone: "dim" },
    { text: "read auth.spec.ts", tone: "dim" },
    { text: "edit auth.spec.ts", tone: "output" },
    { text: "✓ 16 passed", tone: "success" },
  ],
  [
    { text: 'grep "expires_at" .', tone: "dim" },
    { text: "read migrations/0041.sql", tone: "dim" },
    { text: "read migrations/0042.sql", tone: "dim" },
    { text: "plan: add partial index", tone: "output" },
    { text: "write PLAN.md", tone: "output" },
    { text: "⚠ waiting for you", tone: "warning" },
  ],
  [
    { text: "read infra/main.tf", tone: "dim" },
    { text: "read infra/variables.tf", tone: "dim" },
    { text: "bash terraform plan", tone: "output" },
    { text: "3 to change · 0 to add", tone: "dim" },
    { text: "edit main.tf", tone: "output" },
    { text: "bash terraform plan", tone: "output" },
  ],
  [
    { text: "read etl/loader.py", tone: "dim" },
    { text: "read etl/schema.py", tone: "dim" },
    { text: "edit loader.py", tone: "output" },
    { text: "bash pytest -q", tone: "output" },
    { text: "58 passed in 6.1s", tone: "dim" },
    { text: "bash ruff check .", tone: "output" },
  ],
  [
    { text: "read ui/Composer.tsx", tone: "dim" },
    { text: "read ui/tokens.ts", tone: "dim" },
    { text: "edit Composer.tsx", tone: "output" },
    { text: "bash npm run typecheck", tone: "output" },
    { text: "bash npm run build", tone: "output" },
    { text: "✓ built in 4.2s", tone: "success" },
  ],
  [
    { text: 'grep "TODO" src/', tone: "dim" },
    { text: "read docs/adr-012.md", tone: "dim" },
    { text: "read docs/adr-013.md", tone: "dim" },
    { text: "write PLAN.md", tone: "output" },
    { text: "edit PLAN.md", tone: "output" },
    { text: "5 steps · 0 done", tone: "dim" },
  ],
  [
    { text: "read .github/workflows", tone: "dim" },
    { text: "bash npm run lint", tone: "output" },
    { text: "12 problems · 12 fixable", tone: "dim" },
    { text: "edit eslint.config.js", tone: "output" },
    { text: "bash npm run lint --fix", tone: "output" },
    { text: "⚠ waiting for you", tone: "warning" },
  ],
];

/** Ruído determinístico por índice — o render precisa ser reprodutível. */
const rnd = (n: number) => {
  const s = Math.sin(n * 127.1 + 11.7) * 43758.5453;
  return s - Math.floor(s);
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export const ColdOpen: React.FC<{
  durationInFrames: number;
  locale: Locale;
}> = ({ durationInFrames, locale }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const labels = SCENE.onScreen[locale];
  const anim = durationInFrames - HOLD;
  const holdStart = durationInFrames - HOLD;
  const stages = STAGE_AT.map((f) => Math.round(f * anim));

  // ── Câmera: recua um degrau por estágio, com a curva de camada que já está
  // em tela. Fica parada até o estágio e assenta em CAM_SETTLE frames.
  const camRange = [
    stages[1],
    stages[1] + CAM_SETTLE,
    stages[2],
    stages[2] + CAM_SETTLE,
    stages[3],
    stages[3] + CAM_SETTLE,
  ];
  const camOpts = {
    extrapolateLeft: "clamp" as const,
    extrapolateRight: "clamp" as const,
    easing: EASE_MOVE,
  };
  const stageScale = interpolate(
    frame,
    camRange,
    [
      STAGE_SCALE[0],
      STAGE_SCALE[1],
      STAGE_SCALE[1],
      STAGE_SCALE[2],
      STAGE_SCALE[2],
      STAGE_SCALE[3],
    ],
    camOpts,
  );
  // Depois do último estágio a câmera volta a avançar de leve: a pressão sobe
  // sem que nada novo entre em cena.
  const creep = interpolate(frame, [stages[4], holdStart - 8], [1, 1.05], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_MOVE,
  });
  const scale = stageScale * creep;

  // Só o primeiro estágio descentraliza: o pane solitário mora fora do centro
  // da grade, então a câmera o traz pro meio e depois solta.
  const first = cellCenter(ORDER[0]);
  const tx = interpolate(frame, camRange, [-first.x, 0, 0, 0, 0, 0], camOpts);
  const ty = interpolate(frame, camRange, [-first.y, 0, 0, 0, 0, 0], camOpts);

  /** Frame em que o pane i nasce, a partir do estágio que o traz. */
  const bornAt = (i: number) => {
    if (i === 0) return stages[0];
    if (i === 1) return stages[1];
    if (i < STAGE_COUNT[2]) return stages[2] + (i - 2) * 3;
    return stages[3] + (i - 4) * 2;
  };

  // Ruído: grão e vinheta crescem até o último estágio, não além dele.
  const noise = interpolate(frame, [stages[1], stages[4]], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // O accent sai ANTES do corte, não junto com ele.
  const accentOut = interpolate(
    frame,
    [holdStart - 14, holdStart - 2],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE_OUT,
    },
  );

  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: GRID_W,
          height: GRID_H,
          marginLeft: -GRID_W / 2,
          marginTop: -GRID_H / 2,
          transformOrigin: "center center",
          transform: `scale(${scale.toFixed(4)}) translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`,
          willChange: "transform",
        }}
      >
        {ORDER.map((pos, i) => {
          const born = bornAt(i);
          const enter = springAt(frame, fps, {
            preset: "entrada",
            delay: born,
            durationInFrames: 18,
          });
          if (enter < 0.001) return null;

          // Cada sessão no seu ritmo: duração de digitação distinta por pane, e
          // as tardias digitam mais rápido — o quadro satura mais depressa.
          const typeDur = i === 0 ? 76 : 20 + Math.round(rnd(i) * 14);
          const typed = clamp01((frame - born - 2) / typeDur);

          // Cintilação só nos panes de fundo, e só em opacidade.
          const flicker =
            i === 0
              ? 1
              : 1 -
                0.12 *
                  noise *
                  (0.5 + 0.5 * Math.sin(frame * 0.5 + rnd(i + 3) * 6.28));

          return (
            <div
              key={`${pos[0]}-${pos[1]}`}
              style={{
                position: "absolute",
                left: cellLeft(pos[1]),
                top: cellTop(pos[0]),
                width: CELL_W,
                height: CELL_H,
                opacity: enter * flicker,
                transform: `scale(${(0.94 + 0.06 * enter).toFixed(4)})`,
                willChange: "transform, opacity",
              }}
            >
              <TerminalLines
                width={CELL_W}
                lines={POOL[i]}
                typed={typed}
                fontSize={14.5}
                cursor={i === 0 && frame < holdStart - 8}
              />
            </div>
          );
        })}
      </div>

      {/* ── Legendas: uma por beat, no mesmo ponto de ancoragem. Entra por
          caractere; sai por opacidade + escala (a saída não é a entrada ao
          contrário). O corpo cresce a cada beat: é o ritmo subindo. */}
      <div style={{ position: "absolute", left: 128, bottom: 104, height: 78 }}>
        {labels.map((text, i) => {
          const stage = LABEL_STAGE[i];
          const inAt = stages[stage] + 4;
          // A legenda sai um pouco ANTES do estágio seguinte: "dois" na tela
          // com quatro panes é erro de contagem, e duas legendas na mesma
          // âncora viram fantasma. Sai, respira, e a próxima entra.
          const nextStage = stage + 1;
          const outAt =
            nextStage < stages.length ? stages[nextStage] - 6 : null;
          const out =
            outAt === null
              ? 1
              : interpolate(frame, [outAt, outAt + 8], [1, 0], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: EASE_OUT,
                });
          if (frame < inAt - 1 || out < 0.002) return null;

          const size = LABEL_SIZE[Math.min(i, LABEL_SIZE.length - 1)];
          return (
            <div
              key={text}
              style={{
                position: "absolute",
                left: 0,
                bottom: 0,
                display: "flex",
                alignItems: "center",
                gap: 18,
                opacity: out,
                transform: `scale(${(0.98 + 0.02 * out).toFixed(4)})`,
                transformOrigin: "left bottom",
              }}
            >
              {/* Único uso de accent na cena: um traço de 2px. */}
              <span
                style={{
                  width: 2,
                  height: size * 0.62,
                  background: C.accent,
                  opacity:
                    springAt(frame, fps, { preset: "entrada", delay: inAt }) *
                    accentOut,
                }}
              />
              <StaggerText
                text={text.toUpperCase()}
                by="char"
                stagger={0.6}
                delay={inAt}
                preset="entrada"
                y={22}
                blur={7}
                style={{
                  fontFamily: MONO,
                  fontSize: size,
                  fontWeight: 400,
                  letterSpacing: "0.16em",
                  color: C.text,
                  whiteSpace: "nowrap",
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Glow radial baixíssimo que sobe com o ruído — dá volume ao preto sem
          virar bloco de cor. */}
      <AbsoluteFill
        style={{
          pointerEvents: "none",
          background: `radial-gradient(58% 58% at 50% 50%, ${alpha(C.accent, 0.055)}, transparent 70%)`,
          opacity: noise * accentOut,
        }}
      />
    </AbsoluteFill>
  );
};
