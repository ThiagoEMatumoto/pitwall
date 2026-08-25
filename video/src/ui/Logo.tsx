import {useId, type CSSProperties} from 'react'
import {BRAND, alpha} from '../theme'

/**
 * "O Apice" — porte a mao de src/assets/pitwall-logo.svg (viewBox 44x44): duas
 * barras do muro de boxes + o ponto de apice com gradiente ciano->roxo.
 *
 * SVG inline de proposito (nao <Img>): cada peca precisa ser animavel
 * separadamente. Todas as props sao progressos 0..1 puros — quem decide a
 * curva (spring, interpolate) e a cena, nao o logo.
 */
export interface LogoProps {
  /** Lado do quadrado em px. O viewBox e 44x44. */
  size?: number
  /** 0 = barra esquerda invisivel, 1 = comprimento cheio. Cresce da borda externa pro centro. */
  leftBarProgress?: number
  /** Idem, espelhado: cresce da direita pro centro. */
  rightBarProgress?: number
  /** Escala do circulo do apice (1 = tamanho nominal, r=3.4). */
  circleScale?: number
  circleOpacity?: number
  /** 0 = apice todo roxo; 1 = todo ciano. A banda do gradiente varre no meio. */
  gradientProgress?: number
  /** Halo em volta do apice (0..1). Sutil de proposito. */
  glow?: number
  /** Cor das barras. Default = branco-lilas do logo original. */
  barColor?: string
  style?: CSSProperties
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

const BAR_LENGTH = 11.5
const BAR_LEFT_X = 4
const BAR_RIGHT_END = 40
const BAR_Y = 19.5
const BAR_HEIGHT = 5
const APEX_R = 3.4

export const Logo: React.FC<LogoProps> = ({
  size = 44,
  leftBarProgress = 1,
  rightBarProgress = 1,
  circleScale = 1,
  circleOpacity = 1,
  gradientProgress = 1,
  glow = 0,
  barColor = BRAND.bar,
  style,
}) => {
  // useId: varios logos na mesma tela nao podem compartilhar o id do gradiente.
  const gradientId = `pw-apex-${useId().replace(/[:]/g, '')}`

  const left = clamp01(leftBarProgress)
  const right = clamp01(rightBarProgress)
  const p = clamp01(gradientProgress)

  const leftWidth = BAR_LENGTH * left
  const rightWidth = BAR_LENGTH * right

  // Banda de 0.6 de largura varrendo o gradiente: antes dela fica accent2,
  // depois accent. p=0 -> tudo accent (roxo); p=1 -> tudo accent2 (ciano).
  const stopA = clamp01(p * 1.6 - 0.6)
  const stopB = clamp01(p * 1.6)

  return (
    <svg
      viewBox="0 0 44 44"
      width={size}
      height={size}
      style={{display: 'block', overflow: 'visible', ...style}}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset={stopA} stopColor={BRAND.apexFrom} />
          <stop offset={stopB} stopColor={BRAND.apexTo} />
        </linearGradient>
      </defs>

      {leftWidth > 0 ? (
        <rect
          x={BAR_LEFT_X}
          y={BAR_Y}
          width={leftWidth}
          height={BAR_HEIGHT}
          rx={BAR_HEIGHT / 2}
          fill={barColor}
        />
      ) : null}

      {rightWidth > 0 ? (
        <rect
          x={BAR_RIGHT_END - rightWidth}
          y={BAR_Y}
          width={rightWidth}
          height={BAR_HEIGHT}
          rx={BAR_HEIGHT / 2}
          fill={barColor}
        />
      ) : null}

      <circle
        cx={22}
        cy={22}
        r={APEX_R * Math.max(0, circleScale)}
        fill={`url(#${gradientId})`}
        opacity={clamp01(circleOpacity)}
        style={
          glow > 0
            ? {filter: `drop-shadow(0 0 ${glow * 6}px ${alpha(BRAND.apexTo, 0.75 * clamp01(glow))})`}
            : undefined
        }
      />
    </svg>
  )
}
