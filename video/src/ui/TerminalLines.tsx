import { useCurrentFrame, useVideoConfig } from "remotion";
import { C, MONO, mix } from "./tokens";

// Linhas de terminal em JetBrains Mono, digitadas caractere a caractere. O
// `typed` corre sobre o texto INTEIRO (todas as linhas somadas), então uma
// única prop dirige a cena de abertura do começo ao fim — e o cursor sempre
// para onde a digitação parou.

export type LineTone =
  | "command"
  | "output"
  | "dim"
  | "accent"
  | "success"
  | "warning"
  | "danger";

const LINE_COLOR: Record<LineTone, string> = {
  command: C.text,
  output: C.textDim,
  dim: mix(C.textDim, C.bg, 0.6),
  accent: C.accent,
  success: C.success,
  warning: C.warning,
  danger: C.danger,
};

export interface TermLine {
  text: string;
  tone?: LineTone;
  /** Prefixo colado à esquerda, fora da cor da linha (ex.: "❯"). */
  prefix?: string;
}

export interface TerminalLinesProps {
  width?: number;
  lines: TermLine[];
  /** 0..1 sobre o total de caracteres. */
  typed?: number;
  fontSize?: number;
  cursor?: boolean;
  /** Moldura de terminal (fundo, borda, respiro). */
  framed?: boolean;
}

export const TerminalLines: React.FC<TerminalLinesProps> = ({
  width = 720,
  lines,
  typed = 1,
  fontSize = 15,
  cursor = true,
  framed = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const total = lines.reduce((acc, l) => acc + l.text.length, 0);
  let budget = Math.round(Math.max(0, Math.min(1, typed)) * total);

  const rendered = lines.map((l) => {
    const take = Math.max(0, Math.min(l.text.length, budget));
    budget -= take;
    return { line: l, take };
  });

  // Última linha com algo escrito — é lá que o cursor mora.
  let cursorAt = -1;
  for (let i = rendered.length - 1; i >= 0; i--) {
    if (rendered[i].take > 0) {
      cursorAt = i;
      break;
    }
  }
  if (cursorAt === -1 && rendered.length > 0) cursorAt = 0;

  const typing = typed > 0 && typed < 1;
  const blinkOn = Math.floor(frame / (fps / 2)) % 2 === 0;
  const caretOn = cursor && (typing || blinkOn);

  return (
    <div
      style={{
        width,
        fontFamily: MONO,
        fontSize,
        lineHeight: 1.65,
        padding: framed ? "20px 22px" : 0,
        borderRadius: framed ? 12 : 0,
        background: framed ? C.surface : "transparent",
        border: framed ? `1px solid ${C.border}` : undefined,
      }}
    >
      {rendered.map(({ line, take }, i) => {
        // Linha ainda não alcançada: some, mas guarda a altura — nada pula.
        const started = take > 0 || (i === 0 && total === 0);
        return (
          <div
            key={i}
            style={{
              whiteSpace: "pre-wrap",
              color: LINE_COLOR[line.tone ?? "output"],
              opacity: started ? 1 : 0,
              minHeight: fontSize * 1.65,
            }}
          >
            {line.prefix && (
              <span style={{ color: C.accent2, marginRight: 8 }}>
                {line.prefix}
              </span>
            )}
            {line.text.slice(0, take)}
            {i === cursorAt && (
              <span
                style={{
                  display: "inline-block",
                  width: fontSize * 0.55,
                  height: fontSize * 1.1,
                  marginLeft: 1,
                  transform: "translateY(2px)",
                  background: C.accent2,
                  opacity: caretOn ? 1 : 0,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
