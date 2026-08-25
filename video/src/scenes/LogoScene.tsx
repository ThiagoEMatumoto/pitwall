import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import scriptJson from "../../content/script.json";
import type { Locale } from "../config";
import { KineticHeadline, springAt } from "../motion";
import { C, alpha } from "../ui";
// Logo não passa pelo barrel de ui/: é o único componente com progresso por
// peça, e só a cena de marca o usa.
import { Logo } from "../ui/Logo";

// Cena 2 — marca. Depois do caos, silêncio. É a cena mais parada do filme:
// quatro gestos em sequência (barra, barra, círculo, gradiente), o wordmark
// ganhando peso, e então nada. O que ela vende é a pausa.

const SCENE = scriptJson.scenes.find((s) => s.id === "logo") as unknown as {
  onScreen: Record<Locale, string[]>;
};

const EASE_MOVE = Easing.bezier(0.2, 0, 0, 1);
const EASE_OUT = Easing.bezier(0.3, 0, 0.8, 0.15);

// O viewBox do logo é 44×44 mas a marca ocupa só a faixa central (barras em
// y 19.5..24.5, ápice r=3.4): a caixa do svg é ~5× mais alta que o desenho. Por
// isso o `size` é grande e a caixa que o envolve é curta — senão a marca sai
// minúscula ao lado do wordmark e o "gap" vira um buraco de 180px.
const MARK_SIZE = 560;
const MARK_BAND = Math.round(MARK_SIZE * 0.2);
const WORD_SIZE = 104;

// gradientProgress 0 = ápice todo roxo; 0.5 = a banda ciano→roxo da marca.
// Passar de 0.5 levaria o ápice a ciano chapado — e ciano é evento raro no
// filme, não estado final.
const GRADIENT_TARGET = 0.5;

export const LogoScene: React.FC<{
  durationInFrames: number;
  locale: Locale;
}> = ({ durationInFrames, locale }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const wordmark = SCENE.onScreen[locale][0];

  // As barras crescem da borda externa pro centro, uma atrás da outra.
  const leftBar = springAt(frame, fps, {
    preset: "entrada",
    delay: 2,
    durationInFrames: 22,
  });
  const rightBar = springAt(frame, fps, {
    preset: "entrada",
    delay: 7,
    durationInFrames: 22,
  });
  // O círculo ASSENTA: damping alto, chega e para. Ápice não quica.
  const circle = springAt(frame, fps, {
    preset: "assentar",
    delay: 16,
    durationInFrames: 26,
  });

  const gradient = interpolate(frame, [28, 56], [0, GRADIENT_TARGET], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_MOVE,
  });

  // O halo é o único accent vivo aqui — sobe, respira o hold, e sai antes do
  // corte (nunca junto com ele).
  const glowIn = interpolate(frame, [30, 58], [0, 0.55], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_MOVE,
  });
  const glowOut = interpolate(
    frame,
    [durationInFrames - 26, durationInFrames - 10],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE_OUT,
    },
  );
  const glow = glowIn * glowOut;

  return (
    <AbsoluteFill
      style={{
        background: C.bg,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 40,
          // Centro óptico um fio acima do geométrico: o wordmark pesa embaixo.
          transform: "translateY(-26px)",
        }}
      >
        {/* Caixa curta com o svg transbordando em cima e embaixo: a faixa vazia
            do viewBox deixa de contar pro layout, e o gap volta a ser gap. */}
        <div
          style={{
            height: MARK_BAND,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Logo
            size={MARK_SIZE}
            leftBarProgress={leftBar}
            rightBarProgress={rightBar}
            circleScale={circle}
            circleOpacity={circle}
            gradientProgress={gradient}
            glow={glow}
            style={{ flexShrink: 0 }}
          />
        </div>

        <KineticHeadline
          delay={24}
          preset="assentar"
          fontSize={WORD_SIZE}
          color={C.text}
          trackingFrom={0.5}
          trackingTo={0.11}
          weightFrom={500}
          weightTo={800}
        >
          {wordmark}
        </KineticHeadline>
      </div>

      {/* Halo radial atrás do ápice, no mesmo ciclo do glow. Fica em 6% — accent
          nunca em bloco. */}
      <AbsoluteFill
        style={{
          pointerEvents: "none",
          background: `radial-gradient(30% 30% at 50% 44%, ${alpha(C.accent, 0.09)}, transparent 70%)`,
          opacity: glow,
        }}
      />
    </AbsoluteFill>
  );
};
