import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import script from "../../content/script.json";
import type { Locale } from "../config";
import { BlurIn, KineticHeadline, springAt } from "../motion";
import { C, DISPLAY, MONO } from "../ui";
import { Logo } from "../ui/Logo";

// O fecho. Tudo o que sobrou em tela recolhe para o Ápice no centro — match
// cut de forma com a cena da marca: o mesmo elemento que abriu o filme fecha.
// Depois do wordmark, a vinheta fecha e o quadro termina em preto de verdade,
// com folga suficiente pro vídeo não cortar seco no último frame.

/** Fragmentos que vêm das cenas anteriores e colapsam no centro. */
const SHARDS: { x: number; y: number; w: number; h: number }[] = [
  { x: -620, y: -250, w: 132, h: 9 },
  { x: 560, y: -300, w: 96, h: 9 },
  { x: -680, y: 200, w: 108, h: 9 },
  { x: 610, y: 210, w: 150, h: 9 },
  { x: -80, y: -390, w: 74, h: 9 },
  { x: 200, y: 380, w: 118, h: 9 },
];

export const Outro: React.FC<{ durationInFrames: number; locale: Locale }> = ({
  durationInFrames,
  locale,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const D = durationInFrames;
  const at = (fraction: number) => Math.round(fraction * D);

  const scene = script.scenes.find((s) => s.id === "outro")!;
  const [wordmark, url] = scene.onScreen[locale];
  const narration = scene.narration[locale];
  // A tagline é a narração sem o nome da marca — que já está no wordmark.
  const tagline = narration.slice(narration.indexOf(". ") + 2);

  // Últimos frames em preto: a cauda de silêncio do manifesto, não um corte.
  const blackFrom = D - 15;
  const fadeFrom = blackFrom - 12;

  const collapse = springAt(frame, fps, {
    preset: "assentar",
    durationInFrames: at(0.24),
  });
  const apex = springAt(frame, fps, { preset: "impacto", delay: at(0.1) });
  const bars = springAt(frame, fps, { preset: "entrada", delay: at(0.16) });

  const exit = interpolate(frame, [fadeFrom, blackFrom], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      {/* Recolhimento: cada fragmento anda até o centro e apaga ao chegar. */}
      {SHARDS.map((shard, i) => {
        const p = springAt(frame, fps, {
          preset: "assentar",
          delay: i * 2,
          durationInFrames: at(0.26),
        });
        if (p > 0.995) return null;
        return (
          <div
            key={`${shard.x}-${shard.y}`}
            style={{
              position: "absolute",
              left: 960 - shard.w / 2,
              top: 420 - shard.h / 2,
              width: shard.w,
              height: shard.h,
              borderRadius: 5,
              background: C.textDim,
              opacity: 0.5 * (1 - p) * (1 - collapse * 0.2),
              transform: `translate(${(shard.x * (1 - p)).toFixed(1)}px, ${(
                shard.y *
                (1 - p)
              ).toFixed(1)}px) scale(${(0.25 + 0.75 * (1 - p)).toFixed(3)})`,
            }}
          />
        );
      })}

      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          opacity: 1 - exit,
          transform: `scale(${(1 + 0.012 * exit).toFixed(4)})`,
        }}
      >
        <Logo
          size={150}
          leftBarProgress={bars}
          rightBarProgress={bars}
          circleScale={0.2 + 0.8 * apex}
          circleOpacity={apex}
          // Assenta no gradiente da marca (ciano→roxo), não no ciano puro: é
          // o Ápice que fecha o filme, não um ponto azul.
          gradientProgress={interpolate(apex, [0, 1], [1, 0.5])}
          glow={0.5 * apex}
        />

        <div style={{ height: 30 }} />

        <KineticHeadline
          delay={at(0.28)}
          fontSize={82}
          color={C.text}
          trackingFrom={0.42}
          trackingTo={0.16}
          weightFrom={500}
          weightTo={800}
          style={{ textAlign: "center" }}
        >
          {wordmark}
        </KineticHeadline>

        <div style={{ height: 22 }} />

        <BlurIn delay={at(0.44)} blur={10} scale={0.985} y={10}>
          <div
            style={{
              fontFamily: DISPLAY,
              fontWeight: 400,
              fontSize: 27,
              lineHeight: 1.35,
              letterSpacing: "0.005em",
              color: C.textDim,
              textAlign: "center",
              maxWidth: 900,
            }}
          >
            {tagline}
          </div>
        </BlurIn>

        <div style={{ height: 26 }} />

        <BlurIn delay={at(0.58)} blur={8} scale={0.99} y={8}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 17,
              letterSpacing: "0.06em",
              color: C.textDim,
              opacity: 0.75,
            }}
          >
            {url}
          </div>
        </BlurIn>
      </AbsoluteFill>

      <AbsoluteFill style={{ backgroundColor: "#000000", opacity: exit }} />
    </AbsoluteFill>
  );
};
