import { useEffect, useRef, useState } from 'react'
import { prefsApi, voiceApi } from '@/lib/ipc'
import {
  CONDENSE_THRESHOLD_KEY,
  DEFAULT_CONDENSE_THRESHOLD_WORDS,
  reduceRecorder,
  shouldCondense,
  type RecorderEvent,
  type RecorderState,
} from './voice-recorder-state'

const PREFERRED_MIME = 'audio/webm;codecs=opus'

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return PREFERRED_MIME
  if (MediaRecorder.isTypeSupported(PREFERRED_MIME)) return PREFERRED_MIME
  return 'audio/webm'
}

async function condenseThresholdWords(): Promise<number> {
  try {
    const v = await prefsApi.get<number>(CONDENSE_THRESHOLD_KEY)
    return typeof v === 'number' && v >= 0 ? v : DEFAULT_CONDENSE_THRESHOLD_WORDS
  } catch {
    return DEFAULT_CONDENSE_THRESHOLD_WORDS
  }
}

// A condensação nunca perde o ditado: qualquer falha devolve o texto cru.
async function condensed(text: string): Promise<string> {
  try {
    const res = await voiceApi.condense(text)
    return res.text.trim() || text
  } catch {
    return text
  }
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Permissão de microfone negada — libere o acesso nas configurações do sistema.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'Nenhum microfone encontrado.'
  return 'Falha ao acessar o microfone.'
}

// Captura de mic no renderer: getUserMedia + MediaRecorder (webm/opus), toggle
// gravar/parar. Ao parar, junta os chunks e transcreve via IPC voice:transcribe;
// o texto sai pelo callback `onText` (que insere no composer — nunca envia).
// A máquina de transições é pura (voice-recorder-state.ts); aqui só o browser.
export function useVoiceRecorder(onText: (text: string) => void) {
  const [state, setState] = useState<RecorderState>({ status: 'idle' })
  const stateRef = useRef(state)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mountedRef = useRef(true)
  // Ref pro callback: o onstop do MediaRecorder é registrado uma vez por
  // gravação e não deve capturar um `onText` velho.
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Desmontar no meio da gravação: solta o mic (o onstop ainda roda, mas
      // dispatch vira no-op pra não setar estado em componente morto).
      const rec = recorderRef.current
      if (rec) {
        for (const track of rec.stream.getTracks()) track.stop()
      }
    }
  }, [])

  function dispatch(event: RecorderEvent): RecorderState {
    const next = reduceRecorder(stateRef.current, event)
    stateRef.current = next
    if (mountedRef.current) setState(next)
    return next
  }

  async function finish(recorder: MediaRecorder) {
    for (const track of recorder.stream.getTracks()) track.stop()
    recorderRef.current = null
    const next = dispatch({ type: 'stop', at: Date.now() })
    const chunks = chunksRef.current
    chunksRef.current = []
    // Curta demais (<0.4s) → descartada pela máquina; nada a transcrever.
    if (next.status !== 'transcribing') return
    try {
      const mime = recorder.mimeType || PREFERRED_MIME
      const blob = new Blob(chunks, { type: mime })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const res = await voiceApi.transcribe(bytes, mime)
      if (!res.ok) {
        dispatch({ type: 'failed', message: res.error })
        return
      }
      const text = res.text.trim()
      if (!text) {
        dispatch({ type: 'transcribed' })
        return
      }
      // Ditado longo passa pelo condensador antes de entrar no composer; o
      // resultado continua editável — nada é enviado sem revisão.
      if (!shouldCondense(text, await condenseThresholdWords())) {
        onTextRef.current(text)
        dispatch({ type: 'transcribed' })
        return
      }
      dispatch({ type: 'condensing' })
      onTextRef.current(await condensed(text))
      dispatch({ type: 'condensed' })
    } catch {
      dispatch({ type: 'failed', message: 'Falha ao transcrever o áudio.' })
    }
  }

  async function start() {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      dispatch({ type: 'failed', message: micErrorMessage(err) })
      return
    }
    const recorder = new MediaRecorder(stream, { mimeType: pickMimeType() })
    chunksRef.current = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.onstop = () => {
      void finish(recorder)
    }
    recorderRef.current = recorder
    recorder.start()
    dispatch({ type: 'start', at: Date.now() })
  }

  function toggle() {
    const status = stateRef.current.status
    if (status === 'recording') {
      recorderRef.current?.stop()
      return
    }
    if (status === 'transcribing' || status === 'condensing') return
    void start()
  }

  return { state, toggle }
}
