import type {CSSProperties} from 'react'
import {useCurrentFrame, useVideoConfig} from 'remotion'
import {springAt, stagger, type SpringPresetName} from './springs'

export interface StaggerTextProps {
  text: string
  /** Unidade de entrada. 'word' e mais legivel em headline; 'char' e mais tecnico. */
  by?: 'char' | 'word'
  /** Frames entre uma unidade e a seguinte. */
  stagger?: number
  delay?: number
  preset?: SpringPresetName
  /** Deslocamento vertical inicial de cada unidade, em px. */
  y?: number
  /** Blur inicial por unidade, em px. 0 desliga. */
  blur?: number
  /** Escala inicial por unidade. */
  scale?: number
  style?: CSSProperties
}

const splitText = (text: string, by: 'char' | 'word'): string[] =>
  by === 'char' ? Array.from(text) : text.split(/(\s+)/).filter((t) => t.length > 0)

const isBlank = (token: string) => token.trim().length === 0

/**
 * Texto que entra unidade a unidade com atraso escalonado.
 *
 * Espacos NAO consomem indice: senao a cadencia muda conforme o comprimento das
 * palavras e a frase perde ritmo. whiteSpace 'pre' preserva a largura real dos
 * espacos (sem isso, palavras colam ao virar inline-block).
 */
export const StaggerText: React.FC<StaggerTextProps> = ({
  text,
  by = 'word',
  stagger: step = 2,
  delay = 0,
  preset = 'entrada',
  y = 18,
  blur = 8,
  scale = 1,
  style,
}) => {
  const frame = useCurrentFrame()
  const {fps} = useVideoConfig()
  const tokens = splitText(text, by)

  let unitIndex = 0

  return (
    <span style={{display: 'inline-block', whiteSpace: 'pre-wrap', ...style}}>
      {tokens.map((token, i) => {
        if (isBlank(token)) {
          return (
            <span key={`${token}-${i}`} style={{whiteSpace: 'pre'}}>
              {token}
            </span>
          )
        }

        const progress = springAt(frame, fps, {
          preset,
          delay: stagger(unitIndex, step, delay),
        })
        unitIndex += 1
        const remaining = 1 - progress

        return (
          <span
            key={`${token}-${i}`}
            style={{
              display: 'inline-block',
              opacity: progress,
              filter: blur > 0 && remaining > 0.001 ? `blur(${(blur * remaining).toFixed(2)}px)` : undefined,
              transform: `translateY(${(y * remaining).toFixed(2)}px) scale(${(scale + (1 - scale) * progress).toFixed(4)})`,
              willChange: 'transform, filter, opacity',
            }}
          >
            {token}
          </span>
        )
      })}
    </span>
  )
}
