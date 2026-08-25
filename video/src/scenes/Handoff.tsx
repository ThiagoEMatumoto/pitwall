import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import script from "../../content/script.json";
import type { Locale } from "../config";
import { BlurIn, DrawPath, springAt } from "../motion";
import { ApexDot, C, MONO, SessionCard, alpha, type CrewMode } from "../ui";

// A cena do despacho — a mais longa do filme, e a que carrega o argumento.
// A dramaturgia é a narração, frase por frase; nada entra fora do seu beat:
//
//   1. "precisa de trabalho em outro repositório?"  o nó-mãe acende; três
//      endereços vazios aparecem à direita — os lugares ainda sem ninguém.
//   2. "a sessão despacha uma filha"                UMA filha: um feixe, um card.
//   3. "nasce com um apelido — o endereço dela"     o traço accent sob o apelido.
//   4. "e um modo: investigar, editar, ou operar"   cada palavra traz a sua filha.
//   5. "reporta o progresso"                        pulso azul volta; a barra anda.
//   6. "pergunta quando trava"                      pulso âmbar; a barra congela.
//   7. "avisa quando termina"                       pulso verde; 100%.
//
// Os três estados de retorno chegam em momentos DIFERENTES — é o que faz a cena
// avançar em vez de ficar parada esperando as barras rastejarem.
//
// A legenda dos modos não usa cor pra hierarquia (ciano+roxo+laranja no mesmo
// frame é proibido): o modo ativo cresce e clareia, os outros ficam em cinza.

type Cubic = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

const cubicD = (c: Cubic) =>
  `M ${c[0][0]} ${c[0][1]} C ${c[1][0]} ${c[1][1]}, ${c[2][0]} ${c[2][1]}, ${c[3][0]} ${c[3][1]}`;

const cubicAt = (c: Cubic, t: number): [number, number] => {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [
    w[0] * c[0][0] + w[1] * c[1][0] + w[2] * c[2][0] + w[3] * c[3][0],
    w[0] * c[0][1] + w[1] * c[1][1] + w[2] * c[2][1] + w[3] * c[3][1],
  ];
};

/** O nó-mãe puxado pra esquerda: ele é quem ocupa a metade vazia do quadro. */
const MOTHER_X = 336;
const MOTHER_Y = 540;
const AURA = 420;
const CORE = 88;
const BEAM_ORIGIN_X = MOTHER_X + 58;

const CARD_X = 1120;
const CARD_W = 396;
/** O card é do app; em 1080p ele precisa crescer pra o apelido ser legível. */
const CARD_SCALE = 1.24;
const CHILD_Y = [252, 540, 828];

const beamOf = (cy: number): Cubic => [
  [BEAM_ORIGIN_X, MOTHER_Y],
  [620, MOTHER_Y],
  [830, cy],
  [CARD_X - 18, cy],
];

const CHILDREN: { mode: CrewMode }[] = [
  { mode: "investigar" },
  { mode: "editar" },
  { mode: "operar" },
];

/**
 * Marcas da cena em fração da duração. Vieram da medida das frases nos dois
 * locales (pt-BR 17,9s / en 19,0s) — as proporções batem dentro de 2%, então
 * uma tabela só serve os dois.
 */
const BEAT = {
  mother: 0.012,
  slot: [0.035, 0.065, 0.095],
  /** frase 2 traz a primeira; frases do modo (4) trazem a segunda e a terceira */
  dispatch: [0.175, 0.525, 0.595],
  address: [0.29, 0.365, 0.44, 0.49],
  mode: [0.5, 0.565, 0.635],
  /** reporta / pergunta / conclui */
  ret: [0.7, 0.785, 0.875],
} as const;

export const Handoff: React.FC<{
  durationInFrames: number;
  locale: Locale;
}> = ({ durationInFrames, locale }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const D = durationInFrames;
  const at = (fraction: number) => Math.round(fraction * D);
  const clamp = {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  } as const;

  const onScreen = script.scenes.find((s) => s.id === "handoff")!.onScreen[
    locale
  ];
  const aliases = onScreen.slice(0, 3);
  const modes = (onScreen[3] ?? "").split("·").map((token) => token.trim());

  /** Frames que o pulso leva do card até o nó-mãe. */
  const travel = Math.round(D * 0.032);

  const motherIn = springAt(frame, fps, {
    preset: "entrada",
    delay: at(BEAT.mother),
  });

  // O accent entra no momento do valor (o apelido é o endereço) e sai bem antes
  // do corte — nunca junto com ele.
  const address = interpolate(
    frame,
    [
      at(BEAT.address[0]),
      at(BEAT.address[1]),
      at(BEAT.address[2]),
      at(BEAT.address[3]),
    ],
    [0, 1, 1, 0],
    clamp,
  );

  // ── Retornos: eventos discretos, um por frase. Nada de loop rastejando. ──
  const retEvents = [
    { i: 0, start: at(BEAT.ret[0]), color: C.info },
    { i: 0, start: at(BEAT.ret[0]) + Math.round(travel * 0.9), color: C.info },
    { i: 1, start: at(BEAT.ret[1]), color: C.warning },
    { i: 2, start: at(BEAT.ret[2]), color: C.success },
  ];

  const landOf = (start: number) =>
    interpolate(
      frame,
      [start + travel - 3, start + travel + 2, start + travel + 13],
      [0, 1, 0],
      clamp,
    );

  const waiting = frame >= at(BEAT.ret[1]) + travel;
  const done = frame >= at(BEAT.ret[2]) + travel;

  const progressOf = (i: number) => {
    const enter = at(BEAT.dispatch[i]) + Math.round(D * 0.05);
    if (i === 0) {
      return interpolate(
        frame,
        [enter, at(0.36), at(0.7), at(0.79)],
        [0.12, 0.26, 0.26, 0.68],
        clamp,
      );
    }
    if (i === 1) {
      // Ela trava: a barra para exatamente quando o âmbar chega.
      return interpolate(frame, [enter, at(0.815)], [0.1, 0.44], clamp);
    }
    return interpolate(
      frame,
      [enter, at(0.86), at(0.905), at(0.928)],
      [0.12, 0.64, 0.64, 1],
      clamp,
    );
  };

  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      {/* ── Feixes, pulsos e anéis do nó-mãe ───────────────────────────── */}
      <AbsoluteFill>
        <svg
          width={1920}
          height={1080}
          viewBox="0 0 1920 1080"
          style={{ display: "block" }}
        >
          {CHILD_Y.map((cy, i) => {
            const beam = beamOf(cy);
            const start = at(BEAT.dispatch[i]);
            const draw = springAt(frame, fps, {
              preset: "assentar",
              delay: start,
              durationInFrames: Math.round(D * 0.055),
            });
            // O único traço accent do despacho vai no primeiro feixe — o da
            // frase "a sessão despacha uma filha". Os outros dois entram
            // neutros: o destaque daquele beat é a palavra do modo.
            const hot =
              i === 0
                ? interpolate(
                    frame,
                    [start, start + 8, start + Math.round(D * 0.07)],
                    [0.85, 1, 0],
                    clamp,
                  )
                : 0;
            return (
              <g key={cy}>
                <DrawPath
                  d={cubicD(beam)}
                  progress={draw}
                  stroke={alpha(C.text, 0.13)}
                  strokeWidth={1.5}
                />
                {hot > 0.01 ? (
                  <DrawPath
                    d={cubicD(beam)}
                    progress={draw}
                    stroke={alpha(C.accent, 0.5 * hot)}
                    strokeWidth={1.5}
                  />
                ) : null}
              </g>
            );
          })}

          {/* Anel de emissão: um por despacho, expandindo do nó-mãe. */}
          {BEAT.dispatch.map((f, i) => {
            const start = at(f);
            const t = interpolate(frame, [start, start + 22], [0, 1], clamp);
            if (t <= 0 || t >= 1) return null;
            return (
              <circle
                key={`emit-${i}`}
                cx={MOTHER_X}
                cy={MOTHER_Y}
                r={CORE / 2 + t * 108}
                fill="none"
                stroke={alpha(C.text, 0.2 * (1 - t))}
                strokeWidth={1}
              />
            );
          })}

          {/* ── Retornos: o pulso volta pelo mesmo fio ──────────────────── */}
          {retEvents.map((ev, k) => {
            const t = (frame - ev.start) / travel;
            const land = landOf(ev.start);
            if (t < 0 || (t > 1 && land < 0.01)) return null;
            const beam = beamOf(CHILD_Y[ev.i]);
            const clamped = Math.max(0, Math.min(1, t));
            const [px, py] = cubicAt(beam, 1 - clamped);
            const trail = cubicAt(beam, Math.min(1, 1 - clamped + 0.075));
            const fade = t > 1 ? 0 : Math.sin(Math.PI * Math.min(1, t * 1.15));
            const arrowY = MOTHER_Y + (CHILD_Y[ev.i] - MOTHER_Y) * 0.02;
            return (
              <g key={`ret-${k}`}>
                {fade > 0.01 ? (
                  <>
                    <line
                      x1={trail[0]}
                      y1={trail[1]}
                      x2={px}
                      y2={py}
                      stroke={ev.color}
                      strokeWidth={2}
                      strokeLinecap="round"
                      opacity={0.55 * fade}
                    />
                    <circle
                      cx={px}
                      cy={py}
                      r={3.4}
                      fill={ev.color}
                      opacity={fade}
                    />
                  </>
                ) : null}
                {land > 0.01 ? (
                  <>
                    {/* A seta que recebe, na borda do nó-mãe. */}
                    <path
                      d={`M ${BEAM_ORIGIN_X + 18} ${arrowY - 9} l -12 9 l 12 9`}
                      fill="none"
                      stroke={ev.color}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={land}
                    />
                    {/* E o anel que se fecha: a mãe recebeu. */}
                    <circle
                      cx={MOTHER_X}
                      cy={MOTHER_Y}
                      r={CORE / 2 + (1 - land) * 76}
                      fill="none"
                      stroke={alpha(ev.color, 0.35 * land)}
                      strokeWidth={1}
                    />
                  </>
                ) : null}
              </g>
            );
          })}
        </svg>
      </AbsoluteFill>

      {/* ── Nó-mãe ─────────────────────────────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          left: MOTHER_X - AURA / 2,
          top: MOTHER_Y - AURA / 2,
          width: AURA,
          height: AURA,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${alpha(C.accent, 0.15)}, transparent 68%)`,
          opacity: motherIn,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: MOTHER_X - CORE / 2,
          top: MOTHER_Y - CORE / 2,
          width: CORE,
          height: CORE,
          borderRadius: "50%",
          border: `1px solid ${alpha(C.accent, 0.22)}`,
          opacity: motherIn,
          transform: `scale(${(0.86 + 0.14 * motherIn).toFixed(3)})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: MOTHER_X - 17,
          top: MOTHER_Y - 17,
          width: 34,
          height: 34,
          opacity: motherIn,
        }}
      >
        <ApexDot size={34} />
      </div>

      {/* ── Legenda dos modos: hierarquia por escala e peso, nunca por cor ─ */}
      <div
        style={{
          position: "absolute",
          left: MOTHER_X - 260,
          top: MOTHER_Y + 150,
          width: 520,
          textAlign: "center",
          fontFamily: MONO,
          fontSize: 15,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {modes.map((token, i) => {
          const start = at(BEAT.mode[i]);
          const present = interpolate(
            frame,
            [start, start + Math.round(D * 0.02)],
            [0, 1],
            clamp,
          );
          const lit =
            present *
            interpolate(
              frame,
              [start + Math.round(D * 0.05), start + Math.round(D * 0.085)],
              [1, 0],
              clamp,
            );
          return (
            <span key={token}>
              {i > 0 ? (
                <span
                  style={{
                    color: alpha(C.textDim, 0.3 * present),
                  }}
                >
                  {" · "}
                </span>
              ) : null}
              <span
                style={{
                  display: "inline-block",
                  color: C.text,
                  opacity: (0.34 + 0.66 * lit) * present,
                  transform: `scale(${(1 + 0.18 * lit).toFixed(3)})`,
                }}
              >
                {token}
              </span>
            </span>
          );
        })}
      </div>

      {/* ── Filhas ─────────────────────────────────────────────────────── */}
      {aliases.map((alias, i) => {
        // A filha materializa quando o feixe CHEGA, não junto com ele.
        const enter = at(BEAT.dispatch[i]) + Math.round(D * 0.05);
        const slotIn = springAt(frame, fps, {
          preset: "entrada",
          delay: at(BEAT.slot[i]),
        });

        return (
          // A escala vive FORA do BlurIn: a primitiva já usa `transform` e o
          // style que ela recebe sobrescreveria a animação inteira.
          <div
            key={alias}
            style={{
              position: "absolute",
              left: CARD_X,
              top: CHILD_Y[i] - 58,
              width: CARD_W,
              transform: `scale(${CARD_SCALE})`,
              transformOrigin: "left center",
            }}
          >
            {/* O endereço existe antes da filha: o lugar vazio é o que a
                primeira frase mostra, e é ele que a filha vem preencher. */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 14,
                background: C.surface,
                border: `1px solid ${C.border}`,
                opacity: 0.9 * slotIn,
              }}
            />
            <BlurIn delay={enter} blur={12} scale={0.965} y={16}>
              <SessionCard
                width={CARD_W}
                alias={alias}
                mode={CHILDREN[i].mode}
                modeLabel={modes[i]}
                aliasUnderline={i === 0 ? address : 0}
                state={
                  i === 2 && done
                    ? "done"
                    : i === 1 && waiting
                      ? "waiting"
                      : "working"
                }
                progress={progressOf(i)}
                note=""
              />
            </BlurIn>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
