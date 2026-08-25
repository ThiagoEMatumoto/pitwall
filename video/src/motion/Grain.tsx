import {useId} from 'react'
import {AbsoluteFill, useCurrentFrame} from 'remotion'

export interface GrainProps {
  /** 0..1. Acima de ~0.06 vira textura consciente em vez de acabamento. */
  opacity?: number
  /** Frequencia do ruido. Maior = grao mais fino. */
  frequency?: number
  /** Troca a semente a cada frame (grao vivo). false congela o grao. */
  animate?: boolean
  blendMode?: 'overlay' | 'soft-light' | 'screen'
}

/**
 * Grao de filme por feTurbulence.
 *
 * Existe pra tirar o "liso digital" de gradientes grandes em fundo escuro — a
 * banding de gradiente e o que mais entrega render barato em 1080p. Sutil por
 * contrato: se da pra notar conscientemente, esta forte demais.
 */
export const Grain: React.FC<GrainProps> = ({
  opacity = 0.035,
  frequency = 0.85,
  animate = true,
  blendMode = 'overlay',
}) => {
  const frame = useCurrentFrame()
  const filterId = `pw-grain-${useId().replace(/[:]/g, '')}`
  const seed = animate ? frame % 100 : 1

  return (
    <AbsoluteFill style={{pointerEvents: 'none', opacity, mixBlendMode: blendMode}}>
      <svg width="100%" height="100%">
        <filter id={filterId} x="0" y="0" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency={frequency}
            numOctaves={3}
            seed={seed}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${filterId})`} />
      </svg>
    </AbsoluteFill>
  )
}
