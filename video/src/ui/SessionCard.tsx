import { C, DISPLAY, MONO, alpha, mix } from "./tokens";
import { STATE_COLOR, type CrewState } from "./CrewDockStrip";

// O card de uma sessão-filha. O apelido vem em mono porque é endereço — é por
// ele que você fala com ela. O modo é o contrato de quanto ela pode mexer:
// investigar (só lê), editar (mexe no código), operar (roda comando de verdade)
// — e a cor sobe junto com o risco.

export type CrewMode = "investigar" | "editar" | "operar";

const MODE_COLOR: Record<CrewMode, string> = {
  investigar: C.info,
  editar: C.accent,
  operar: C.warning,
};

const STATE_LABEL: Record<CrewState, string> = {
  working: "em pista",
  waiting: "esperando você",
  idle: "pausada",
  done: "reportou",
};

export interface SessionCardProps {
  width?: number;
  /** Apelido da filha, ex.: "otavio-auth". */
  alias: string;
  /** Escopo entre parênteses, ex.: "legal-core". */
  scope?: string;
  mode: CrewMode;
  /** Rótulo do modo já no idioma da cena. Sem ele, a própria chave. */
  modeLabel?: string;
  /** 0..1 — traço accent crescendo sob o apelido, quando ele é o assunto. */
  aliasUnderline?: number;
  state?: CrewState;
  /** 0..1 — quanto do trabalho dela já andou. */
  progress?: number;
  /** Uma linha do que ela está fazendo agora. */
  note?: string;
  /** 0..1 — entrada (sobe 10px). */
  rise?: number;
}

export const SessionCard: React.FC<SessionCardProps> = ({
  width = 380,
  alias,
  scope,
  mode,
  modeLabel,
  aliasUnderline = 0,
  state = "working",
  progress = 0,
  note,
  rise = 1,
}) => {
  const p = Math.max(0, Math.min(1, progress));
  const r = Math.max(0, Math.min(1, rise));
  const u = Math.max(0, Math.min(1, aliasUnderline));
  const modeColor = MODE_COLOR[mode];
  const stateColor = STATE_COLOR[state];

  return (
    <div
      style={{
        width,
        padding: 16,
        borderRadius: 14,
        background: C.surface,
        border: `1px solid ${state === "waiting" ? alpha(C.warning, 0.4) : C.border}`,
        opacity: r,
        transform: `translateY(${((1 - r) * 10).toFixed(2)}px)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: stateColor,
            flexShrink: 0,
          }}
        />
        <span style={{ position: "relative", minWidth: 0 }}>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 15,
              color: C.text,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {alias}
          </span>
          {u > 0.01 && (
            <span
              style={{
                position: "absolute",
                left: 0,
                bottom: -4,
                height: 2,
                width: `${(u * 100).toFixed(1)}%`,
                borderRadius: 1,
                background: C.accent,
              }}
            />
          )}
        </span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: DISPLAY,
            fontWeight: 600,
            fontSize: 11.5,
            letterSpacing: 0.3,
            padding: "3px 9px",
            borderRadius: 999,
            color: modeColor,
            border: `1px solid ${alpha(modeColor, 0.45)}`,
            background: alpha(modeColor, 0.12),
            whiteSpace: "nowrap",
          }}
        >
          {modeLabel ?? mode}
        </span>
      </div>

      <div
        style={{
          marginTop: 10,
          fontFamily: DISPLAY,
          fontSize: 13.5,
          lineHeight: 1.4,
          color: C.textDim,
          minHeight: 19,
        }}
      >
        {/* O escopo vai aqui, não colado no apelido: o apelido é endereço e
            não pode ser truncado por causa do nome do repo. */}
        {scope && (
          <span
            style={{ fontFamily: MONO, color: C.textDim }}
          >{`${scope} · `}</span>
        )}
        {note ?? STATE_LABEL[state]}
      </div>

      <div
        style={{
          marginTop: 14,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            flex: 1,
            height: 4,
            borderRadius: 999,
            background: mix(C.border, C.surface, 0.8),
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${(p * 100).toFixed(1)}%`,
              height: "100%",
              borderRadius: 999,
              background: `linear-gradient(90deg, ${C.accent2}, ${C.accent})`,
            }}
          />
        </div>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11.5,
            fontVariantNumeric: "tabular-nums",
            color: C.textDim,
            width: 34,
            textAlign: "right",
          }}
        >
          {Math.round(p * 100)}%
        </span>
      </div>
    </div>
  );
};
