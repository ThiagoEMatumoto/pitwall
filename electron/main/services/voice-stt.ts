import type { VoiceTranscribeResult } from '../../../shared/types/ipc'
import { getVoiceConfig, resolveSecret, type VoiceDeps } from './voice-config'

// Cliente de transcrição — porte de vozapp/stt.py, trocando o curl subprocess
// por fetch nativo. O contrato do proxy é o da OpenAI (/v1/audio/transcriptions,
// multipart). `verbose_json` não custa nada a mais e traz no_speech_prob junto
// do texto, útil quando alguém for calibrar um detector de silêncio de verdade.
//
// ⚠️ Não há portão de silêncio aqui, de propósito (medido no Voz): por volume o
// silêncio mediu MAIS ALTO que a fala, e no_speech_prob separa sem margem. O
// descarte de gravações curtas (<sttMinSeconds) fica no recorder do renderer.

// Porte de stt.py:_mensagem_de_erro — erro em português, já pronto para a tela,
// e nunca genérico: um "falhou" único manda quem depura procurar no lugar errado.
function errorMessage(http: number, data: Record<string, unknown>, raw: string): string {
  const detail = extractDetail(data)

  if (http === 401 || http === 403) {
    return (
      `a credencial de transcrição foi recusada (HTTP ${http}) — confira ` +
      'VOZ_STT_KEY / VOZ_STT_KEY_CMD no voz.env'
    )
  }
  if (http === 404) {
    return (
      'o endereço de transcrição respondeu 404 — confira VOZ_STT_URL ' +
      '(tem de terminar em /v1/audio/transcriptions)'
    )
  }
  if (http === 429 || raw.includes('RateLimit')) {
    return 'o serviço recusou por excesso de chamadas — espere alguns segundos'
  }
  if (http >= 500) {
    return `o serviço de transcrição falhou (HTTP ${http})${detail ? ': ' + detail : ''}`
  }
  if (http === 0) {
    return 'não consegui falar com o serviço de transcrição (rede ou tempo esgotado)'
  }
  if (http === 200) {
    // Resposta boa, texto vazio: não havia fala no áudio (gravação acidental).
    return 'não ouvi fala nenhuma nessa gravação'
  }
  if (detail) return `o serviço respondeu HTTP ${http}: ${detail}`
  return `o serviço respondeu HTTP ${http} e não devolveu texto`
}

function extractDetail(data: Record<string, unknown>): string {
  const err = data.error
  let detail = ''
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    detail = message ? String(message) : ''
  } else if (typeof err === 'string') {
    detail = err
  }
  return detail || (data.detail ? String(data.detail) : '')
}

function fileName(mime: string): string {
  if (mime.includes('wav')) return 'audio.wav'
  if (mime.includes('ogg')) return 'audio.ogg'
  return 'audio.webm'
}

export async function transcribe(
  bytes: Uint8Array,
  mime: string,
  deps: Partial<VoiceDeps> = {},
): Promise<VoiceTranscribeResult> {
  const config = getVoiceConfig(deps)
  if (!config.ok) return { ok: false, error: config.error }
  const cfg = config.cfg

  const key = await resolveSecret('VOZ_STT_KEY', deps)
  if (!key.ok) return { ok: false, error: key.error }

  const form = new FormData()
  // Cópia p/ Uint8Array<ArrayBuffer>: BlobPart não aceita ArrayBufferLike.
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), fileName(mime))
  form.append('model', cfg.sttModel)
  form.append('language', cfg.sttLanguage)
  form.append('response_format', 'verbose_json')
  // A lista de vocabulário é o que faz nome próprio técnico sair grafado certo —
  // sem ela "Claude Code" volta como "Cloud Coding" (medido no Voz).
  if (cfg.sttPrompt) form.append('prompt', cfg.sttPrompt)

  let res: Response
  try {
    res = await fetch(cfg.sttUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.value}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
  } catch {
    return { ok: false, error: errorMessage(0, {}, '') }
  }

  const raw = await res.text().catch(() => '')
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>
  } catch {
    data = {}
  }

  const text = typeof data.text === 'string' ? data.text.trim() : ''
  if (text && res.status === 200) return { ok: true, text }
  return { ok: false, error: errorMessage(res.status, data, raw) }
}
