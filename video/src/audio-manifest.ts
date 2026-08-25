import manifest from '../content/audio-manifest.json'
import type {Locale} from './config'

// Ponte entre o manifesto gerado por scripts/tts.mjs e o Remotion. Sem I/O e
// sincrono de proposito: e chamado de dentro do calculateMetadata, que precisa
// devolver a duracao da composicao sem esperar nada.
//
// O fps vem do manifesto, nao de config.ts: o manifesto e quem conhece a grade
// em que as duracoes medidas foram convertidas em frames.

export const MANIFEST_FPS = manifest.fps

export interface SceneTiming {
  id: string
  /** padStart + narracao + padEnd, ja em frames */
  durationInFrames: number
  /** frame absoluto em que a cena comeca na timeline do locale */
  fromFrame: number
  /** silencio antes da narracao — offset do <Audio> dentro da cena */
  padStartInFrames: number
  /** caminho relativo a public/, pronto para staticFile(); null enquanto o mp3 nao existe */
  audioSrc: string | null
}

const toFrames = (seconds: number) => Math.round(seconds * MANIFEST_FPS)

/**
 * Cenas do locale na ordem do roteiro, com duracao e offset ja acumulados.
 * Enquanto `audioSrc` for null a duracao e o alvo do roteiro, nao a medida do
 * audio — o video monta e da pra dirigir, so nao esta travado na narracao.
 */
export const getSceneTimings = (locale: Locale): SceneTiming[] => {
  let fromFrame = 0
  return manifest.locales[locale].scenes.map((scene) => {
    const durationInFrames =
      toFrames(scene.padStartSec) + toFrames(scene.durationSec) + toFrames(scene.padEndSec)
    const timing: SceneTiming = {
      id: scene.id,
      durationInFrames,
      fromFrame,
      padStartInFrames: toFrames(scene.padStartSec),
      audioSrc: scene.file as string | null,
    }
    fromFrame += durationInFrames
    return timing
  })
}

export const totalDurationInFrames = (locale: Locale): number =>
  getSceneTimings(locale).reduce((total, scene) => total + scene.durationInFrames, 0)

/** True enquanto alguma cena do locale ainda nao tem mp3 sintetizado. */
export const hasPendingAudio = (locale: Locale): boolean =>
  getSceneTimings(locale).some((scene) => scene.audioSrc === null)
