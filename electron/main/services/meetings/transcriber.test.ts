/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { loadSttConfig, parseVerboseJson, transcribeChunk, type SttConfig } from './transcriber'
import { clearVoiceSecrets } from '../voice-config'
import { encodeWav } from './wav'

const config: SttConfig = {
  url: 'https://stt.example/v1/audio/transcriptions',
  model: 'whisper',
  language: 'pt',
  vocabulary: '',
  key: 'k-123',
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('transcribeChunk', () => {
  it('posta multipart verbose_json e devolve segmentos filtrando no_speech_prob > 0.6', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        text: 'olá mundo',
        segments: [
          { start: 0.5, end: 2.1, text: ' olá ', no_speech_prob: 0.1 },
          { start: 2.1, end: 4.0, text: 'mundo', no_speech_prob: 0.9 },
          { start: 4.0, end: 5.0, text: '   ', no_speech_prob: 0.0 },
        ],
      }),
    )
    const wav = encodeWav(Buffer.alloc(3200))
    const segs = await transcribeChunk({
      wav,
      language: 'pt',
      prompt: 'contexto anterior',
      config,
      durationMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(segs).toEqual([{ text: 'olá', startMs: 500, endMs: 2100, noSpeechProb: 0.1 }])

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(config.url)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k-123')
    const form = init.body as FormData
    expect(form.get('model')).toBe('whisper')
    expect(form.get('language')).toBe('pt')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('prompt')).toBe('contexto anterior')
    const file = form.get('file') as File
    expect(file.name).toBe('chunk.wav')
    expect(file.size).toBe(wav.length)
  })

  it('cai no text inteiro quando não há segments', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { text: ' tudo junto ' }))
    const segs = await transcribeChunk({
      wav: encodeWav(Buffer.alloc(0)),
      language: 'pt',
      config,
      durationMs: 12000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(segs).toEqual([{ text: 'tudo junto', startMs: 0, endMs: 12000, noSpeechProb: null }])
  })

  it('lança SttError com mensagem em português em HTTP ≠ 200 e em falha de rede', async () => {
    const denied = vi.fn(async () => jsonResponse(401, { error: { message: 'bad key' } }))
    await expect(
      transcribeChunk({ wav: Buffer.alloc(0), language: 'pt', config, fetchImpl: denied as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: 'SttError', status: 401, message: /credencial de transcrição foi recusada/ })

    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      transcribeChunk({ wav: Buffer.alloc(0), language: 'pt', config, fetchImpl: down as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 0, message: /não consegui falar/ })
  })
})

describe('parseVerboseJson', () => {
  it('ignora itens malformados e normaliza end < start', () => {
    const segs = parseVerboseJson(
      { segments: [null, 'x', { start: 3, end: 1, text: 'ok' }, { text: 'sem tempo' }] },
      0,
    )
    expect(segs).toEqual([
      { text: 'ok', startMs: 3000, endMs: 3000, noSpeechProb: null },
      { text: 'sem tempo', startMs: 0, endMs: 0, noSpeechProb: null },
    ])
  })
})

describe('loadSttConfig', () => {
  it('compõe voice-config + secret sem rede; reporta url mesmo quando a key falha', async () => {
    clearVoiceSecrets()
    const base = { home: '/nope', exists: () => false, readFile: () => '' }
    const ok = await loadSttConfig({
      ...base,
      env: { VOZ_STT_URL: 'https://stt/v1', VOZ_STT_KEY: 'abc', VOZ_STT_PROMPT: 'Pitwall' },
    })
    expect(ok).toEqual({
      ok: true,
      cfg: { url: 'https://stt/v1', model: 'whisper', language: 'pt', vocabulary: 'Pitwall', key: 'abc' },
    })

    clearVoiceSecrets()
    const noKey = await loadSttConfig({ ...base, env: { VOZ_STT_URL: 'https://stt/v1' } })
    expect(noKey).toMatchObject({ ok: false, url: 'https://stt/v1', error: /VOZ_STT_KEY/ })

    const noUrl = await loadSttConfig({ ...base, env: {} })
    expect(noUrl).toMatchObject({ ok: false, url: null })
    clearVoiceSecrets()
  })
})
