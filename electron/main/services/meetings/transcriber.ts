import { getVoiceConfig, resolveSecret, type VoiceDeps } from '../voice-config'
import { errorMessage } from '../voice-stt'

// STT de um pedaço da reunião: mesmo proxy OpenAI-compatible e mesmo multipart
// do ditado (voice-stt.ts), mas aqui os `segments[]` do verbose_json importam —
// são eles que viram linhas com timestamp na transcrição.

export interface TranscribedSegment {
  text: string
  /** Relativos ao início do chunk. */
  startMs: number
  endMs: number
  noSpeechProb: number | null
}

export interface SttConfig {
  url: string
  model: string
  language: string
  /** Vocabulário do voz.env (VOZ_STT_PROMPT), usado quando ainda não há transcript. */
  vocabulary: string
  key: string
}

export type SttConfigResult =
  | { ok: true; cfg: SttConfig }
  | { ok: false; error: string; url: string | null }

export const NO_SPEECH_MAX = 0.6
const TIMEOUT_MS = 60_000

export class SttError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'SttError'
  }
}

// Config + credencial resolvida, sem tocar na rede. Compõe getVoiceConfig e
// resolveSecret em vez de duplicar a precedência env > arquivo > alias.
export async function loadSttConfig(deps: Partial<VoiceDeps> = {}): Promise<SttConfigResult> {
  const config = getVoiceConfig(deps)
  if (!config.ok) return { ok: false, error: config.error, url: null }
  const key = await resolveSecret('VOZ_STT_KEY', deps)
  if (!key.ok) return { ok: false, error: key.error, url: config.cfg.sttUrl }
  return {
    ok: true,
    cfg: {
      url: config.cfg.sttUrl,
      model: config.cfg.sttModel,
      language: config.cfg.sttLanguage,
      vocabulary: config.cfg.sttPrompt,
      key: key.value,
    },
  }
}

export interface TranscribeChunkInput {
  wav: Buffer
  language: string
  prompt?: string
  config: SttConfig
  /** Duração do chunk, pro fallback sem `segments`. */
  durationMs?: number
  fetchImpl?: typeof fetch
}

export async function transcribeChunk(input: TranscribeChunkInput): Promise<TranscribedSegment[]> {
  const { config } = input
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(input.wav)], { type: 'audio/wav' }), 'chunk.wav')
  form.append('model', config.model)
  form.append('language', input.language)
  form.append('response_format', 'verbose_json')
  if (input.prompt) form.append('prompt', input.prompt)

  const doFetch = input.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(config.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.key}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new SttError(errorMessage(0, {}, ''), 0)
  }

  const raw = await res.text().catch(() => '')
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>
  } catch {
    data = {}
  }
  if (res.status !== 200) throw new SttError(errorMessage(res.status, data, raw), res.status)
  return parseVerboseJson(data, input.durationMs ?? 0)
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Lê `segments[]` ({start, end, text, no_speech_prob}); sem eles, o `text`
// inteiro vira um segmento cobrindo o chunk. Descarta vazio e no_speech alto.
export function parseVerboseJson(data: Record<string, unknown>, durationMs: number): TranscribedSegment[] {
  const out: TranscribedSegment[] = []
  const segments = Array.isArray(data.segments) ? (data.segments as unknown[]) : null
  if (segments) {
    for (const item of segments) {
      if (!item || typeof item !== 'object') continue
      const seg = item as Record<string, unknown>
      const text = typeof seg.text === 'string' ? seg.text.trim() : ''
      const noSpeechProb = num(seg.no_speech_prob)
      if (!text || (noSpeechProb !== null && noSpeechProb > NO_SPEECH_MAX)) continue
      const start = num(seg.start) ?? 0
      const end = num(seg.end) ?? start
      out.push({
        text,
        startMs: Math.round(start * 1000),
        endMs: Math.round(Math.max(start, end) * 1000),
        noSpeechProb,
      })
    }
    return out
  }
  const text = typeof data.text === 'string' ? data.text.trim() : ''
  if (text) out.push({ text, startMs: 0, endMs: durationMs, noSpeechProb: null })
  return out
}
