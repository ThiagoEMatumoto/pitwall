// Máquina de estados do gravador de voz, pura pra ser testável sem browser.
// O hook (useVoiceRecorder) cuida do MediaRecorder/getUserMedia e despacha
// eventos; toda decisão de transição vive aqui.

// Gravações mais curtas que isso são descartadas: Whisper alucina em silêncio.
export const MIN_RECORDING_MS = 400

export type RecorderState =
  | { status: 'idle' }
  | { status: 'recording'; startedAt: number }
  | { status: 'transcribing' }
  | { status: 'error'; message: string }

export type RecorderEvent =
  | { type: 'start'; at: number }
  | { type: 'stop'; at: number }
  | { type: 'transcribed' }
  | { type: 'failed'; message: string }
  | { type: 'reset' }

export function reduceRecorder(state: RecorderState, event: RecorderEvent): RecorderState {
  switch (event.type) {
    case 'start':
      // Transcrevendo não é interrompível — o áudio já foi enviado.
      if (state.status === 'transcribing' || state.status === 'recording') return state
      return { status: 'recording', startedAt: event.at }
    case 'stop': {
      if (state.status !== 'recording') return state
      const duration = event.at - state.startedAt
      if (duration < MIN_RECORDING_MS) return { status: 'idle' }
      return { status: 'transcribing' }
    }
    case 'transcribed':
      if (state.status !== 'transcribing') return state
      return { status: 'idle' }
    case 'failed':
      return { status: 'error', message: event.message }
    case 'reset':
      return { status: 'idle' }
  }
}
