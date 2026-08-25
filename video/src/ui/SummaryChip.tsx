import { C, DISPLAY, MONO, alpha, mix } from "./tokens";
import { ApexDot } from "./ApexDot";

// O chip de resumo que sobe acima do composer quando uma sessão termina de
// falar: o Ápice à esquerda, o rótulo do que aconteceu em mono, e uma frase.
// `rise` é o mesmo gesto do .pw-rise do app (10px + opacity), só que dirigido
// pela cena.

export interface SummaryChipProps {
  width?: number;
  /** Rótulo curto em mono, caixa alta (ex.: "otavio-auth · reportou"). */
  label: string;
  /** A frase do resumo. */
  text: string;
  /** Meta discreto à direita (ex.: "há 40s"). */
  meta?: string;
  /** 0..1 — sobe 10px e aparece. */
  rise?: number;
  /** Cor do Ápice; sem ela, o gradiente da marca. */
  accent?: string;
  apex?: boolean;
}

export const SummaryChip: React.FC<SummaryChipProps> = ({
  width = 700,
  label,
  text,
  meta,
  rise = 1,
  accent,
  apex = true,
}) => {
  const p = Math.max(0, Math.min(1, rise));

  return (
    <div
      style={{
        width,
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "14px 18px",
        borderRadius: 14,
        background: C.surface2,
        border: `1px solid ${mix(C.border, C.surface2, 0.9)}`,
        boxShadow: `0 12px 32px -18px rgba(0,0,0,0.9), inset 0 1px 0 ${alpha(C.text, 0.03)}`,
        opacity: p,
        transform: `translateY(${((1 - p) * 10).toFixed(2)}px)`,
      }}
    >
      <span style={{ paddingTop: 5 }}>
        <ApexDot size={11} active={apex} color={accent} />
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 11.5,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: accent ?? C.accent2,
            marginBottom: 5,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontFamily: DISPLAY,
            fontSize: 16,
            lineHeight: 1.45,
            color: C.text,
          }}
        >
          {text}
        </div>
      </div>

      {meta && (
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11.5,
            color: mix(C.textDim, C.surface2, 0.75),
            paddingTop: 3,
            whiteSpace: "nowrap",
          }}
        >
          {meta}
        </span>
      )}
    </div>
  );
};
