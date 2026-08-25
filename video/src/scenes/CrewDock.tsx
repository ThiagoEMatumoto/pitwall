import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import script from "../../content/script.json";
import type { Locale } from "../config";
import { springAt } from "../motion";
import { getPreset, type ThemePreset, type ThemeTokens } from "../theme";
import {
  ApexDot,
  C,
  Composer,
  CrewDockStrip,
  DISPLAY,
  MONO,
  TerminalLines,
  WindowChrome,
  alpha,
  type CrewSession,
  type CrewState,
  type LineTone,
  type TermLine,
} from "../ui";

// Zoom out até a trilha de 40px, Ctrl+J abre o peek sobre o conteúdo, a
// resposta é digitada in-place — e a filha que estava em âmbar volta pro azul.
//
// O fecho é o único momento de cor saturada do filme: o tema troca. É aqui,
// também, que o filme gasta seu ÚNICO whip lateral — a virada pra dentro do
// re-skin. A troca de tema é um corte seco, não um pisca-pisca.

const WIN_W = 1520;
const WIN_H = 860;

/**
 * Enquadramento de abertura. O quadro segura a borda direita da janela junto
 * da borda do frame (é o que impede o vazio à direita), então o zoom máximo é
 * o que ainda deixa a barra de título INTEIRA dentro do quadro: acima de ~1.25
 * o nome do repo sangra pela esquerda.
 */
const ZOOM_IN = 1.24;
const ZOOM_OUT = 0.98;
/** x da borda direita da janela durante o close-up. */
const RIGHT_EDGE = 1900;

// Cenário da sessão: comandos, tool calls e caminhos. Não é texto de roteiro
// (esse vem do script.json) e não se traduz — comando de shell e nome de
// arquivo são os mesmos nos dois locales. Mesma convenção da cena do cockpit.
const SESSION: TermLine[] = [
  { prefix: "❯", text: "claude --resume crew-dock", tone: "command" },
  { text: "read src/ui/CrewDockStrip.tsx", tone: "dim" },
  { text: "read src/lib/handoff/registry.ts", tone: "dim" },
  { text: 'grep "apexId" src/ui', tone: "dim" },
  { text: "edit CrewDockStrip.tsx", tone: "output" },
  { text: "bash npm run typecheck", tone: "output" },
  { text: "0 errors", tone: "dim" },
  {
    prefix: "❯",
    text: "session_handoff --alias mauricio-etl --mode edit",
    tone: "command",
  },
  { text: "repo legal-core · worktree feat/etl-backfill", tone: "dim" },
  { text: "mauricio-etl ready", tone: "success" },
  { text: "read src/etl/backfill.ts", tone: "dim" },
  { text: "read src/etl/schema.sql", tone: "dim" },
  { text: "edit backfill.ts", tone: "output" },
  { text: "bash npm test -- backfill", tone: "output" },
  { text: "24 passed in 3.1s", tone: "dim" },
  { text: "handoff_progress · 46%", tone: "output" },
  { text: "otavio-auth · 78% · investigate", tone: "dim" },
  { text: "renata-deploy · done · operate", tone: "dim" },
  { prefix: "❯", text: "npm run llm:check", tone: "command" },
  { text: "lint 0 · types 0 · 132 tests passed", tone: "dim" },
  { text: "read src/ui/WindowChrome.tsx", tone: "dim" },
  { text: "edit WindowChrome.tsx", tone: "output" },
  { text: 'bash git commit -m "feat: crew dock peek"', tone: "output" },
  { text: "1 file changed · 34 insertions", tone: "dim" },
  { text: "handoff_ask · mauricio-etl", tone: "output" },
  { text: "⚠ mauricio-etl is waiting", tone: "warning" },
];

const PANE_FONT = 15.5;
const PANE_W = 1180;

/**
 * A troca de tema: dois estados, ambos dentro da paleta do filme — Vácuo
 * (roxo) e Gelo (ciano). Verde e laranja existem no app, mas colocá-los aqui
 * gastaria em 1 segundo a regra 90/8/2 do filme inteiro.
 */
const THEME_ORDER = ["slate", "ocean"];

const TONE_TOKEN = (tone: LineTone | undefined, t: ThemeTokens): string => {
  switch (tone) {
    case "command":
      return t.text;
    case "accent":
      return t.accent;
    case "success":
      return t.success;
    case "warning":
      return t.warning;
    case "danger":
      return t.danger;
    case "dim":
      return t["text-dim"];
    default:
      return t["text-dim"];
  }
};

/**
 * A MESMA janela repintada — mesma geometria, mesmo transcrito, mesma barra de
 * título. O corte é um re-skin, não outra tela: se o texto sumisse aqui, o
 * espectador leria glitch em vez de tema.
 */
const ThemeFlash: React.FC<{ preset: ThemePreset }> = ({ preset }) => {
  const t = preset.tokens;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(66% 66% at 50% 46%, ${alpha(t.accent, 0.17)}, ${t.bg} 72%)`,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: WIN_W,
          height: WIN_H,
          transform: `scale(${ZOOM_OUT})`,
          borderRadius: 20,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: t.surface,
          border: `1px solid ${t.border}`,
          boxShadow: `0 40px 120px -20px rgba(0,0,0,0.85)`,
        }}
      >
        {/* Barra de título: o mesmo lockup da janela real, repintado. */}
        <div
          style={{
            height: 46,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "0 16px",
            borderBottom: `1px solid ${t.border}`,
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: `linear-gradient(135deg, ${t.accent2}, ${t.accent})`,
            }}
          />
          <span
            style={{
              fontFamily: DISPLAY,
              fontWeight: 700,
              fontSize: 15,
              letterSpacing: 0.2,
              color: t.text,
            }}
          >
            Pitwall
          </span>
          <span style={{ width: 1, height: 18, background: t.border }} />
          <span
            style={{
              fontFamily: MONO,
              fontSize: 12.5,
              color: t["text-dim"],
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            pitwall
            <span style={{ opacity: 0.5 }}>·</span>
            <span style={{ color: t.accent2 }}>feat/crew-dock</span>
          </span>
          <div style={{ flex: 1 }} />
          <span
            style={{
              fontFamily: MONO,
              fontSize: 12.5,
              letterSpacing: "0.08em",
              color: t.accent,
              padding: "4px 10px",
              borderRadius: 7,
              border: `1px solid ${alpha(t.accent, 0.35)}`,
            }}
          >
            {preset.label}
          </span>
        </div>

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div
            style={{
              width: 68,
              flexShrink: 0,
              borderRight: `1px solid ${t.border}`,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
              paddingTop: 14,
            }}
          >
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                style={{
                  width: 52,
                  height: 44,
                  borderRadius: 10,
                  background: i === 3 ? t["surface-2"] : "transparent",
                  boxShadow: i === 3 ? `inset 2px 0 0 ${t.accent}` : undefined,
                }}
              />
            ))}
          </div>

          {/* Conteúdo: o mesmo transcrito, nas cores do tema. */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              background: t.bg,
              padding: "40px 48px",
              fontFamily: MONO,
              fontSize: PANE_FONT,
              lineHeight: 1.65,
            }}
          >
            {SESSION.map((line, i) => (
              <div
                key={i}
                style={{
                  whiteSpace: "pre",
                  color: TONE_TOKEN(line.tone, t),
                  opacity: line.tone === "dim" ? 0.62 : 1,
                }}
              >
                {line.prefix && (
                  <span style={{ color: t.accent2, marginRight: 8 }}>
                    {line.prefix}
                  </span>
                )}
                {line.text}
              </div>
            ))}
            {/* A barra de progresso da filha — o mesmo elemento dos cards do
                handoff. É o que carrega a cor do tema sem virar bloco. */}
            <div
              style={{
                marginTop: 22,
                width: 520,
                height: 8,
                borderRadius: 999,
                background: `linear-gradient(90deg, ${t.accent2}, ${t.accent})`,
              }}
            />
          </div>

          <div
            style={{
              width: 40,
              flexShrink: 0,
              borderLeft: `1px solid ${t.border}`,
              background: t.surface,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 11,
              paddingTop: 34,
            }}
          >
            {[
              t.info,
              t.info,
              t["text-dim"],
              t.info,
              t.success,
              t["text-dim"],
            ].map((color, i) => (
              <span
                key={i}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: color,
                  opacity: color === t["text-dim"] ? 0.5 : 1,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const CrewDock: React.FC<{
  durationInFrames: number;
  locale: Locale;
}> = ({ durationInFrames, locale }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const D = durationInFrames;
  const at = (fraction: number) => Math.round(fraction * D);

  const scenes = script.scenes;
  const onScreen = scenes.find((s) => s.id === "crew-dock")!.onScreen[locale];
  const [dockLabel, shortcut] = onScreen;
  const handoff = scenes.find((s) => s.id === "handoff")!.onScreen[locale];
  const aliases = handoff.slice(0, 3);
  const modes = (handoff[3] ?? "").split("·").map((token) => token.trim());

  // ── Enquadramento: da trilha para a janela inteira ──────────────────────
  // O close-up segura um instante antes de abrir. O zoom para em ZOOM_IN: o
  // suficiente pra trilha de 40px pesar no quadro, sem cortar o chrome.
  const out = springAt(frame, fps, {
    preset: "assentar",
    delay: at(0.08),
    durationInFrames: at(0.32),
  });
  const scale = interpolate(out, [0, 1], [ZOOM_IN, ZOOM_OUT]);
  // A câmera segura a borda direita da janela junto da borda do quadro — é o
  // que impede o vazio à direita quando ela está ampliada.
  const tx = (1 - out) * (RIGHT_EDGE - 960 - (WIN_W / 2) * ZOOM_IN);

  // ── Peek ────────────────────────────────────────────────────────────────
  const peek = springAt(frame, fps, { preset: "entrada", delay: at(0.42) });
  const typed = interpolate(frame, [at(0.52), at(0.63)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // O transcrito da sessão não nasce pronto: as últimas linhas caem antes do
  // atalho, então o "⚠ mauricio-etl is waiting" é o que MOTIVA o Ctrl+J.
  const paneTyped = interpolate(frame, [at(0.04), at(0.4)], [0.82, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const shortcutHit = interpolate(
    frame,
    [at(0.38), at(0.42), at(0.48)],
    [0, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  // Respondeu: a filha sai do âmbar. O peek deixa de ser bloqueio.
  const answered = frame >= at(0.64);

  // ── Whip + troca de tema ────────────────────────────────────────────────
  const whipAt = at(0.66);
  const whipLen = Math.max(6, Math.round(D * 0.033));
  // Meio segundo por tema: abaixo disso a troca lê como falha de render, não
  // como escolha do usuário.
  const flashLen = Math.max(14, Math.round(D * 0.07));
  const flashFrom = whipAt + whipLen;
  const flashUntil = flashFrom + flashLen * THEME_ORDER.length;
  const flashIndex =
    frame >= flashFrom && frame < flashUntil
      ? Math.floor((frame - flashFrom) / flashLen)
      : -1;

  const whipOut = interpolate(frame, [whipAt, whipAt + whipLen], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // A entrada do re-skin completa o MESMO whip: sai à esquerda, entra da direita.
  const whipIn = interpolate(
    frame,
    [flashFrom, flashFrom + Math.round(whipLen * 0.6)],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );
  // Depois do último tema o filme volta pro Vácuo real: é nele que a cena
  // segura os últimos frames parados.
  const returned = frame >= flashUntil;
  const wOut = returned ? 0 : whipOut;
  const blurX = (flashIndex === 0 ? whipIn : wOut) * 26;
  const windowGone = flashIndex >= 0;

  // ── Estados na trilha ───────────────────────────────────────────────────
  const stateAt = (i: number): CrewState => {
    if (i === 1) {
      if (frame >= at(0.64)) return "working";
      if (frame >= at(0.2)) return "waiting";
      return "working";
    }
    if (i === 4) return frame >= at(0.46) ? "done" : "working";
    if (i === 3) return frame >= at(0.34) ? "working" : "idle";
    if (i === 2) return "idle";
    if (i === 5) return frame >= at(0.56) ? "done" : "idle";
    return "working";
  };
  const sessions: CrewSession[] = [0, 1, 2, 3, 4, 5].map((i) => ({
    id: `s${i}`,
    alias: aliases[i % aliases.length],
    state: stateAt(i),
  }));

  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      {/* feGaussianBlur direcional: o borrão do whip é lateral, não isotrópico. */}
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <filter id="pw-whip" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={`${blurX.toFixed(2)} 0`} />
        </filter>
      </svg>

      {!windowGone && (
        <AbsoluteFill
          style={{
            transform: `translateX(${(-620 * wOut).toFixed(1)}px)`,
            opacity: 1 - wOut,
            filter: blurX > 0.2 ? "url(#pw-whip)" : undefined,
          }}
        >
          <AbsoluteFill
            style={{
              alignItems: "center",
              justifyContent: "center",
              transform: `translateX(${tx.toFixed(1)}px) scale(${scale.toFixed(4)})`,
            }}
          >
            <WindowChrome
              width={WIN_W}
              height={WIN_H}
              activeRail="crew"
              repo="pitwall"
              branch="feat/crew-dock"
              dock={
                <CrewDockStrip
                  sessions={sessions}
                  apexId={sessions[1].state === "waiting" ? "s1" : undefined}
                />
              }
            >
              {/* Conteúdo da sessão: fora de foco enquanto o peek está aberto —
                  um plano nítido por vez. */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  padding: "40px 48px",
                  filter:
                    peek > 0.02
                      ? `blur(${(3.2 * peek).toFixed(2)}px)`
                      : undefined,
                  opacity: 1 - 0.45 * peek,
                }}
              >
                <TerminalLines
                  width={PANE_W}
                  lines={SESSION}
                  typed={paneTyped}
                  fontSize={PANE_FONT}
                  framed={false}
                />
              </div>

              {/* Peek: entra por cima do conteúdo, colado na trilha. */}
              <div
                style={{
                  position: "absolute",
                  right: 18,
                  top: 64,
                  width: 470,
                  padding: 16,
                  borderRadius: 16,
                  background: C.surface2,
                  border: `1px solid ${answered ? C.border : alpha(C.warning, 0.28)}`,
                  boxShadow: "0 30px 90px -20px rgba(0,0,0,0.9)",
                  opacity: peek,
                  transform: `translateX(${((1 - peek) * 46).toFixed(1)}px)`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    marginBottom: 14,
                  }}
                >
                  <ApexDot
                    size={9}
                    color={answered ? C.info : C.warning}
                    active={!answered}
                  />
                  <span
                    style={{ fontFamily: MONO, fontSize: 14, color: C.text }}
                  >
                    {aliases[1]}
                  </span>
                  <div style={{ flex: 1 }} />
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 11.5,
                      color: C.textDim,
                      padding: "3px 8px",
                      borderRadius: 6,
                      border: `1px solid ${C.border}`,
                    }}
                  >
                    {shortcut}
                  </span>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <TerminalLines
                    width={438}
                    lines={[
                      { text: "handoff_ask · backfill.ts:142", tone: "output" },
                      { text: "legal-core · feat/etl-backfill", tone: "dim" },
                      { text: "reindex ? migrate", tone: "dim" },
                    ]}
                    fontSize={12.5}
                    cursor={false}
                    framed={false}
                  />
                </div>

                <Composer
                  width={438}
                  text={modes[1]}
                  typed={typed}
                  placeholder=""
                  model="Opus 5"
                  focus={peek}
                />
              </div>
            </WindowChrome>
          </AbsoluteFill>
        </AbsoluteFill>
      )}

      {flashIndex >= 0 && (
        <AbsoluteFill
          style={{
            transform: `translateX(${(560 * (flashIndex === 0 ? whipIn : 0)).toFixed(1)}px)`,
            filter:
              flashIndex === 0 && blurX > 0.2 ? "url(#pw-whip)" : undefined,
          }}
        >
          <ThemeFlash preset={getPreset(THEME_ORDER[flashIndex])} />
        </AbsoluteFill>
      )}

      {/* Legenda do quadro: fora do whip e fora do re-skin. É o texto que
          atravessa a cena inteira — inclusive a troca de tema. */}
      <div
        style={{
          position: "absolute",
          left: 200,
          bottom: 40,
          display: "flex",
          alignItems: "baseline",
          gap: 16,
          opacity: springAt(frame, fps, {
            preset: "entrada",
            delay: at(0.24),
          }),
        }}
      >
        <span
          style={{
            fontFamily: DISPLAY,
            fontWeight: 600,
            fontSize: 34,
            letterSpacing: "-0.01em",
            color: C.text,
          }}
        >
          {dockLabel}
        </span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 14,
            letterSpacing: "0.08em",
            color: shortcutHit > 0.02 ? C.accent : C.textDim,
            padding: "5px 10px",
            borderRadius: 7,
            border: `1px solid ${
              shortcutHit > 0.02
                ? alpha(C.accent, 0.3 + 0.5 * shortcutHit)
                : C.border
            }`,
          }}
        >
          {shortcut}
        </span>
      </div>
    </AbsoluteFill>
  );
};
