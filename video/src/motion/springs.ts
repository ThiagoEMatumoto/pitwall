import {spring, useCurrentFrame, useVideoConfig} from 'remotion'

/**
 * Vocabulario de molas do Pitwall. Quatro intencoes, nao quatro numeros
 * aleatorios — quem escreve cena escolhe a INTENCAO e nunca digita config.
 */
export const SPRING_PRESETS = {
  /** Entra na tela: sobe decidido e assenta com um respiro minimo de overshoot. */
  entrada: {mass: 0.6, damping: 22, stiffness: 110},
  /** Sai de cena: seco e rapido, sem eco. */
  saida: {mass: 0.4, damping: 26, stiffness: 180},
  /** Bate: overshoot visivel, o unico preset que "quica". Usar com parcimonia. */
  impacto: {mass: 1.2, damping: 11, stiffness: 220},
  /** Assenta: damping alto, chega no valor e para. Zero overshoot, por construcao. */
  assentar: {mass: 1, damping: 200, stiffness: 140},
} as const

export type SpringPresetName = keyof typeof SPRING_PRESETS

export interface SpringOptions {
  preset?: SpringPresetName
  /** Frames de atraso antes de a mola comecar. */
  delay?: number
  from?: number
  to?: number
  /** Comprime/estica a mola inteira pra caber em N frames. */
  durationInFrames?: number
  reverse?: boolean
}

/** Versao pura: util quando o frame vem de fora (loops, .map de indices). */
export const springAt = (
  frame: number,
  fps: number,
  {preset = 'entrada', delay = 0, from = 0, to = 1, durationInFrames, reverse}: SpringOptions = {},
): number =>
  spring({
    frame,
    fps,
    config: SPRING_PRESETS[preset],
    from,
    to,
    delay,
    durationInFrames,
    reverse,
  })

/** Versao hook: o caso comum dentro de um componente de cena. */
export const useSpringPreset = (options: SpringOptions = {}): number => {
  const frame = useCurrentFrame()
  const {fps} = useVideoConfig()
  return springAt(frame, fps, options)
}

/** Atraso escalonado por indice. Existe pra nao espalhar `i * 3` pelas cenas. */
export const stagger = (index: number, stepInFrames: number, baseDelay = 0): number =>
  baseDelay + index * stepInFrames
