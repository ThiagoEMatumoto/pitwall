import { useCurrentFrame, useVideoConfig } from "remotion";
import { C, GRADIENT_BRAND, alpha } from "./tokens";

// "O Ápice": dot com o gradiente da marca e um anel que expande e some. Regra
// da casa: UM por vista — é o único elemento autorizado a pulsar, e por isso
// aponta para onde você deve olhar. Aqui o ciclo vem do frame (2,4s, igual ao
// pw-ring/pw-pulse do app), não de CSS.

export interface ApexDotProps {
  size?: number;
  /** Sem anel nem pulso — o dot estático. */
  active?: boolean;
  /** Sobrescreve o gradiente por uma cor chapada (ex.: âmbar de "esperando"). */
  color?: string;
  /** Desloca a fase do ciclo, para dois ápices não baterem juntos. */
  phase?: number;
}

export const ApexDot: React.FC<ApexDotProps> = ({
  size = 12,
  active = true,
  color,
  phase = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const period = fps * 2.4;
  const t = (((frame / period + phase) % 1) + 1) % 1;

  const ringScale = 1 + t * 1.5;
  const ringOpacity = 0.5 * (1 - t);
  const pulse = 1 + Math.sin(t * Math.PI * 2) * 0.06;
  const ringColor = color ?? C.accent;

  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        width: size,
        height: size,
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    >
      {active && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: `1px solid ${alpha(ringColor, 1)}`,
            transform: `scale(${ringScale.toFixed(3)})`,
            opacity: ringOpacity,
          }}
        />
      )}
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: color ?? GRADIENT_BRAND,
          transform: active ? `scale(${pulse.toFixed(3)})` : undefined,
        }}
      />
    </span>
  );
};
