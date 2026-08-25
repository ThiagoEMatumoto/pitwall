import { useCurrentFrame, useVideoConfig } from "remotion";
import { C, DISPLAY, MONO, alpha, mix } from "./tokens";
import { IconMic, IconSend, IconSparkle } from "./icons";

// O campo de prompt. O texto é "digitado" por prop (`typed`, 0..1) em vez de
// por timer interno: quem manda no ritmo é a cena, não o componente. O cursor
// pisca em passo de frame (step-end, como o .pw-cursor do app) — nada de
// animação CSS, que o render não amostra de forma determinística.

export type Tone =
  | "accent"
  | "accent2"
  | "warning"
  | "success"
  | "info"
  | "danger";

const TONE: Record<Tone, string> = {
  accent: C.accent,
  accent2: C.accent2,
  warning: C.warning,
  success: C.success,
  info: C.info,
  danger: C.danger,
};

export interface ComposerBadge {
  label: string;
  tone?: Tone;
}

export interface ComposerProps {
  width?: number;
  /** Texto completo; `typed` decide quanto dele já está na tela. */
  text?: string;
  typed?: number;
  placeholder?: string;
  /** Selo à direita da toolbar — usado para o "revisar" do modo supervisão. */
  badge?: ComposerBadge;
  /** Mic ligado: anel pulsando e ícone em accent2. */
  micActive?: boolean;
  model?: string;
  /** 0..1 — halo de foco em accent ao redor do campo. */
  focus?: number;
  /** Esconde o cursor quando a cena não está no campo. */
  caret?: boolean;
}

export const Composer: React.FC<ComposerProps> = ({
  width = 760,
  text = "",
  typed = 1,
  placeholder = "Diga o que precisa — ou segure para falar",
  badge,
  micActive = false,
  model = "Opus 5 · pensar",
  focus = 0,
  caret = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const shown = text.slice(
    0,
    Math.round(Math.max(0, Math.min(1, typed)) * text.length),
  );
  const empty = shown.length === 0;
  const blinkOn = Math.floor(frame / (fps / 2)) % 2 === 0;
  // Enquanto digita, o cursor fica aceso: piscar só quando a mão parou.
  const typing = typed > 0 && typed < 1;
  const caretOn = caret && (typing || blinkOn);

  const f = Math.max(0, Math.min(1, focus));
  // Pulso do mic derivado do frame — 1,2s por ciclo, o mesmo fôlego do pw-pulse.
  const micPhase = (frame % (fps * 1.2)) / (fps * 1.2);
  const micRing = micActive ? 1 + Math.sin(micPhase * Math.PI * 2) * 0.14 : 1;

  return (
    <div
      style={{
        width,
        borderRadius: 16,
        background: C.surface,
        border: `1px solid ${f > 0 ? mix(C.accent, C.border, f * 0.7) : C.border}`,
        boxShadow:
          f > 0
            ? `0 0 0 ${(4 * f).toFixed(1)}px ${alpha(C.accent, 0.1 * f)}`
            : undefined,
        overflow: "hidden",
      }}
    >
      {/* Linha do texto */}
      <div
        style={{
          padding: "18px 20px 14px",
          minHeight: 64,
          fontFamily: DISPLAY,
          fontSize: 18,
          lineHeight: 1.45,
          color: empty ? mix(C.textDim, C.surface, 0.65) : C.text,
          display: "flex",
        }}
      >
        {/* O caret vive DENTRO do span do texto: como filho do flex ele virava
            uma terceira linha sempre que o prompt quebrava. */}
        <span style={{ whiteSpace: "pre-wrap" }}>
          {empty ? placeholder : shown}
          <span
            style={{
              display: "inline-block",
              width: 2,
              height: 20,
              marginLeft: 2,
              verticalAlign: "text-bottom",
              background: C.accent,
              opacity: caretOn ? 1 : 0,
            }}
          />
        </span>
      </div>

      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px 12px",
          borderTop: `1px solid ${mix(C.border, C.surface, 0.6)}`,
        }}
      >
        {/* Mic */}
        <div style={{ position: "relative", width: 36, height: 36 }}>
          {micActive && (
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                border: `1px solid ${alpha(C.accent2, 0.55)}`,
                transform: `scale(${micRing.toFixed(3)})`,
              }}
            />
          )}
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: micActive ? alpha(C.accent2, 0.14) : C.surface2,
              border: `1px solid ${micActive ? alpha(C.accent2, 0.5) : C.border}`,
            }}
          >
            <IconMic
              size={17}
              color={micActive ? C.accent2 : C.textDim}
              strokeWidth={1.8}
            />
          </div>
        </div>

        {/* Modelo */}
        <span
          style={{
            fontFamily: MONO,
            fontSize: 12,
            color: C.textDim,
            padding: "5px 10px",
            borderRadius: 999,
            background: C.surface2,
            border: `1px solid ${C.border}`,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <IconSparkle size={12} color={C.accent} strokeWidth={1.6} />
          {model}
        </span>

        <div style={{ flex: 1 }} />

        {badge && (
          <span
            style={{
              fontFamily: DISPLAY,
              fontWeight: 600,
              fontSize: 12.5,
              letterSpacing: 0.2,
              padding: "5px 12px",
              borderRadius: 999,
              color: TONE[badge.tone ?? "warning"],
              border: `1px solid ${alpha(TONE[badge.tone ?? "warning"], 0.45)}`,
              background: alpha(TONE[badge.tone ?? "warning"], 0.12),
            }}
          >
            {badge.label}
          </span>
        )}

        {/* Enviar */}
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: shown.length > 0 ? C.accent : C.surface2,
            border: `1px solid ${shown.length > 0 ? C.accent : C.border}`,
          }}
        >
          <IconSend
            size={17}
            color={shown.length > 0 ? "#12101B" : C.textDim}
            strokeWidth={2.2}
          />
        </div>
      </div>
    </div>
  );
};
