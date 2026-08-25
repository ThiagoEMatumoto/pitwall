import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import {
  C,
  Composer,
  CrewDockStrip,
  DISPLAY,
  DiagramCanvas,
  MONO,
  SessionCard,
  SummaryChip,
  TerminalLines,
  WindowChrome,
  type CrewSession,
  type DiagramEdge,
  type DiagramNode,
} from "./ui";
import { PitwallMark } from "./ui/icons";

// Bancada dos componentes de chrome: tudo que as cenas vão montar, na mesma
// tela e com as camadas entrando na ordem em que entram no vídeo. Assenta por
// volta do frame 30 — é esse o frame que a verificação captura.

const CREW: CrewSession[] = [
  { id: "otavio-auth", alias: "otavio-auth", state: "working" },
  { id: "rita-billing", alias: "rita-billing", state: "waiting" },
  { id: "bruno-deploy", alias: "bruno-deploy", state: "working" },
  { id: "ana-schema", alias: "ana-schema", state: "done" },
  { id: "caio-infra", alias: "caio-infra", state: "idle" },
];

const NODES: DiagramNode[] = [
  {
    id: "mae",
    x: 50,
    y: 168,
    w: 220,
    h: 92,
    label: "Sessão-mãe",
    sub: "decide",
    tone: "accent",
  },
  {
    id: "otavio",
    x: 398,
    y: 34,
    w: 236,
    h: 86,
    label: "otavio-auth",
    sub: "investigar",
    tone: "info",
  },
  {
    id: "rita",
    x: 398,
    y: 172,
    w: 236,
    h: 86,
    label: "rita-billing",
    sub: "editar",
    tone: "accent",
  },
  {
    id: "bruno",
    x: 398,
    y: 310,
    w: 236,
    h: 86,
    label: "bruno-deploy",
    sub: "operar",
    tone: "warning",
  },
  {
    id: "pr",
    x: 736,
    y: 172,
    w: 150,
    h: 86,
    label: "PR #241",
    sub: "legal-core",
    tone: "success",
  },
];

const EDGES: DiagramEdge[] = [
  { from: "mae", to: "otavio", tone: "accent2" },
  { from: "mae", to: "rita", label: "delega", tone: "accent2" },
  { from: "mae", to: "bruno", tone: "accent2" },
  { from: "rita", to: "pr", tone: "success" },
];

const TERM_LINES = [
  {
    prefix: "❯",
    text: "pitwall sessions --repo legal-core",
    tone: "command" as const,
  },
  { text: "3 sessões vivas · 1 esperando você", tone: "output" as const },
  {
    prefix: "❯",
    text: "pitwall crew despacha otavio-auth --modo investigar",
    tone: "command" as const,
  },
  {
    text: "✓ filha despachada em .worktrees/fix-session-ttl",
    tone: "success" as const,
  },
  {
    text: "⚠ rita-billing aguarda resposta há 2 min",
    tone: "warning" as const,
  },
  {
    prefix: "❯",
    text: "pitwall crew responder rita-billing",
    tone: "command" as const,
  },
];

const PROMPT =
  "Investiga por que o cache de sessão expira antes do TTL em legal-core e abre PR com teste de regressão.";

const GroupLabel: React.FC<{ children: string }> = ({ children }) => (
  <div
    style={{
      fontFamily: MONO,
      fontSize: 11.5,
      letterSpacing: 1.2,
      textTransform: "uppercase",
      color: C.textDim,
      marginBottom: 10,
    }}
  >
    {children}
  </div>
);

export const UiLab: React.FC = () => {
  const frame = useCurrentFrame();
  const at = (a: number, b: number) =>
    interpolate(frame, [a, b], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  const chrome = at(0, 12);
  const rail = at(4, 16);
  const main = at(8, 20);
  const dock = at(12, 24);
  const nodesP = at(12, 26);
  const edgesP = at(18, 30);
  const typed = at(12, 30);
  const termTyped = at(4, 30);
  const chipRise = at(20, 30);

  return (
    <AbsoluteFill style={{ background: C.bg, padding: 48, gap: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <PitwallMark size={30} gradientId="pw-apex-lab" />
        <span
          style={{
            fontFamily: DISPLAY,
            fontWeight: 800,
            fontSize: 26,
            color: C.text,
          }}
        >
          Pitwall — bancada de chrome
        </span>
        <span style={{ fontFamily: MONO, fontSize: 14, color: C.textDim }}>
          tema Vácuo · frame {frame}
        </span>
      </div>

      <div style={{ display: "flex", gap: 40, flex: 1, minHeight: 0 }}>
        {/* ── Janela completa, montada por camadas ──────────────────── */}
        <div>
          <GroupLabel>
            WindowChrome + DiagramCanvas + SummaryChip + Composer
          </GroupLabel>
          <WindowChrome
            width={1080}
            height={806}
            activeRail="diagrams"
            repo="legal-core"
            branch="fix/session-ttl"
            chromeProgress={chrome}
            railProgress={rail}
            mainProgress={main}
            dockProgress={dock}
            dock={<CrewDockStrip sessions={CREW} />}
          >
            <div
              style={{
                padding: 24,
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              {/* Caixas primeiro, setas depois: é a ordem em que a mão desenha. */}
              <DiagramCanvas
                width={924}
                height={430}
                nodes={NODES}
                edges={EDGES.map((e) => ({ ...e, progress: edgesP }))}
                progress={nodesP}
              />
              <SummaryChip
                width={924}
                label="otavio-auth · reportou"
                text="O TTL é lido do env em dois lugares e o segundo sobrescreve com 300s. Fix de uma linha + teste de regressão."
                meta="há 40s"
                rise={chipRise}
              />
              <Composer
                width={924}
                text={PROMPT}
                typed={typed}
                focus={main}
                model="Opus 5 · pensar"
              />
            </div>
          </WindowChrome>
        </div>

        {/* ── Peças soltas ──────────────────────────────────────────── */}
        <div
          style={{ flex: 1, display: "flex", flexDirection: "column", gap: 26 }}
        >
          <div>
            <GroupLabel>TerminalLines</GroupLabel>
            <TerminalLines
              width={664}
              lines={TERM_LINES}
              typed={termTyped}
              fontSize={14.5}
            />
          </div>

          <div>
            <GroupLabel>SessionCard</GroupLabel>
            <div style={{ display: "flex", gap: 20 }}>
              <SessionCard
                width={322}
                alias="otavio-auth"
                scope="legal-core"
                mode="investigar"
                state="working"
                progress={interpolate(frame, [10, 40], [0.12, 0.68], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })}
                note="lendo session-cache.ts e os testes de TTL"
                rise={at(14, 24)}
              />
              <SessionCard
                width={322}
                alias="rita-billing"
                mode="editar"
                state="waiting"
                progress={0.41}
                note="perguntou: migro o campo ou crio um novo?"
                rise={at(18, 28)}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
            <div>
              <GroupLabel>Composer · mic + selo</GroupLabel>
              <Composer
                width={560}
                text="responde a rita: cria campo novo, migração vem depois"
                typed={typed}
                micActive
                badge={{ label: "revisar", tone: "warning" }}
                model="Sonnet 5 · rápido"
              />
            </div>
            <div>
              <GroupLabel>Strip</GroupLabel>
              <div
                style={{
                  height: 196,
                  border: `1px solid ${C.border}`,
                  borderRadius: 10,
                  overflow: "hidden",
                  display: "flex",
                }}
              >
                <CrewDockStrip sessions={CREW} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
