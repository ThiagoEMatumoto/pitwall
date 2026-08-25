import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  Sequence,
  Series,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { getSceneTimings, type SceneTiming } from "./audio-manifest";
import type { Locale } from "./config";
import { Grain, Vignette } from "./motion";
import { Cockpit } from "./scenes/Cockpit";
import { ColdOpen } from "./scenes/ColdOpen";
import { CrewDock } from "./scenes/CrewDock";
import { Diagrams } from "./scenes/Diagrams";
import { Handoff } from "./scenes/Handoff";
import { LogoScene } from "./scenes/LogoScene";
import { Outro } from "./scenes/Outro";
import { Voice } from "./scenes/Voice";
import { tokens } from "./theme";

// Type alias, nao interface: o generic Props do <Composition> exige compatibilidade
// com Record<string, unknown>, que interfaces nao satisfazem (sem index signature).
export type PromoProps = {
  locale: Locale;
  /**
   * Desliga a cama de trilha. O mix final e feito no pos com sidechain (o
   * Remotion nao faz ducking), e o compressor precisa da narracao+SFX limpos
   * como um stem separado da musica. Este e o unico jeito de tirar esse stem
   * do proprio filme em vez de reconstruir os cues na mao.
   */
  music?: boolean;
};

type SceneComponent = React.FC<{ durationInFrames: number; locale: Locale }>;

const SCENES: Record<string, SceneComponent> = {
  "cold-open": ColdOpen,
  logo: LogoScene,
  cockpit: Cockpit,
  voice: Voice,
  diagrams: Diagrams,
  handoff: Handoff,
  "crew-dock": CrewDock,
  outro: Outro,
};

/**
 * Sobreposicao de entrada por cena, em frames. Default 0 = corte seco (a direcao
 * de arte pede corte seco em ~70% dos cortes). Onde ha sobreposicao, a transicao
 * e o "scale-through + blur": A sai escalando 1->1.06 com blur 0->8px enquanto B
 * entra 0.96->1 com blur 6->0.
 *
 * Sao dois cortes no filme inteiro, os dois com movimento real por baixo: o shell
 * do cockpit virando a cena de voz, e o handoff recolhendo pro Crew Dock.
 */
const CROSS_IN: Record<string, number> = {
  voice: 12,
  "crew-dock": 12,
};

/** Entrada de elemento — emphasized-decel: chega rapido e assenta. */
const EASE_IN = Easing.bezier(0.05, 0.7, 0.1, 1);
/**
 * Camada que JA esta em tela e e empurrada pra fora. Nao e a curva de "saida"
 * pura (0.3,0,0.8,0.15): aquela e tao chapada no comeco que a camada A so
 * comecava a escalar e borrar depois que B ja tinha tapado tudo — e o corte
 * lia como cross-dissolve, que a direcao de arte nao permite.
 */
const EASE_PUSH = Easing.bezier(0.2, 0, 0, 1);

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Duracao real da composicao: soma das cenas menos o que as sobreposicoes comem. */
export const promoDurationInFrames = (locale: Locale): number => {
  const scenes = getSceneTimings(locale);
  const overlap = scenes.reduce(
    (total, scene) => total + (CROSS_IN[scene.id] ?? 0),
    0,
  );
  return (
    scenes.reduce((total, scene) => total + scene.durationInFrames, 0) - overlap
  );
};

/** Frame absoluto em que cada cena entra, ja descontadas as sobreposicoes. */
const absoluteStarts = (scenes: SceneTiming[]): Record<string, number> => {
  const starts: Record<string, number> = {};
  let cursor = 0;
  for (const scene of scenes) {
    cursor -= CROSS_IN[scene.id] ?? 0;
    starts[scene.id] = cursor;
    cursor += scene.durationInFrames;
  }
  return starts;
};

/**
 * Palco de uma cena. So existe quando ha transicao com sobreposicao — no corte
 * seco a cena e renderizada direto, sem wrapper, pra nao pagar containing block
 * nem filtro a toa.
 */
const SceneStage: React.FC<{
  durationInFrames: number;
  crossIn: number;
  crossOut: number;
  children: React.ReactNode;
}> = ({ durationInFrames, crossIn, crossOut, children }) => {
  const frame = useCurrentFrame();

  // Relogio linear de cada ponta da sobreposicao.
  const inP = crossIn ? clamp01(frame / crossIn) : 1;
  const outP = crossOut
    ? clamp01((frame - (durationInFrames - crossOut)) / crossOut)
    : 0;

  // Escala sempre por curva (linear em posicao/escala e proibido).
  const enter = crossIn ? EASE_IN(inP) : 1;
  const exit = crossOut ? EASE_PUSH(outP) : 0;
  const scale = 0.96 + enter * 0.04 + exit * 0.06;

  // O blur anda no relogio linear, de proposito: e o que mantem o desfoque
  // ATRELADO a opacidade. Se ele resolvesse antes (curva de entrada) ou depois
  // (curva de saida), o meio da sobreposicao teria duas camadas nitidas em
  // opacidades diferentes — a definicao de cross-dissolve.
  const blur = (1 - inP) * 6 + outP * 8;

  // Opacidade linear (a direcao de arte so permite linear em opacidade/cor).
  const opacity = inP;

  return (
    <AbsoluteFill
      style={{
        transform: `scale(${scale})`,
        filter: blur > 0.01 ? `blur(${blur}px)` : undefined,
        opacity,
        backgroundColor: tokens.bg,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/**
 * Cama, nao trilha. O ducking real e sidechain, que o Remotion nao faz: no pos
 * a musica leva -8,8dB e um sidechaincompress com a narracao na cadeia lateral
 * (threshold 0.03, ratio 6, attack 20ms, release 350ms), o que deixa a cama 9dB
 * mais baixa sob a voz do que nos intervalos. Este volume aqui e o meio-termo
 * que faz o preview do Studio soar como o filme; as pontas sao de montagem.
 */
const MUSIC_VOLUME = 0.2;
const MUSIC_FADE_IN = 30;
const MUSIC_FADE_OUT = 45;

const musicVolume = (total: number) => (frame: number) =>
  interpolate(
    frame,
    [0, MUSIC_FADE_IN, total - MUSIC_FADE_OUT, total - 1],
    [0, MUSIC_VOLUME, MUSIC_VOLUME, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

type Sfx = {
  key: string;
  file: "whoosh" | "tick" | "sub-hit" | "riser";
  at: number;
  durationInFrames: number;
  volume: number | ((frame: number) => number);
};

const SFX_LENGTH = { whoosh: 27, tick: 3, "sub-hit": 21, riser: 33 } as const;

/**
 * Textura, nao trilha: os SFX ficam ~15dB abaixo da narracao. Se um deles
 * chamar atencao pra si, esta alto demais.
 */
const buildSfx = (starts: Record<string, number>, total: number): Sfx[] => {
  const cue = (
    key: string,
    file: Sfx["file"],
    at: number,
    volume: Sfx["volume"],
  ): Sfx => ({
    key,
    file,
    at: Math.max(0, Math.round(at)),
    durationInFrames: SFX_LENGTH[file],
    volume,
  });

  return [
    // Saturacao do cold-open descarregando no corte.
    cue("whoosh-cold", "whoosh", starts.logo - 14, (f) =>
      interpolate(f, [0, 8, 26], [0.06, 0.17, 0], {
        extrapolateRight: "clamp",
      }),
    ),
    // Impacto do lockup: as barras do Apice assentam.
    cue("hit-logo", "sub-hit", starts.logo + 8, 0.3),
    // O shell se monta por camadas — movimento lateral.
    cue("whoosh-cockpit", "whoosh", starts.cockpit - 8, 0.14),
    // Scale-through pro composer.
    cue("whoosh-voice", "whoosh", starts.voice - 6, 0.13),
    // Corte seco pro plano longo dos diagramas: so o tick.
    cue("tick-diagrams", "tick", starts.diagrams, 0.24),
    // Os tres feixes saindo do no-mae.
    cue("whoosh-handoff", "whoosh", starts.handoff - 8, 0.15),
    // Zoom out pra trilha do Crew Dock.
    cue("whoosh-crew", "whoosh", starts["crew-dock"] - 6, 0.13),
    // Riser aterrissando exatamente no primeiro frame do outro.
    cue("riser-outro", "riser", starts.outro - SFX_LENGTH.riser, (f) =>
      interpolate(f, [0, 30, 33], [0, 0.16, 0.05], {
        extrapolateRight: "clamp",
      }),
    ),
    // Tudo recolhe pro Apice.
    cue("hit-outro", "sub-hit", starts.outro + 2, 0.26),
    // Guarda de sanidade: nada pode nascer depois do fim do filme.
  ].filter((sfx) => sfx.at < total);
};

/**
 * Acabamento global. Grao e vinheta vivem AQUI, uma vez, por cima de tudo — as
 * cenas nao carregam os seus (dobrar o grao levaria os 3-5% do contrato pra 7%+,
 * e a vinheta viraria tunel). A dramaturgia que estava nas pontas — o ruido
 * subindo no cold-open, o quadro fechando no outro — continua, so que dirigida
 * pelo frame absoluto do filme.
 */
const Finish: React.FC<{ starts: Record<string, number>; total: number }> = ({
  starts,
  total,
}) => {
  const frame = useCurrentFrame();

  const cut = starts.logo;
  const outroAt = starts.outro;
  const outroMid = outroAt + (total - outroAt) * 0.7;

  const range = [0, cut - 2, cut, outroAt, outroMid, total];
  const opts = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

  const strength = interpolate(
    frame,
    range,
    [0.5, 0.72, 0.5, 0.5, 0.7, 0.92],
    opts,
  );
  const grain = interpolate(
    frame,
    range,
    [0.03, 0.055, 0.035, 0.035, 0.045, 0.045],
    opts,
  );
  const innerRadius = interpolate(frame, range, [40, 38, 45, 45, 42, 36], opts);

  return (
    <>
      <Vignette strength={strength} innerRadius={innerRadius} />
      <Grain opacity={grain} />
    </>
  );
};

export const Promo: React.FC<PromoProps> = ({ locale, music = true }) => {
  const scenes = getSceneTimings(locale);
  const starts = absoluteStarts(scenes);
  const total = promoDurationInFrames(locale);

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.bg }}>
      <Series>
        {scenes.map((scene, index) => {
          const Scene = SCENES[scene.id];
          const crossIn = CROSS_IN[scene.id] ?? 0;
          const next = scenes[index + 1];
          const crossOut = next ? (CROSS_IN[next.id] ?? 0) : 0;
          const staged = crossIn > 0 || crossOut > 0;

          const body = (
            <>
              <Scene
                durationInFrames={scene.durationInFrames}
                locale={locale}
              />
              {scene.audioSrc ? (
                <Sequence from={scene.padStartInFrames} name={`vo-${scene.id}`}>
                  <Audio src={staticFile(scene.audioSrc)} volume={1} />
                </Sequence>
              ) : null}
            </>
          );

          return (
            <Series.Sequence
              key={scene.id}
              durationInFrames={scene.durationInFrames}
              offset={-crossIn}
              name={scene.id}
            >
              {staged ? (
                <SceneStage
                  durationInFrames={scene.durationInFrames}
                  crossIn={crossIn}
                  crossOut={crossOut}
                >
                  {body}
                </SceneStage>
              ) : (
                body
              )}
            </Series.Sequence>
          );
        })}
      </Series>

      {music ? (
        <Audio
          src={staticFile(`audio/music/${locale}.mp3`)}
          volume={musicVolume(total)}
          name="music"
        />
      ) : null}

      {buildSfx(starts, total).map((sfx) => (
        <Sequence
          key={sfx.key}
          from={sfx.at}
          durationInFrames={sfx.durationInFrames}
          name={`sfx-${sfx.key}`}
        >
          <Audio
            src={staticFile(`audio/sfx/${sfx.file}.wav`)}
            volume={sfx.volume}
          />
        </Sequence>
      ))}

      <Finish starts={starts} total={total} />
    </AbsoluteFill>
  );
};
