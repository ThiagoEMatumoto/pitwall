import type { VoiceTtsResult } from '../../../shared/types/ipc'
import { getVoiceConfig, resolveSecret, type VoiceDeps } from './voice-config'

// Síntese de fala — porte de vozapp/tts.py:sintetizar, trocando o curl
// subprocess por fetch nativo. O mp3 inteiro volta como bytes: quem toca é o
// renderer (Audio + object URL); o main não encosta em ffplay nem em arquivo.

const TTS_TIMEOUT_MS = 180_000

// Porte das mensagens de tts.py — erro em PT, específico por ramo, pronto
// pra tela. `pista` é o começo do corpo do erro, que costuma bastar.
function errorMessage(http: number, pista: string): string {
  if (http === 401 || http === 403) {
    return 'a credencial de voz foi recusada — confira VOZ_TTS_KEY / VOZ_TTS_KEY_CMD no voz.env'
  }
  if (http === 0) {
    return 'não consegui chamar o serviço de voz (rede ou tempo esgotado)'
  }
  return `o serviço de voz respondeu HTTP ${http}${pista ? ': ' + pista : ''}`
}

export async function speak(text: string, deps: Partial<VoiceDeps> = {}): Promise<VoiceTtsResult> {
  const config = getVoiceConfig(deps)
  if (!config.ok) return { ok: false, error: config.error }
  const cfg = config.cfg

  const key = await resolveSecret('VOZ_TTS_KEY', deps)
  if (!key.ok) return { ok: false, error: key.error }

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${cfg.ttsVoice}/stream` +
    '?output_format=mp3_44100_128'

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key.value, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: cfg.ttsModel }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: errorMessage(0, '') }
  }

  if (res.status !== 200) {
    const pista = (await res.text().catch(() => '')).slice(0, 160)
    return { ok: false, error: errorMessage(res.status, pista) }
  }

  const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0))
  if (buf.byteLength === 0) {
    return { ok: false, error: 'o serviço de voz devolveu um arquivo vazio' }
  }
  return { ok: true, bytes: new Uint8Array(buf), mime: 'audio/mpeg' }
}
