import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import scriptJson from "../../content/script.json";
import type { Locale } from "../config";
import { Parallax, ParallaxLayer, StaggerText, springAt } from "../motion";
import {
  C,
  CrewDockStrip,
  MONO,
  TerminalLines,
  WindowChrome,
  alpha,
  mix,
  type CrewSession,
  type TermLine,
} from "../ui";

// Cena 3 — produto. O shell se monta por camadas: janela, trilha, conteúdo,
// dock. Três planos com parallax diferencial (0.2 / 0.6 / 1.0) dão profundidade
// sem 3D. Os três termos do roteiro entram como legendas mono discretas e
// acendem a região da janela a que se referem — o texto aponta pro pixel.

const SCENE = scriptJson.scenes.find((s) => s.id === "cockpit") as unknown as {
  onScreen: Record<Locale, string[]>;
};

const EASE_MOVE = Easing.bezier(0.2, 0, 0, 1);
const EASE_OUT = Easing.bezier(0.3, 0, 0.8, 0.15);

const HOLD = 28;
/** Frações de `anim` em que cada legenda (e a região correspondente) acende. */
const LABEL_AT = [0.3, 0.52, 0.72];

const WIN_W = 1480;
const WIN_H = 786;

// Larguras em pixel, não flex: TerminalLines tem largura própria e, se ela não
// couber no container, o texto passa por baixo do Crew Dock em silêncio (foi
// exatamente o que a primeira leva de stills mostrou).
const CONTENT_W = 1290;
const CHIP_W = Math.floor((CONTENT_W - 28) / 3);
const PANE_W = 630;
const PANE_PAD = 20;

/** Deslocamento base da câmera. A camada de depth=1 anda exatamente isto. */
const TRAVEL_X = 34;
const TRAVEL_Y = 56;

// Cenário: nomes de repo, branches e comandos. Não é texto de roteiro (esse vem
// do script.json) e não se traduz — comando de shell é o mesmo nos dois locales.
const REPOS = [
  { name: "legal-api", branch: "main", color: C.success },
  { name: "legal-core", branch: "fix/session-ttl", color: C.info },
  { name: "legal-ui", branch: "feat/crew-dock", color: C.warning },
];

const PANE_A: TermLine[] = [
  { prefix: "❯", text: "claude --resume session-ttl", tone: "command" },
  { text: "read src/lib/session-cache.ts", tone: "dim" },
  { text: 'grep "TTL" src/', tone: "dim" },
  { text: "read src/lib/session-store.ts", tone: "dim" },
  { text: "edit session-cache.ts", tone: "output" },
  { text: "bash npm test -- session-cache", tone: "output" },
  { text: "18 passed in 2.4s", tone: "dim" },
  { text: "read src/lib/session-ttl.ts", tone: "dim" },
  { text: "edit session-ttl.ts", tone: "output" },
  { text: "bash npm run typecheck", tone: "output" },
  { text: "✓ 1 file changed · 8 insertions", tone: "success" },
];

const PANE_B: TermLine[] = [
  { prefix: "❯", text: "claude --resume crew-dock", tone: "command" },
  { text: "read src/ui/CrewDockStrip.tsx", tone: "dim" },
  { text: "read src/ui/tokens.ts", tone: "dim" },
  { text: "edit CrewDockStrip.tsx", tone: "output" },
  { text: "bash npm run typecheck", tone: "output" },
  { text: "0 errors", tone: "dim" },
  { text: "plan: Ctrl+J peek", tone: "output" },
  { text: "⚠ waiting for you", tone: "warning" },
];

const PLAN_STEPS = [
  { text: "worktree fix/session-ttl", done: true },
  { text: "npm test -- session-cache", done: true },
  { text: "gh pr create --fill", done: false },
];

const CREW: CrewSession[] = [
  { id: "otavio-auth", alias: "otavio-auth", state: "working" },
  { id: "rita-billing", alias: "rita-billing", state: "waiting" },
  { id: "bruno-deploy", alias: "bruno-deploy", state: "working" },
  { id: "ana-schema", alias: "ana-schema", state: "done" },
  { id: "caio-infra", alias: "caio-infra", state: "idle" },
];

/**
 * Região da janela: acende com um traço accent de 2px à esquerda, que desbota
 * pro fim — traço longo e chapado vira barra de cor, e accent não faz bloco.
 */
const Region: React.FC<{
  children: React.ReactNode;
  /** 0..1 — quanto a região está em destaque. */
  lit: number;
  grow?: number;
}> = ({ children, lit, grow }) => (
  <div style={{ display: "flex", gap: 16, flexGrow: grow, minHeight: 0 }}>
    <div
      style={{
        width: 2,
        flexShrink: 0,
        borderRadius: 2,
        background: `linear-gradient(180deg, ${C.accent}, ${alpha(C.accent, 0)})`,
        opacity: lit,
        transformOrigin: "top center",
        transform: `scaleY(${(0.35 + 0.65 * lit).toFixed(3)})`,
      }}
    />
    <div style={{ width: CONTENT_W, minWidth: 0 }}>{children}</div>
  </div>
);

/** Pane de sessão: moldura própria, terminal colado na base (como um de verdade). */
const Pane: React.FC<{ lines: TermLine[]; typed: number; cursor: boolean }> = ({
  lines,
  typed,
  cursor,
}) => (
  <div
    style={{
      width: PANE_W,
      height: "100%",
      boxSizing: "border-box",
      padding: PANE_PAD,
      borderRadius: 12,
      background: C.surface,
      border: `1px solid ${C.border}`,
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end",
      overflow: "hidden",
    }}
  >
    <TerminalLines
      width={PANE_W - PANE_PAD * 2 - 2}
      lines={lines}
      typed={typed}
      fontSize={17}
      cursor={cursor}
      framed={false}
    />
  </div>
);

export const Cockpit: React.FC<{
  durationInFrames: number;
  locale: Locale;
}> = ({ durationInFrames, locale }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const labels = SCENE.onScreen[locale];
  const anim = durationInFrames - HOLD;
  const holdStart = durationInFrames - HOLD;
  const beats = LABEL_AT.map((f) => Math.round(f * anim));

  // ── Camadas da janela: cada uma entra por translate + opacity, com stagger.
  const s = (delay: number, dur: number) =>
    springAt(frame, fps, { preset: "assentar", delay, durationInFrames: dur });
  const chrome = s(0, 26);
  const rail = s(9, 24);
  const main = s(17, 24);
  const dock = s(27, 24);

  // ── Câmera: um único deslocamento base, que cada plano multiplica pela sua
  // profundidade. Curva de camada que já está em tela.
  const settle = interpolate(frame, [0, 70], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_MOVE,
  });

  // O accent sai antes do corte.
  const accentOut = interpolate(
    frame,
    [holdStart - 16, holdStart - 3],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE_OUT,
    },
  );

  /** Qual legenda está acesa agora. -1 = nenhuma ainda. */
  const activeIndex = beats.reduce((acc, b, i) => (frame >= b ? i : acc), -1);
  const litOf = (i: number) =>
    (activeIndex === i
      ? interpolate(frame, [beats[i], beats[i] + 10], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0) * accentOut;

  const rise = (delay: number, dur = 20) =>
    springAt(frame, fps, { preset: "entrada", delay, durationInFrames: dur });

  const typedA = interpolate(frame, [36, 112], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const typedB = interpolate(frame, [48, 118], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      <Parallax x={TRAVEL_X * settle} y={TRAVEL_Y * settle}>
        {/* ── Fundo (0.2×): glow + grade de pontos, fora de foco. Escala lenta
            1.03 → 1.0, ao contrário da frente. */}
        <ParallaxLayer depth={0.2} scale={1 + 0.03 * settle}>
          <AbsoluteFill
            style={{
              filter: "blur(4px)",
              background: `radial-gradient(46% 46% at 50% 42%, ${alpha(C.accent, 0.075)}, transparent 72%)`,
            }}
          />
          <AbsoluteFill
            style={{
              opacity: 0.5,
              backgroundImage: `radial-gradient(${alpha(C.border, 0.75)} 1px, transparent 1px)`,
              backgroundSize: "46px 46px",
            }}
          />
        </ParallaxLayer>

        {/* ── Meio (0.6×): duas silhuetas da janela ATRÁS e ACIMA da real. É a
            borda que cria camada, não sombra. */}
        <ParallaxLayer depth={0.6}>
          <AbsoluteFill
            style={{
              alignItems: "center",
              justifyContent: "flex-start",
              paddingTop: 66,
            }}
          >
            {[2, 1].map((k) => (
              <div
                key={k}
                style={{
                  position: "absolute",
                  width: WIN_W - k * 80,
                  height: WIN_H - k * 40,
                  transform: `translateY(${(-34 * k).toFixed(0)}px)`,
                  borderRadius: 20,
                  border: `1px solid ${C.border}`,
                  background: mix(C.surface, C.bg, 0.45),
                  opacity: (k === 1 ? 0.55 : 0.3) * chrome,
                }}
              />
            ))}
          </AbsoluteFill>
        </ParallaxLayer>

        {/* ── Frente (1.0×): a janela. Escala 0.985 → 1.0, mais rápida que o fundo. */}
        <ParallaxLayer depth={1} scale={1 - 0.015 * settle}>
          <AbsoluteFill
            style={{
              alignItems: "center",
              justifyContent: "flex-start",
              paddingTop: 66,
            }}
          >
            <WindowChrome
              width={WIN_W}
              height={WIN_H}
              activeRail="sessions"
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
                  flex: 1,
                  minHeight: 0,
                  padding: 26,
                  display: "flex",
                  flexDirection: "column",
                  gap: 22,
                }}
              >
                {/* Região 1 — repositórios */}
                <Region lit={litOf(0)}>
                  <div style={{ display: "flex", gap: 14 }}>
                    {REPOS.map((repo, i) => {
                      const r = rise(30 + i * 4);
                      return (
                        <div
                          key={repo.name}
                          style={{
                            width: CHIP_W,
                            boxSizing: "border-box",
                            padding: "13px 16px",
                            borderRadius: 12,
                            background: C.surface,
                            border: `1px solid ${C.border}`,
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            opacity: r,
                            transform: `translateY(${((1 - r) * 10).toFixed(2)}px)`,
                          }}
                        >
                          <span
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              background: repo.color,
                              flexShrink: 0,
                            }}
                          />
                          <span
                            style={{
                              fontFamily: MONO,
                              fontSize: 17,
                              color: C.text,
                            }}
                          >
                            {repo.name}
                          </span>
                          <span style={{ flex: 1 }} />
                          <span
                            style={{
                              fontFamily: MONO,
                              fontSize: 15,
                              color: C.textDim,
                            }}
                          >
                            {repo.branch}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </Region>

                {/* Região 2 — sessões. Ocupa a folga da janela: é o miolo. */}
                <Region lit={litOf(1)} grow={1}>
                  <div style={{ display: "flex", gap: 16, height: "100%" }}>
                    {[
                      { lines: PANE_A, typed: typedA, delay: 40, caret: true },
                      { lines: PANE_B, typed: typedB, delay: 48, caret: false },
                    ].map((pane, i) => {
                      const r = rise(pane.delay, 22);
                      return (
                        <div
                          key={i}
                          style={{
                            height: "100%",
                            opacity: r,
                            transform: `translateY(${((1 - r) * 12).toFixed(2)}px)`,
                          }}
                        >
                          <Pane
                            lines={pane.lines}
                            typed={pane.typed}
                            cursor={pane.caret && frame < holdStart - 10}
                          />
                        </div>
                      );
                    })}
                  </div>
                </Region>

                {/* Região 3 — planos */}
                <Region lit={litOf(2)}>
                  {(() => {
                    const r = rise(58, 22);
                    return (
                      <div
                        style={{
                          boxSizing: "border-box",
                          padding: "16px 20px 18px",
                          borderRadius: 12,
                          background: C.surface,
                          border: `1px solid ${C.border}`,
                          opacity: r,
                          transform: `translateY(${((1 - r) * 10).toFixed(2)}px)`,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            fontFamily: MONO,
                            fontSize: 15,
                            letterSpacing: "0.12em",
                            textTransform: "uppercase",
                            color: C.textDim,
                            marginBottom: 12,
                          }}
                        >
                          PLAN.md
                          <span style={{ flex: 1 }} />
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>
                            2 / 3
                          </span>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 9,
                          }}
                        >
                          {PLAN_STEPS.map((step, i) => {
                            const sr = rise(64 + i * 4);
                            return (
                              <div
                                key={step.text}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 11,
                                  opacity: sr,
                                  transform: `translateY(${((1 - sr) * 8).toFixed(2)}px)`,
                                }}
                              >
                                <span
                                  style={{
                                    width: 13,
                                    height: 13,
                                    borderRadius: 4,
                                    flexShrink: 0,
                                    boxSizing: "border-box",
                                    border: `1.5px solid ${step.done ? C.success : mix(C.border, C.surface, 0.9)}`,
                                    background: step.done
                                      ? alpha(C.success, 0.22)
                                      : "transparent",
                                  }}
                                />
                                <span
                                  style={{
                                    fontFamily: MONO,
                                    fontSize: 17,
                                    color: step.done ? C.textDim : C.text,
                                    textDecoration: step.done
                                      ? "line-through"
                                      : undefined,
                                  }}
                                >
                                  {step.text}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </Region>
              </div>
            </WindowChrome>
          </AbsoluteFill>
        </ParallaxLayer>

        {/* ── Legendas (1.2×): o plano mais próximo da câmera. */}
        <ParallaxLayer depth={1.2}>
          <AbsoluteFill
            style={{
              alignItems: "center",
              justifyContent: "flex-end",
              paddingBottom: 62,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 76,
                height: 42,
              }}
            >
              {labels.map((text, i) => {
                // A legenda já superada recua para 42% — um único nível de
                // destaque por frame. Opacidade pode ser linear.
                const next = beats[i + 1];
                const dim =
                  next === undefined
                    ? 1
                    : interpolate(frame, [next, next + 8], [1, 0.42], {
                        extrapolateLeft: "clamp",
                        extrapolateRight: "clamp",
                      });
                return (
                  <div
                    key={text}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 14,
                      opacity: dim,
                    }}
                  >
                    <span
                      style={{
                        width: 2,
                        height: 20,
                        background: C.accent,
                        opacity: litOf(i),
                      }}
                    />
                    <StaggerText
                      text={text.toUpperCase()}
                      by="char"
                      stagger={0.6}
                      delay={beats[i]}
                      preset="entrada"
                      y={16}
                      blur={6}
                      style={{
                        fontFamily: MONO,
                        fontSize: 26,
                        fontWeight: 400,
                        letterSpacing: "0.18em",
                        color: C.text,
                        whiteSpace: "nowrap",
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </AbsoluteFill>
        </ParallaxLayer>
      </Parallax>
    </AbsoluteFill>
  );
};
