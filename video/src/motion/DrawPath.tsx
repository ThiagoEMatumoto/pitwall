import type {CSSProperties} from 'react'
import {useSpringPreset, type SpringPresetName} from './springs'

export interface DrawPathProps {
  /** O `d` do path. */
  d: string
  /** Progresso manual 0..1. Se omitido, usa a mola de delay/preset. */
  progress?: number
  delay?: number
  preset?: SpringPresetName
  durationInFrames?: number
  stroke?: string
  strokeWidth?: number
  strokeLinecap?: 'butt' | 'round' | 'square'
  fill?: string
  opacity?: number
  style?: CSSProperties
}

/**
 * Desenha um <path> por stroke-dasharray/dashoffset.
 *
 * `pathLength={1}` normaliza o comprimento real do traco pra 1, entao o dash
 * nao depende de medir o path em runtime — o motivo de isto funcionar igual em
 * qualquer curva sem getTotalLength().
 *
 * Renderiza SO o <path>: precisa estar dentro de um <svg> do chamador (que e
 * quem sabe o viewBox certo).
 */
export const DrawPath: React.FC<DrawPathProps> = ({
  d,
  progress,
  delay = 0,
  preset = 'assentar',
  durationInFrames,
  stroke = 'currentColor',
  strokeWidth = 2,
  strokeLinecap = 'round',
  fill = 'none',
  opacity = 1,
  style,
}) => {
  const spring = useSpringPreset({preset, delay, durationInFrames})
  const p = Math.max(0, Math.min(1, progress ?? spring))

  return (
    <path
      d={d}
      pathLength={1}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap={strokeLinecap}
      strokeDasharray={1}
      strokeDashoffset={1 - p}
      opacity={opacity}
      style={style}
    />
  )
}
