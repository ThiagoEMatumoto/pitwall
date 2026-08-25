import type {CSSProperties} from 'react'
import {interpolate} from 'remotion'
import {FONT_DISPLAY, snapDisplayWeight} from '../fonts'
import {useSpringPreset, type SpringPresetName} from './springs'

export interface KineticHeadlineProps {
  children: string
  /** px. Headline de video quer numero grande — 96+ e o normal em 1080p. */
  fontSize?: number
  color?: string
  delay?: number
  preset?: SpringPresetName
  /** letter-spacing inicial em em (aberto) -> final (fechado). */
  trackingFrom?: number
  trackingTo?: number
  /** Peso inicial -> final. Ancorados nas faces reais (ver snapDisplayWeight). */
  weightFrom?: number
  weightTo?: number
  /** Opacidade inicial. */
  opacityFrom?: number
  style?: CSSProperties
}

/**
 * Headline que "ganha peso": o texto entra aberto e leve e fecha o tracking
 * enquanto engrossa. E o gesto que da autoridade a um titulo sem mover a caixa.
 *
 * O peso salta entre as faces estaticas instaladas em vez de interpolar
 * continuo — Schibsted aqui nao e variavel, e bold sintetico deforma a letra.
 */
export const KineticHeadline: React.FC<KineticHeadlineProps> = ({
  children,
  fontSize = 112,
  color,
  delay = 0,
  preset = 'assentar',
  trackingFrom = 0.16,
  trackingTo = -0.035,
  weightFrom = 400,
  weightTo = 800,
  opacityFrom = 0,
  style,
}) => {
  const progress = useSpringPreset({preset, delay})

  const tracking = interpolate(progress, [0, 1], [trackingFrom, trackingTo])
  const weight = snapDisplayWeight(interpolate(progress, [0, 1], [weightFrom, weightTo]))
  const opacity = interpolate(progress, [0, 1], [opacityFrom, 1])

  return (
    <div
      style={{
        fontFamily: FONT_DISPLAY,
        fontSize,
        fontWeight: weight,
        letterSpacing: `${tracking.toFixed(4)}em`,
        lineHeight: 1.02,
        color,
        opacity,
        willChange: 'letter-spacing, font-weight, opacity',
        ...style,
      }}
    >
      {children}
    </div>
  )
}
