import type {CSSProperties, ReactNode} from 'react'
import {useSpringPreset, type SpringPresetName} from './springs'

export interface BlurInProps {
  children: ReactNode
  /** Frames de atraso. */
  delay?: number
  preset?: SpringPresetName
  /** Blur inicial em px. Some totalmente ao fim. */
  blur?: number
  /** Escala inicial. <1 entra crescendo, >1 entra recuando. */
  scale?: number
  /** Deslocamento vertical inicial em px. */
  y?: number
  durationInFrames?: number
  style?: CSSProperties
}

/**
 * Entrada padrao do video: blur + escala + opacidade na mesma mola.
 * O blur e o que separa "aparece" de "materializa" — sem ele a entrada le como
 * fade generico.
 */
export const BlurIn: React.FC<BlurInProps> = ({
  children,
  delay = 0,
  preset = 'entrada',
  blur = 14,
  scale = 0.94,
  y = 0,
  durationInFrames,
  style,
}) => {
  const progress = useSpringPreset({preset, delay, durationInFrames})
  const remaining = 1 - progress

  return (
    <div
      style={{
        opacity: progress,
        filter: remaining > 0.001 ? `blur(${(blur * remaining).toFixed(2)}px)` : undefined,
        transform: `translateY(${(y * remaining).toFixed(2)}px) scale(${(scale + (1 - scale) * progress).toFixed(4)})`,
        willChange: 'transform, filter, opacity',
        ...style,
      }}
    >
      {children}
    </div>
  )
}
