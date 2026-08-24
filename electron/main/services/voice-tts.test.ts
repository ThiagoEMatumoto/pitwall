import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// voice-tts importa voice-config → custom-env, cuja cadeia carrega 'electron' —
// mock mínimo pro vitest (node) conseguir coletar o módulo, mesmo padrão de
// voice-stt.test.ts.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain: string) => Buffer.from(`v:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8').slice(2),
  },
}))

import { clearVoiceSecrets, type VoiceDeps } from './voice-config'
import { speak } from './voice-tts'

// Ambiente isolado: sem arquivo voz.env (exists=false), tudo via env.
function makeDeps(env: NodeJS.ProcessEnv = {}): Partial<VoiceDeps> {
  return {
    env: {
      VOZ_STT_URL: 'https://proxy.test/v1/audio/transcriptions',
      VOZ_TTS_KEY: 'el-teste',
      VOZ_TTS_VOICE: 'voz123',
      VOZ_TTS_MODEL: 'eleven_flash_v2_5',
      ...env,
    },
    home: '/home/teste',
    exists: () => false,
    readFile: () => '',
    exec: async () => ({ stdout: '', stderr: '' }),
  }
}

const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04])

function response(status: number, body: Uint8Array | string) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return {
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    text: async () => new TextDecoder().decode(bytes),
  } as unknown as Response
}

beforeEach(() => clearVoiceSecrets())
afterEach(() => vi.unstubAllGlobals())

describe('speak — requisição', () => {
  it('monta o POST do stream com xi-api-key, voz da config e model_id', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(200, mp3),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await speak('olá, mundo', makeDeps())

    expect(result).toEqual({ ok: true, bytes: mp3, mime: 'audio/mpeg' })
    const [endpoint, init] = fetchMock.mock.calls[0]
    expect(String(endpoint)).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voz123/stream?output_format=mp3_44100_128',
    )
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'xi-api-key': 'el-teste', 'Content-Type': 'application/json' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'olá, mundo',
      model_id: 'eleven_flash_v2_5',
    })
  })
})

describe('speak — erros', () => {
  it('sem config: reporta o erro da config sem chamar a rede', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await speak('oi', {
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

  it('sem credencial: pede VOZ_TTS_KEY sem chamar a rede', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await speak('oi', makeDeps({ VOZ_TTS_KEY: '' }))

    expect(result).toEqual({
      ok: false,
      error:
        'Credencial VOZ_TTS_KEY não configurada — defina VOZ_TTS_KEY ou VOZ_TTS_KEY_CMD no voz.env.',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('401 com secret cacheado: invalida o cache, refaz UMA vez com secret fresco e sintetiza', async () => {
    let issued = 0
    const d: Partial<VoiceDeps> = {
      env: {
        VOZ_STT_URL: 'https://proxy.test/v1/audio/transcriptions',
        VOZ_TTS_VOICE: 'voz123',
        VOZ_TTS_KEY_CMD: 'cofre',
      },
      home: '/home/teste',
      exists: () => false,
      readFile: () => '',
      exec: async () => ({ stdout: `el-fresh-${++issued}\n`, stderr: '' }),
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)['xi-api-key']
      return auth === 'el-fresh-2' ? response(200, mp3) : response(401, '{}')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await speak('oi', d)

    expect(result).toEqual({ ok: true, bytes: mp3, mime: 'audio/mpeg' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(issued).toBe(2) // o cache foi invalidado entre as tentativas.
  })

  it('401: credencial recusada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(401, '{"detail":"bad key"}')),
    )
    const result = await speak('oi', makeDeps())
    expect(result).toEqual({
      ok: false,
      error: 'a credencial de voz foi recusada — confira VOZ_TTS_KEY / VOZ_TTS_KEY_CMD no voz.env',
    })
  })

  it('outros HTTP: repassa o status com o começo do corpo como pista', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(500, 'backend indisponível')),
    )
    const result = await speak('oi', makeDeps())
    expect(result).toEqual({
      ok: false,
      error: 'o serviço de voz respondeu HTTP 500: backend indisponível',
    })
  })

  it('erro HTTP com corpo vazio: mensagem sem pista', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(422, '')),
    )
    const result = await speak('oi', makeDeps())
    expect(result).toEqual({ ok: false, error: 'o serviço de voz respondeu HTTP 422' })
  })

  it('rede fora: rede ou tempo esgotado', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
    )
    const result = await speak('oi', makeDeps())
    expect(result).toEqual({
      ok: false,
      error: 'não consegui chamar o serviço de voz (rede ou tempo esgotado)',
    })
  })

  it('200 com corpo vazio: arquivo vazio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(200, new Uint8Array(0))),
    )
    const result = await speak('oi', makeDeps())
    expect(result).toEqual({ ok: false, error: 'o serviço de voz devolveu um arquivo vazio' })
  })
})
