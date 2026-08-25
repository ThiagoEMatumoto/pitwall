import {
  AbsoluteFill,
  Easing,
  interpolate,
  interpolateColors,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import script from "../../content/script.json";
import type { Locale } from "../config";
import { StaggerText, springAt } from "../motion";
import { C, Composer, MONO, SummaryChip, alpha, mix } from "../ui";
import { IconMic } from "../ui/icons";

// A cena da voz. O corte da cena é a waveform virando texto: as mesmas barras
// que desenhavam a voz viajam até a linha de texto do composer, achatam num
// traço de 2px e entregam o lugar ao prompt digitado. É por isso que a onda
// mora exatamente sobre a coluna do texto — se ela estivesse em outra caixa,
// seria dissolve, não match cut.

const scene = script.scenes.find((s) => s.id === "voice")!;

const EASE_ENTER = Easing.bezier(0.05, 0.7, 0.1, 1);
const EASE_EXIT = Easing.bezier(0.3, 0, 0.8, 0.15);
const EASE_MOVE = Easing.bezier(0.2, 0, 0, 1);

/** Frames parados antes do corte. */
const HOLD = 30;
/** Régua em que os beats abaixo foram escritos; o locale estica ou comprime. */
const SPAN = 400;

const COMPOSER_W = 880;
const COMPOSER_X = (1920 - COMPOSER_W) / 2;
const COMPOSER_Y = 560;
// padding 20 à esquerda; primeira linha de 18px/1.45 dentro do padding-top 18.
const TEXT_X = COMPOSER_X + 20;
const TEXT_Y = COMPOSER_Y + 31;

const BARS = 34;
const WAVE_STEP = 21;
const WAVE_Y = 452;
const WAVE_X = 668;
const TEXT_STEP = 6;
const BAR_MAX = 88;
/** Mic grande: alinhado na coluna do mic do composer, nao no centro do quadro. */
const MIC_X = 560;
const MIC_Y = 452;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Envelope de fala: janela em sino nas bordas (a onda tem começo e fim), duas
 * senóides de fase diferente pra não virar padrão visível, e uma respiração
 * lenta por cima — é ela que faz a barra parecer voz e não equalizador de rádio.
 */
const barAmp = (i: number, f: number) => {
  const window = Math.pow(Math.sin((Math.PI * (i + 0.5)) / BARS), 0.55);
  const wave =
    0.62 * Math.sin(f * 0.34 + i * 0.55) +
    0.38 * Math.sin(f * 0.21 + i * 0.9 + 1.7);
  const breath = 0.55 + 0.45 * Math.abs(Math.sin(f * 0.06));
  return window * breath * (0.16 + 0.84 * Math.pow(Math.abs(wave), 1.25));
};

/** Última frase da narração — é o que o chip de resumo mostra em tela. */
const lastSentence = (text: string): string => {
  const i = text.lastIndexOf(". ");
  return i < 0 ? text : text.slice(i + 2);
};

export const Voice: React.FC<{ durationInFrames: number; locale: Locale }> = ({
  durationInFrames,
  locale,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const onScreen = scene.onScreen[locale];
  const [eyebrowText, promptText, reviewText] = onScreen;
  const summaryText = lastSentence(scene.narration[locale]);

  // Beats escritos em SPAN frames; S estica pro tamanho real da narração e
  // garante que o último movimento acaba exatamente HOLD frames antes do corte.
  const s = (durationInFrames - HOLD) / SPAN;
  const at = (a: number, b: number, easing = EASE_ENTER) =>
    interpolate(frame, [a * s, b * s], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing,
    });

  const enter = at(2, 20);
  const micIn = at(10, 30);
  const micOut = at(150, 168, EASE_EXIT);
  const collapse = at(150, 188, EASE_MOVE);
  const typed = at(176, 218);
  const focusUp = at(150, 200);
  const focusDown = at(356, 396, EASE_EXIT);
  const chipRise = clamp01(
    springAt(frame - 300 * s, fps, { preset: "entrada" }),
  );

  const badgeOn = frame >= 226 * s;
  const badgeBeat =
    Math.sin(clamp01(at(226, 244, EASE_MOVE)) * Math.PI) * 0.012;
  // O caret é accent e pisca: sai de cena antes do hold, junto com o halo.
  const caretOn = frame < 330 * s;
  const focus = clamp01(focusUp) * (1 - clamp01(focusDown));

  const micScale =
    lerp(0.9, 1, clamp01(micIn)) * lerp(1, 0.86, clamp01(micOut));
  const micAlpha = clamp01(micIn) * (1 - clamp01(micOut));
  const recording = collapse < 0.02 && micAlpha > 0.2;

  const ringPeriod = fps * 1.6;
  const rings = [0, 0.5].map((phase) => {
    const t = (((frame / ringPeriod + phase) % 1) + 1) % 1;
    return { scale: 1 + t * 1.35, opacity: 0.42 * (1 - t) * micAlpha };
  });

  // A cor só chega quando a onda vira texto: até lá o quadro é grayscale.
  // interpolateColors (e nao mix) porque inkA ja e rgb(): mix() so le hex e
  // devolveria rgb(NaN,...), que a SVG descarta silenciosamente.
  const inkA = mix(C.text, C.bg, 0.52);
  const barColor = interpolateColors(
    clamp01((collapse - 0.5) / 0.35),
    [0, 1],
    [inkA, C.accent],
  );
  const barFade = 1 - clamp01((collapse - 0.72) / 0.28);

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {/* Eyebrow */}
      <div
        style={{
          position: "absolute",
          top: 340,
          left: 0,
          width: 1920,
          textAlign: "center",
          fontFamily: MONO,
          fontSize: 15,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: mix(C.textDim, C.bg, 0.8),
        }}
      >
        <StaggerText
          text={eyebrowText}
          by="char"
          stagger={1}
          delay={6 * s}
          y={12}
          blur={5}
        />
      </div>

      {/* Mic + anéis */}
      <div
        style={{
          position: "absolute",
          left: MIC_X - 60,
          top: MIC_Y - 60,
          width: 120,
          height: 120,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: micAlpha,
          transform: `scale(${micScale.toFixed(4)})`,
        }}
      >
        {rings.map((ring, i) => (
          <span
            key={i}
            style={{
              position: "absolute",
              left: 18,
              top: 18,
              width: 84,
              height: 84,
              borderRadius: "50%",
              border: `1px solid ${alpha(C.text, 0.5)}`,
              transform: `scale(${ring.scale.toFixed(3)})`,
              opacity: ring.opacity,
            }}
          />
        ))}
        <span
          style={{
            width: 84,
            height: 84,
            borderRadius: "50%",
            background: C.surface,
            border: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <IconMic size={34} color={C.text} strokeWidth={1.6} />
        </span>
      </div>

      {/* Waveform → linha de texto */}
      <svg
        width={1920}
        height={1080}
        viewBox="0 0 1920 1080"
        style={{ position: "absolute", inset: 0 }}
        fill="none"
      >
        {Array.from({ length: BARS }, (_, i) => {
          const h = Math.max(4, barAmp(i, frame) * BAR_MAX) * clamp01(micIn);
          const height = lerp(h, 2.5, collapse);
          const x = lerp(
            WAVE_X + i * WAVE_STEP,
            TEXT_X + i * TEXT_STEP,
            collapse,
          );
          const y = lerp(WAVE_Y, TEXT_Y, collapse);
          const w = lerp(5, 3, collapse);
          return (
            <rect
              key={i}
              x={x - w / 2}
              y={y - height / 2}
              width={w}
              height={height}
              rx={w / 2}
              fill={barColor}
              opacity={barFade * clamp01(enter)}
            />
          );
        })}
      </svg>

      {/* Chip de resumo: encosta o rodapé dele logo acima do composer. */}
      <div
        style={{
          position: "absolute",
          left: COMPOSER_X,
          top: 0,
          width: COMPOSER_W,
          height: COMPOSER_Y - 16,
          display: "flex",
          alignItems: "flex-end",
          pointerEvents: "none",
        }}
      >
        {chipRise > 0.001 && (
          <SummaryChip
            width={720}
            label="pitwall"
            text={summaryText}
            rise={chipRise}
            accent={mix(C.textDim, C.bg, 0.9)}
            apex={false}
          />
        )}
      </div>

      {/* Composer */}
      <div
        style={{
          position: "absolute",
          left: COMPOSER_X,
          top: COMPOSER_Y,
          opacity: clamp01(enter),
          transform: `translateY(${((1 - clamp01(enter)) * 14).toFixed(2)}px) scale(${(1 + badgeBeat).toFixed(4)})`,
        }}
      >
        <Composer
          width={COMPOSER_W}
          text={promptText}
          typed={clamp01(typed)}
          placeholder=""
          micActive={recording}
          badge={badgeOn ? { label: reviewText, tone: "warning" } : undefined}
          model="Opus 5"
          focus={focus}
          caret={caretOn}
        />
      </div>
    </AbsoluteFill>
  );
};
