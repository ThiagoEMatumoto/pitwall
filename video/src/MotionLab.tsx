import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion'
import {FONT_DISPLAY, FONT_MONO} from './fonts'
import {alpha, vacuo} from './theme'
import {Logo} from './ui/Logo'
import {
  BlurIn,
  DrawPath,
  Grain,
  KineticHeadline,
  Parallax,
  ParallaxLayer,
  SPRING_PRESETS,
  StaggerText,
  Vignette,
  springAt,
  useSpringPreset,
} from './motion'

// Tracado do circuito reaproveitado da intro do app (Splash.tsx), reescalado
// pro viewBox de 1920x1080 usado aqui.
const TRACK_PATH =
  'M 320 640 C 250 400 520 250 760 300 C 940 337 1010 190 1200 220 ' +
  'C 1470 262 1640 420 1600 640 C 1570 800 1330 790 1160 855 ' +
  'C 990 920 900 1000 700 975 C 510 950 440 880 400 800 Z'

const PRESET_NAMES = Object.keys(SPRING_PRESETS) as (keyof typeof SPRING_PRESETS)[]

const Card: React.FC<{title: string; body: string; delay: number}> = ({title, body, delay}) => (
  <BlurIn delay={delay} blur={16} scale={0.92} y={22}>
    <div
      style={{
        width: 300,
        padding: '22px 24px',
        borderRadius: 16,
        background: vacuo.surface,
        border: `1px solid ${vacuo.border}`,
        boxShadow: `0 18px 60px ${alpha('#000000', 0.55)}`,
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 13,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: vacuo.accent2,
        }}
      >
        {title}
      </div>
      <div style={{fontFamily: FONT_DISPLAY, fontSize: 22, color: vacuo.text, marginTop: 10}}>
        {body}
      </div>
    </div>
  </BlurIn>
)

/** Quatro barras andando a mesma distancia com molas diferentes. */
const SpringRuler: React.FC = () => {
  const frame = useCurrentFrame()
  const {fps} = useVideoConfig()

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
      {PRESET_NAMES.map((preset, i) => {
        const travel = springAt(frame, fps, {preset, delay: 34 + i * 4, from: 0, to: 220})
        return (
          <div key={preset} style={{display: 'flex', alignItems: 'center', gap: 16}}>
            <div
              style={{
                width: 96,
                fontFamily: FONT_MONO,
                fontSize: 13,
                color: vacuo['text-dim'],
                letterSpacing: '0.08em',
              }}
            >
              {preset}
            </div>
            <div
              style={{
                position: 'relative',
                width: 260,
                height: 6,
                borderRadius: 3,
                background: vacuo['surface-2'],
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: travel,
                  top: -5,
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  background: vacuo.accent,
                  boxShadow: `0 0 16px ${alpha(vacuo.accent, 0.6)}`,
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Banco de provas das primitivas de motion. Nao entra no video final: existe
 * pra que uma unica still mostre logo, tipografia, molas, draw, parallax e
 * acabamento juntos — e quebre se qualquer um deles regredir.
 */
export const MotionLab: React.FC = () => {
  const frame = useCurrentFrame()

  const logoBarsLeft = useSpringPreset({preset: 'entrada', delay: 0})
  const logoBarsRight = useSpringPreset({preset: 'entrada', delay: 4})
  const apex = useSpringPreset({preset: 'impacto', delay: 12})
  const gradientSweep = interpolate(frame, [16, 76], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })

  const driftX = interpolate(frame, [0, 300], [46, -46])
  const driftY = interpolate(frame, [0, 300], [-18, 18])

  return (
    <AbsoluteFill style={{backgroundColor: vacuo.bg}}>
      <Parallax x={driftX} y={driftY}>
        {/* Fundo distante: clarao do apice. */}
        <ParallaxLayer depth={0.15} scale={1.08}>
          <AbsoluteFill
            style={{
              background: `radial-gradient(48% 46% at 52% 40%, ${alpha(vacuo.accent, 0.16)}, transparent 70%)`,
            }}
          />
        </ParallaxLayer>

        {/* Meio: o circuito se desenhando. */}
        <ParallaxLayer depth={0.45}>
          <svg viewBox="0 0 1920 1080" width="100%" height="100%">
            <DrawPath
              d={TRACK_PATH}
              delay={6}
              durationInFrames={72}
              stroke={vacuo.accent2}
              strokeWidth={2.5}
              opacity={0.4}
            />
          </svg>
        </ParallaxLayer>

        {/* Primeiro plano: conteudo. */}
        <ParallaxLayer depth={1}>
          <AbsoluteFill
            style={{
              padding: '96px 120px',
              justifyContent: 'center',
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 28}}>
              <Logo
                size={104}
                leftBarProgress={logoBarsLeft}
                rightBarProgress={logoBarsRight}
                circleScale={apex}
                circleOpacity={apex}
                gradientProgress={gradientSweep}
                glow={apex}
              />
              <KineticHeadline delay={16} fontSize={128} color={vacuo.text}>
                Pitwall
              </KineticHeadline>
            </div>

            <div style={{marginTop: 26, maxWidth: 1080}}>
              <StaggerText
                text="O muro de boxes das suas sessões de Claude Code."
                by="word"
                delay={30}
                stagger={2}
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontSize: 40,
                  fontWeight: 500,
                  color: vacuo['text-dim'],
                }}
              />
            </div>

            <div style={{marginTop: 18}}>
              <StaggerText
                text="MOTION LAB · VACUO · 1920x1080 @ 30FPS"
                by="char"
                delay={40}
                stagger={0.8}
                y={10}
                blur={4}
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 17,
                  letterSpacing: '0.24em',
                  color: vacuo.accent2,
                }}
              />
            </div>

            <div style={{display: 'flex', gap: 24, marginTop: 56}}>
              <Card title="blur in" body="Materializa, não aparece." delay={34} />
              <Card title="stagger" body="Ritmo por palavra." delay={39} />
              <Card title="parallax" body="Profundidade por camada." delay={44} />
            </div>

            <div style={{marginTop: 56}}>
              <SpringRuler />
            </div>
          </AbsoluteFill>
        </ParallaxLayer>
      </Parallax>

      <Vignette />
      <Grain />
    </AbsoluteFill>
  )
}
