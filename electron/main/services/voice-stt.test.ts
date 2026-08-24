import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// voice-stt importa voice-config → custom-env, cuja cadeia carrega 'electron' —
// mock mínimo pro vitest (node) conseguir coletar o módulo, mesmo padrão de
// voice-config.test.ts.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain: string) => Buffer.from(`v:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8').slice(2),
  },
}))

import { clearVoiceSecrets, type VoiceDeps } from './voice-config'
import { transcribe } from './voice-stt'

// Ambiente isolado: sem arquivo voz.env (exists=false), tudo via env — mesmo
// caminho que o e2e usa pra apontar o STT pro fake server.
function makeDeps(env: NodeJS.ProcessEnv = {}): Partial<VoiceDeps> {
  return {
    env: {
      VOZ_STT_URL: 'https://proxy.test/v1/audio/transcriptions',
      VOZ_STT_KEY: 'sk-teste',
      VOZ_STT_PROMPT: 'Claude Code, Pitwall',
      ...env,
    },
    home: '/home/teste',
    exists: () => false,
    readFile: () => '',
    exec: async () => ({ stdout: '', stderr: '' }),
  }
}

function response(status: number, body: unknown) {
  return {
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

const audio = new Uint8Array([1, 2, 3, 4])

beforeEach(() => clearVoiceSecrets())
afterEach(() => vi.unstubAllGlobals())

describe('transcribe — requisição', () => {
  it('monta o POST multipart com file, model, language, verbose_json e prompt', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(200, { text: ' olá, mundo ', segments: [{ no_speech_prob: 0.1 }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await transcribe(audio, 'audio/webm;codecs=opus', makeDeps())

    expect(result).toEqual({ ok: true, text: 'olá, mundo' })
    const [endpoint, init] = fetchMock.mock.calls[0]
    expect(String(endpoint)).toBe('https://proxy.test/v1/audio/transcriptions')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ Authorization: 'Bearer sk-teste' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)

    const form = init?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('whisper')
    expect(form.get('language')).toBe('pt')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('prompt')).toBe('Claude Code, Pitwall')

    const file = form.get('file') as File
    expect(file.name).toBe('audio.webm')
    expect(file.type).toBe('audio/webm;codecs=opus')
    // jsdom não implementa File.arrayBuffer; o tamanho já pega bytes trocados.
    expect(file.size).toBe(audio.length)
  })

  it('omite o prompt quando o vocabulário não está configurado', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => response(200, { text: 'oi' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await transcribe(audio, 'audio/webm', makeDeps({ VOZ_STT_PROMPT: '' }))

    const form = fetchMock.mock.calls[0][1]?.body as FormData
    expect(form.get('prompt')).toBeNull()
  })

  it('nomeia o arquivo conforme o mime (fallback WAV)', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => response(200, { text: 'oi' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await transcribe(audio, 'audio/wav', makeDeps())

    const form = fetchMock.mock.calls[0][1]?.body as FormData
    expect((form.get('file') as File).name).toBe('audio.wav')
  })
})

describe('transcribe — erros', () => {
  it('sem config: reporta o erro da config sem chamar a rede', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await transcribe(audio, 'audio/webm', {
      env: {},
      home: '/home/teste',
      exists: () => false,
      readFile: () => '',
      exec: async () => ({ stdout: '', stderr: '' }),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Configuração de voz não encontrada')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('401: credencial recusada', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(401, {})))
    const result = await transcribe(audio, 'audio/webm', makeDeps())
    expect(result).toEqual({
      ok: false,
      error:
        'a credencial de transcrição foi recusada (HTTP 401) — confira ' +
        'VOZ_STT_KEY / VOZ_STT_KEY_CMD no voz.env',
    })
  })

  it('404: aponta pra VOZ_STT_URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(404, {})))
    const result = await transcribe(audio, 'audio/webm', makeDeps())
    if (result.ok) throw new Error('esperava erro')
    expect(result.error).toContain('VOZ_STT_URL')
    expect(result.error).toContain('/v1/audio/transcriptions')
  })

  it('429: excesso de chamadas', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(429, {})))
    const result = await transcribe(audio, 'audio/webm', makeDeps())
    if (result.ok) throw new Error('esperava erro')
    expect(result.error).toContain('excesso de chamadas')
  })

  it('"RateLimit" no corpo vale como 429 mesmo com outro status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(400, { error: 'RateLimitError: slow down' })))
    const result = await transcribe(audio, 'audio/webm', makeDeps())
    if (result.ok) throw new Error('esperava erro')
    expect(result.error).toContain('excesso de chamadas')
  })

  it('500: inclui o detalhe do corpo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(500, { error: { message: 'backend indisponível' } })))
    const result = await transcribe(audio, 'audio/webm', makeDeps())
    expect(result).toEqual({
      ok: false,
      error: 'o serviço de transcrição falhou (HTTP 500): backend indisponível',
    })
  })

  it('502 com corpo não-JSON: mensagem de falha sem detalhe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(502, 'Bad Gateway')))
    const result = await transcribe(audio, 'audio/webm', makeDeps())
    expect(result).toEqual({ ok: false, error: 'o serviço de transcrição falhou (HTTP 502)' })
  })

  it('200 sem texto: não havia fala na gravação', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { text: '  ' })))
    const result = await transcribe(audio, 'audio/webm', makeDeps())
    if (result.ok) throw new Error('esperava erro')
    expect(result.error).toContain('não ouvi fala nenhuma')
  })

  it('4xx com detail: repassa o detalhe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(422, { detail: 'arquivo inválido' })))
    const result = await transcribe(audio, 'audio/webm', makeDeps())
    expect(result).toEqual({
      ok: false,
      error: 'o serviço respondeu HTTP 422: arquivo inválido',
    })
  })

  it('rede fora: rede ou tempo esgotado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))
    const result = await transcribe(audio, 'audio/webm', makeDeps())
    expect(result).toEqual({
      ok: false,
      error: 'não consegui falar com o serviço de transcrição (rede ou tempo esgotado)',
    })
  })
})
