import {createContext, useContext, type CSSProperties, type ReactNode} from 'react'

interface ParallaxTravel {
  x: number
  y: number
}

// Contexto local do modulo (nao estado global mutavel): o container publica UM
// deslocamento base e cada camada o multiplica pela propria profundidade.
const ParallaxContext = createContext<ParallaxTravel>({x: 0, y: 0})

export interface ParallaxProps {
  children: ReactNode
  /** Deslocamento base em px. A camada de depth=1 anda exatamente isto. */
  x?: number
  y?: number
  style?: CSSProperties
}

export const Parallax: React.FC<ParallaxProps> = ({children, x = 0, y = 0, style}) => (
  <ParallaxContext.Provider value={{x, y}}>
    <div style={{position: 'absolute', inset: 0, ...style}}>{children}</div>
  </ParallaxContext.Provider>
)

export interface ParallaxLayerProps {
  children: ReactNode
  /**
   * Profundidade. 0 = colado no fundo (nao anda), 1 = anda o deslocamento
   * base, >1 = primeiro plano (anda mais que a camera).
   */
  depth: number
  /** Escala opcional por camada — reforca a profundidade sem mexer no z. */
  scale?: number
  /** Sobrescreve o deslocamento do container (uso avulso, fora de <Parallax>). */
  travelX?: number
  travelY?: number
  style?: CSSProperties
}

export const ParallaxLayer: React.FC<ParallaxLayerProps> = ({
  children,
  depth,
  scale = 1,
  travelX,
  travelY,
  style,
}) => {
  const base = useContext(ParallaxContext)
  const dx = (travelX ?? base.x) * depth
  const dy = (travelY ?? base.y) * depth

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        transform: `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) scale(${scale})`,
        willChange: 'transform',
        ...style,
      }}
    >
      {children}
    </div>
  )
}
