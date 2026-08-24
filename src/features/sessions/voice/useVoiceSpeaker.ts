import { useEffect, useState } from 'react'
import { voiceApi } from '@/lib/ipc'
import {
  enqueueSpeech,
  finishSpeech,
  idleQueue,
  stopSpeech,
  type SpeakerQueue,
} from './voice-speaker-queue'

// Reprodutor das falas do modo voz. Singleton de módulo, de propósito: uma
// única saída de áudio pro app inteiro — dois panes da mesma sessão (pane +
// quick look) não podem falar em dobro, e o stop de qualquer chip para a MESMA
// reprodução. A ordem/dedupe vive em voice-speaker-queue (puro, testado).

let state: SpeakerQueue = idleQueue
let audio: HTMLAudioElement | null = null
let objectUrl: string | null = null
// Token da reprodução em curso: cada play() pega um novo; stop() e advance()
// invalidam os antigos. Sem ele, um stop + re-enqueue do MESMO texto durante a
// síntese deixava dois play() em voo passando na checagem por texto — dois
// Audio tocando e só o último rastreado (órfão que o Stop não para).
let playToken = 0
// ttsSpeed da config, cacheado na primeira fala (voz.env não muda no meio).
let cachedRate: number | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

async function playbackRate(): Promise<number> {
  if (cachedRate !== null) return cachedRate
  const status = await voiceApi.configStatus()
  cachedRate = status.ok ? status.ttsSpeed : 1
  return cachedRate
}

function releaseAudio(): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = null
  audio = null
}

function advance(): void {
  playToken++
  releaseAudio()
  const r = finishSpeech(state)
  state = r.state
  emit()
  if (r.start) void play(r.start)
}

async function play(text: string): Promise<void> {
  const token = ++playToken
  const res = await voiceApi.tts(text)
  // stop()/advance() podem ter chegado enquanto o mp3 era sintetizado — o token
  // garante que só a reprodução mais recente cria um Audio (nunca fantasma).
  if (token !== playToken || state.current !== text) return
  if (!res.ok) {
    console.error('[voice] TTS falhou:', res.error)
    advance()
    return
  }
  const rate = await playbackRate()
  if (token !== playToken || state.current !== text) return
  // Cópia p/ Uint8Array<ArrayBuffer>: BlobPart não aceita ArrayBufferLike.
  const blob = new Blob([new Uint8Array(res.bytes)], { type: res.mime })
  objectUrl = URL.createObjectURL(blob)
  audio = new Audio(objectUrl)
  audio.playbackRate = rate
  audio.onended = advance
  audio.onerror = advance
  audio.play().catch(advance)
}

// Enfileira uma fala (FIFO). Quem decide SE deve falar é o chamador — e a
// decisão hoje é sempre humana (▶ do SummaryChip): nada toca automaticamente.
export function speakSummary(text: string): void {
  const r = enqueueSpeech(state, text)
  state = r.state
  emit()
  if (r.start) void play(r.start)
}

export function stopSpeaking(): void {
  playToken++
  if (audio) audio.pause()
  releaseAudio()
  state = stopSpeech()
  emit()
}

export function useVoiceSpeaker(): { speaking: boolean; stop: () => void } {
  const [speaking, setSpeaking] = useState(state.current !== null)
  useEffect(() => {
    const l = () => setSpeaking(state.current !== null)
    listeners.add(l)
    l()
    return () => {
      listeners.delete(l)
    }
  }, [])
  return { speaking, stop: stopSpeaking }
}
