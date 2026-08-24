import type { VoiceTtsResult } from '../../../shared/types/ipc'
import { clearVoiceSecrets, getVoiceConfig, resolveSecret, type VoiceDeps } from './voice-config'

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

  const first = await request(cfg, key.value, text)
  // 401/403 pode ser só o cache de secret velho: invalida e refaz UMA vez com
  // secret fresco — mesma regra do voice-stt. Falhou de novo, aí sim é erro.
  if (first.status === 401 || first.status === 403) {
    clearVoiceSecrets()
    const fresh = await resolveSecret('VOZ_TTS_KEY', deps)
    if (fresh.ok && fresh.value !== key.value) {
      return toResult(await request(cfg, fresh.value, text))
    }
  }
  return toResult(first)
}

// Uma tentativa de síntese. status 0 = rede/timeout; body só quando 200.
async function request(
  cfg: { ttsVoice: string; ttsModel: string },
  key: string,
  text: string,
): Promise<{ status: number; body: ArrayBuffer; pista: string }> {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${cfg.ttsVoice}/stream` +
    '?output_format=mp3_44100_128'

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: cfg.ttsModel }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    })
  } catch {
    return { status: 0, body: new ArrayBuffer(0), pista: '' }
  }

  if (res.status !== 200) {
    const pista = (await res.text().catch(() => '')).slice(0, 160)
    return { status: res.status, body: new ArrayBuffer(0), pista }
  }

  const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0))
  return { status: 200, body: buf, pista: '' }
}

function toResult(r: { status: number; body: ArrayBuffer; pista: string }): VoiceTtsResult {
  if (r.status !== 200) return { ok: false, error: errorMessage(r.status, r.pista) }
  if (r.body.byteLength === 0) {
    return { ok: false, error: 'o serviço de voz devolveu um arquivo vazio' }
  }
  return { ok: true, bytes: new Uint8Array(r.body), mime: 'audio/mpeg' }
}
