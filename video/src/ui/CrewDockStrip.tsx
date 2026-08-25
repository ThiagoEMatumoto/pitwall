import { C, MONO, alpha } from "./tokens";
import { IconUsers } from "./icons";
import { ApexDot } from "./ApexDot";

// A trilha colapsada do Crew Dock: 40px na borda direita da janela, onde a
// equipe inteira cabe como cor. É o resumo, não o painel — quem espera acende
// em âmbar e ganha o Ápice; o resto são dots. Enquanto ninguém pede nada, a
// trilha é só presença.

export const STRIP_WIDTH = 40;

export type CrewState = "working" | "waiting" | "idle" | "done";

export const STATE_COLOR: Record<CrewState, string> = {
  working: C.info,
  waiting: C.warning,
  idle: C.textDim,
  done: C.success,
};

export interface CrewSession {
  id: string;
  /** Apelido da filha, ex.: "otavio-auth". */
  alias: string;
  state: CrewState;
}

export interface CrewDockStripProps {
  sessions: CrewSession[];
  width?: number;
  /** Quantos dots já entraram — para a cena povoar a trilha uma a uma. */
  visibleCount?: number;
  /** Qual sessão leva o Ápice. Sem isso, a primeira que estiver esperando. */
  apexId?: string;
}

export const CrewDockStrip: React.FC<CrewDockStripProps> = ({
  sessions,
  width = STRIP_WIDTH,
  visibleCount,
  apexId,
}) => {
  const shown = sessions.slice(0, visibleCount ?? sessions.length);
  const waiting = shown.filter((s) => s.state === "waiting").length;
  const apex = apexId ?? shown.find((s) => s.state === "waiting")?.id;

  return (
    <div
      style={{
        width,
        height: "100%",
        flexShrink: 0,
        borderLeft: `1px solid ${C.border}`,
        background: C.surface,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 9,
        paddingTop: 10,
      }}
    >
      <IconUsers size={16} color={C.textDim} strokeWidth={1.8} />

      <span
        style={{
          fontFamily: MONO,
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          color: waiting > 0 ? C.warning : C.accent,
          padding: "1px 5px",
          borderRadius: 5,
          background: waiting > 0 ? alpha(C.warning, 0.12) : "transparent",
        }}
      >
        {waiting > 0 ? `${waiting}!` : shown.length}
      </span>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 11,
          paddingTop: 4,
        }}
      >
        {shown.map((s, i) =>
          s.id === apex ? (
            <ApexDot key={s.id} size={10} color={C.warning} phase={i * 0.12} />
          ) : (
            <span
              key={s.id}
              title={s.alias}
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: STATE_COLOR[s.state],
                // A filha ociosa é presença, não sinal: fica apagada.
                opacity: s.state === "idle" ? 0.5 : 1,
              }}
            />
          ),
        )}
      </div>
    </div>
  );
};
