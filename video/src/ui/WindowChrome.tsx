import type { ReactNode } from "react";
import { C, DISPLAY, MONO, alpha, mix } from "./tokens";
import {
  IconDiagram,
  IconFolderTree,
  IconSettings,
  IconTarget,
  IconTerminal,
  IconUsers,
  PitwallMark,
} from "./icons";

// A moldura do app: barra de título, trilha de ícones à esquerda, área
// principal, Crew Dock à direita. Cada camada tem seu próprio progresso 0..1
// para as cenas montarem a janela por partes — a trilha entra antes do dock,
// o dock entra antes do conteúdo, e assim por diante. Nenhuma camada muda o
// layout ao entrar (translate + opacity, não width), então nada "pula" quando
// a próxima aparece.

export const RAIL_WIDTH = 68;
export const TITLEBAR_HEIGHT = 46;

export interface RailItem {
  id: string;
  icon: React.FC<{ size?: number; color?: string; strokeWidth?: number }>;
  label: string;
}

export const DEFAULT_RAIL: RailItem[] = [
  { id: "projects", icon: IconFolderTree, label: "Projetos" },
  { id: "sessions", icon: IconTerminal, label: "Sessões" },
  { id: "diagrams", icon: IconDiagram, label: "Diagramas" },
  { id: "crew", icon: IconUsers, label: "Equipe" },
  { id: "okrs", icon: IconTarget, label: "Objetivos" },
];

export interface WindowChromeProps {
  width?: number;
  height?: number;
  /** Aba/rota ativa na trilha de ícones. */
  activeRail?: string;
  railItems?: RailItem[];
  /** Repositório mostrado na barra de título. */
  repo?: string;
  branch?: string;
  /** A janela em si: 0 = ausente, 1 = assentada. */
  chromeProgress?: number;
  /** Trilha de ícones à esquerda. */
  railProgress?: number;
  /** Conteúdo da área principal. */
  mainProgress?: number;
  /** Trilha do Crew Dock à direita. */
  dockProgress?: number;
  /** Passe `null` para a janela sem equipe — a trilha some do layout. */
  dock?: ReactNode;
  children?: ReactNode;
}

/** Camada que entra deslizando: mantém o layout, move só o pixel. */
function layer(progress: number, dx = 0, dy = 0): React.CSSProperties {
  const p = Math.max(0, Math.min(1, progress));
  return {
    opacity: p,
    transform: `translate(${(dx * (1 - p)).toFixed(2)}px, ${(dy * (1 - p)).toFixed(2)}px)`,
  };
}

export const WindowChrome: React.FC<WindowChromeProps> = ({
  width = 1520,
  height = 860,
  activeRail = "sessions",
  railItems = DEFAULT_RAIL,
  repo = "claude-manager",
  branch = "feat/video-lab",
  chromeProgress = 1,
  railProgress = 1,
  mainProgress = 1,
  dockProgress = 1,
  dock,
  children,
}) => {
  const cp = Math.max(0, Math.min(1, chromeProgress));

  return (
    <div
      style={{
        width,
        height,
        borderRadius: 20,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: C.surface,
        border: `1px solid ${C.border}`,
        // Assentar: a janela sobe um fio e cresce de 0.97 — o suficiente para
        // ler como "chegou", não como zoom.
        opacity: cp,
        transform: `scale(${(0.97 + 0.03 * cp).toFixed(4)}) translateY(${((1 - cp) * 14).toFixed(2)}px)`,
        boxShadow: `0 40px 120px -20px rgba(0,0,0,0.85), 0 0 0 1px ${alpha(C.accent, 0.06)}`,
      }}
    >
      {/* ── Barra de título ───────────────────────────────────────────── */}
      <div
        style={{
          height: TITLEBAR_HEIGHT,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 16px",
          borderBottom: `1px solid ${C.border}`,
          background: C.surface,
        }}
      >
        <PitwallMark size={26} gradientId="pw-apex-titlebar" />
        <span
          style={{
            fontFamily: DISPLAY,
            fontWeight: 700,
            fontSize: 15,
            letterSpacing: 0.2,
            color: C.text,
          }}
        >
          Pitwall
        </span>
        <span style={{ width: 1, height: 18, background: C.border }} />
        <span
          style={{
            fontFamily: MONO,
            fontSize: 12.5,
            color: C.textDim,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {repo}
          <span style={{ color: mix(C.textDim, C.surface, 0.5) }}>·</span>
          <span style={{ color: C.accent2 }}>{branch}</span>
        </span>
        <div style={{ flex: 1 }} />
        <IconSettings
          size={16}
          color={mix(C.textDim, C.surface, 0.7)}
          strokeWidth={1.8}
        />
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* ── Trilha de ícones ───────────────────────────────────────── */}
        <div
          style={{
            width: RAIL_WIDTH,
            flexShrink: 0,
            borderRight: `1px solid ${C.border}`,
            background: C.surface,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            paddingTop: 14,
            ...layer(railProgress, -RAIL_WIDTH),
          }}
        >
          {railItems.map((item) => {
            const active = item.id === activeRail;
            const Glyph = item.icon;
            return (
              <div
                key={item.id}
                style={{
                  width: RAIL_WIDTH - 16,
                  height: 44,
                  borderRadius: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: active ? C.surface2 : "transparent",
                  // O marcador accent colado à esquerda é o mesmo
                  // .pw-active-marker do app.
                  boxShadow: active ? `inset 2px 0 0 ${C.accent}` : undefined,
                }}
              >
                <Glyph
                  size={20}
                  color={active ? C.text : C.textDim}
                  strokeWidth={1.8}
                />
              </div>
            );
          })}
        </div>

        {/* ── Área principal ─────────────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: C.bg,
            position: "relative",
            display: "flex",
            flexDirection: "column",
            ...layer(mainProgress, 0, 10),
          }}
        >
          {children}
        </div>

        {/* ── Crew Dock ──────────────────────────────────────────────── */}
        {dock ? (
          <div style={{ flexShrink: 0, ...layer(dockProgress, 40) }}>
            {dock}
          </div>
        ) : null}
      </div>
    </div>
  );
};
