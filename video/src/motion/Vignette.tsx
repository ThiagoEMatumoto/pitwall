import {AbsoluteFill} from 'remotion'

export interface VignetteProps {
  /** Opacidade do escurecimento nas bordas. */
  strength?: number
  /** Raio (em % do quadro) onde o escurecimento comeca. */
  innerRadius?: number
  /** Centro do clarao, em % do quadro. */
  centerX?: number
  centerY?: number
  color?: string
}

/**
 * Vinheta por radial-gradient — puxa o olho pro centro do quadro.
 *
 * Sutil por contrato: a vinheta deve ser sentida na composicao, nunca vista
 * como anel. Default calibrado pro bg #08080B do Vacuo.
 */
export const Vignette: React.FC<VignetteProps> = ({
  strength = 0.55,
  innerRadius = 45,
  centerX = 50,
  centerY = 48,
  color = '#000000',
}) => (
  <AbsoluteFill
    style={{
      pointerEvents: 'none',
      background: `radial-gradient(75% 75% at ${centerX}% ${centerY}%, transparent ${innerRadius}%, ${color} 130%)`,
      opacity: strength,
    }}
  />
)
