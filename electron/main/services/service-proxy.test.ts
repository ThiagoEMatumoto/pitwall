import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// service-proxy importa custom-env/secret-store (→ electron) e o audit store
// (→ ./db); nos testes tudo entra por deps injetadas, então basta neutralizar
// os imports de módulo.
vi.mock('electron', () => ({ app: {}, safeStorage: {} }))

import {
  CALL_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  HEALTH_TTL_MS,
  callService,
  clearServiceHealthCache,
  healthCheck,
  serviceStatuses,
  type ServiceProxyDeps,
} from './service-proxy'
import type { ServiceAuditEntry } from '../../../shared/types/ipc'

const LITELLM_KEY = 'sk-litellm-teste-123'
const GEMINI_KEY = 'g-key-123456789'

const env =
  (vars: Record<string, string>) =>
  (key: string): string | undefined =>
    vars[key]

function deps(vars: Record<string, string>, over: Partial<ServiceProxyDeps> = {}) {
  return {
    getEnvVar: env(vars),
    recordCall: vi.fn(),
    lastCall: vi.fn(() => null),
    now: () => 1000,
    ...over,
  }
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200 })
}

const validChatParams = {
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'oi' }],
  max_tokens: 16,
}

describe('callService', () => {
  beforeEach(() => {
    clearServiceHealthCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('monta URL só do registry, injeta bearer e manda params no corpo (litellm)', async () => {
    const fetchMock = vi.fn(async () => okResponse('{"id":"cmpl-1"}'))
    vi.stubGlobal('fetch', fetchMock)
    const d = deps({ LITE_LLM_API_KEY: LITELLM_KEY })

    const result = await callService('litellm', 'chat_completions', validChatParams, {
      sessionId: 's-1',
      deps: d,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe(
      'https://litellm-service-stg-2kzxgvaw5q-ue.a.run.app/v1/chat/completions',
    )
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${LITELLM_KEY}`)
    expect(JSON.parse(String(init.body))).toEqual(validChatParams)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // Redirect seguiria com o header de auth pro host de destino.
    expect(init.redirect).toBe('error')
    expect(result).toEqual({
      ok: true,
      status: 200,
      durationMs: 0,
      body: '{"id":"cmpl-1"}',
      truncated: false,
    })
    expect(d.recordCall).toHaveBeenCalledWith({
      sessionId: 's-1',
      service: 'litellm',
      operation: 'chat_completions',
      status: 'ok',
      durationMs: 0,
    })
  })

  it('substitui {model} no path (URL-encoded), tira do corpo e usa query-key (gemini)', async () => {
    const fetchMock = vi.fn(async () => okResponse('{}'))
    vi.stubGlobal('fetch', fetchMock)

    await callService(
      'gemini',
      'generate_content',
      {
        model: 'gemini-2.0-flash',
        contents: [{ role: 'user', parts: [{ text: 'oi' }] }],
      },
      { deps: deps({ GEMINI_API_KEY: GEMINI_KEY }) },
    )

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    )
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.model).toBeUndefined()
    expect(body.contents).toBeDefined()
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('recusa serviço/operação fora do registry sem tocar a rede', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const d = deps({ LITE_LLM_API_KEY: LITELLM_KEY })

    const unknownService = await callService('nope', 'x', {}, { deps: d })
    const unknownOp = await callService('litellm', 'nope', {}, { deps: d })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(unknownService.ok).toBe(false)
    if (!unknownService.ok) expect(unknownService.error).toContain('serviço desconhecido')
    expect(unknownOp.ok).toBe(false)
    if (!unknownOp.ok) expect(unknownOp.error).toContain('operação desconhecida')
    expect(d.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'litellm',
        operation: 'nope',
        status: 'error',
      }),
    )
  })

  it('recusa params fora do schema antes do fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await callService(
      'litellm',
      'chat_completions',
      { ...validChatParams, url: 'https://evil.example' },
      { deps: deps({ LITE_LLM_API_KEY: LITELLM_KEY }) },
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('params inválidos')
  })

  it('credencial ausente vira erro sem fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await callService('litellm', 'chat_completions', validChatParams, {
      deps: deps({}),
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('LITE_LLM_API_KEY')
  })

  it('timeout/rede vira status 0 com erro auditado', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'TimeoutError')
      }),
    )
    const d = deps({ LITE_LLM_API_KEY: LITELLM_KEY })

    const result = await callService('litellm', 'chat_completions', validChatParams, { deps: d })

    expect(result).toMatchObject({ ok: false, status: 0 })
    if (!result.ok) expect(result.error).toContain('timeout')
    expect(d.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('timeout'),
      }),
    )
    expect(CALL_TIMEOUT_MS).toBe(30_000)
  })

  it('3xx com redirect:error vira falha sem re-request', async () => {
    // undici com redirect:'error' rejeita o fetch ao ver o 3xx — não há segunda
    // chamada carregando o header de auth pro Location.
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.redirect === 'error') throw new TypeError('unexpected redirect')
      return okResponse('{}')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await callService('litellm', 'chat_completions', validChatParams, {
      deps: deps({ LITE_LLM_API_KEY: LITELLM_KEY }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(0)
  })

  it('redige o corpo INTEGRAL antes de truncar: segredo na fronteira não vaza prefixo', async () => {
    // Segredo atravessando exatamente o corte de maxResponseBytes: truncar
    // primeiro deixaria um prefixo do segredo que o redator não reconhece.
    const body = 'x'.repeat(DEFAULT_MAX_RESPONSE_BYTES - 10) + LITELLM_KEY + 'tail'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(body)),
    )

    const result = await callService('litellm', 'chat_completions', validChatParams, {
      deps: deps({ LITE_LLM_API_KEY: LITELLM_KEY }),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.truncated).toBe(true)
      expect(result.body).not.toContain(LITELLM_KEY.slice(0, 10))
      expect(result.body).toContain('[REDACTED]')
    }
  })

  it('corta o download no cap (stream) em vez de bufferizar o corpo inteiro', async () => {
    const chunk = new Uint8Array(Buffer.alloc(64 * 1024, 0x61))
    let delivered = 0
    // Stream "infinita": só o cancel do leitor a interrompe.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        delivered += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { status: 200 })),
    )

    const result = await callService('litellm', 'chat_completions', validChatParams, {
      deps: deps({ LITE_LLM_API_KEY: LITELLM_KEY }),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.truncated).toBe(true)
      expect(Buffer.byteLength(result.body, 'utf8')).toBe(DEFAULT_MAX_RESPONSE_BYTES)
    }
    // hardCap = max + 64KB de margem; com pull de 64KB o download para logo ali.
    expect(delivered).toBeLessThanOrEqual(DEFAULT_MAX_RESPONSE_BYTES + 4 * 64 * 1024)
  })

  it('trunca resposta maior que maxResponseBytes (default 256KB)', async () => {
    const huge = 'a'.repeat(DEFAULT_MAX_RESPONSE_BYTES + 100)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(huge)),
    )

    const result = await callService('litellm', 'chat_completions', validChatParams, {
      deps: deps({ LITE_LLM_API_KEY: LITELLM_KEY }),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.truncated).toBe(true)
      expect(Buffer.byteLength(result.body, 'utf8')).toBe(DEFAULT_MAX_RESPONSE_BYTES)
    }
  })

  it('redige a credencial em erro HTTP e em corpo de sucesso', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`invalid key ${LITELLM_KEY}`, { status: 401 })),
    )
    const d = deps({ LITE_LLM_API_KEY: LITELLM_KEY })

    const errored = await callService('litellm', 'chat_completions', validChatParams, { deps: d })

    expect(errored.ok).toBe(false)
    if (!errored.ok) {
      expect(errored.error).not.toContain(LITELLM_KEY)
      expect(errored.error).toContain('[REDACTED]')
      expect(errored.error).toContain('HTTP 401')
    }
    const audited = (d.recordCall as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      error: string
    }
    expect(audited.error).not.toContain(LITELLM_KEY)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(`{"echo":"${LITELLM_KEY}"}`)),
    )
    const succeeded = await callService('litellm', 'chat_completions', validChatParams, { deps: d })
    expect(succeeded.ok).toBe(true)
    if (succeeded.ok) {
      expect(succeeded.body).not.toContain(LITELLM_KEY)
      expect(succeeded.body).toContain('[REDACTED]')
    }
  })
})

describe('healthCheck', () => {
  beforeEach(() => {
    clearServiceHealthCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('serviço sem descritor de health é unsupported, sem rede', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const health = await healthCheck('tavily', deps({ TAVILY_API_KEY: 'tvly-12345678' }))

    expect(health.status).toBe('unsupported')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sem credencial é unconfigured, sem rede', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const health = await healthCheck('litellm', deps({}))

    expect(health.status).toBe('unconfigured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('2xx é ok e fica em cache pelo TTL de 5min', async () => {
    const fetchMock = vi.fn(async () => okResponse('{"data":[]}'))
    vi.stubGlobal('fetch', fetchMock)
    let now = 1000
    const d = deps({ LITE_LLM_API_KEY: LITELLM_KEY }, { now: () => now })

    const first = await healthCheck('litellm', d)
    expect(first).toEqual({ status: 'ok', checkedAt: 1000, httpStatus: 200 })
    const [url] = fetchMock.mock.calls[0] as unknown as [URL]
    expect(String(url)).toBe('https://litellm-service-stg-2kzxgvaw5q-ue.a.run.app/v1/models')

    now += HEALTH_TTL_MS - 1
    expect(await healthCheck('litellm', d)).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 2
    const refreshed = await healthCheck('litellm', d)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(refreshed.checkedAt).toBe(now)
  })

  it('HTTP não-2xx é error com corpo redigido', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`denied for ${LITELLM_KEY}`, { status: 403 })),
    )

    const health = await healthCheck('litellm', deps({ LITE_LLM_API_KEY: LITELLM_KEY }))

    expect(health.status).toBe('error')
    expect(health.httpStatus).toBe(403)
    expect(health.error).not.toContain(LITELLM_KEY)
    expect(health.error).toContain('[REDACTED]')
  })

  it('passa redirect:error e redige antes do corte de 200 chars', async () => {
    const body = 'y'.repeat(190) + LITELLM_KEY
    const fetchMock = vi.fn(async () => new Response(body, { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const health = await healthCheck('litellm', deps({ LITE_LLM_API_KEY: LITELLM_KEY }))

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(init.redirect).toBe('error')
    expect(health.status).toBe('error')
    // Segredo na fronteira do slice: redigir DEPOIS do corte vazaria o prefixo.
    expect(health.error).not.toContain(LITELLM_KEY.slice(0, 8))
    expect(health.error).toContain('[REDACTED]')
  })
})

describe('serviceStatuses', () => {
  beforeEach(() => {
    clearServiceHealthCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('agrega configured + health + última auditoria por serviço', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse('{}')),
    )
    const lastLitellm: ServiceAuditEntry = {
      id: 'a-1',
      ts: 1,
      sessionId: null,
      service: 'litellm',
      operation: 'chat_completions',
      status: 'ok',
      durationMs: 10,
      error: null,
    }
    const d = deps(
      { LITE_LLM_API_KEY: LITELLM_KEY },
      {
        lastCall: vi.fn((service: string) => (service === 'litellm' ? lastLitellm : null)),
      },
    )

    const statuses = await serviceStatuses(d)

    expect(statuses).toHaveLength(6)
    const litellm = statuses.find((s) => s.id === 'litellm')
    expect(litellm).toMatchObject({
      configured: true,
      health: { status: 'ok' },
      lastCall: lastLitellm,
    })
    expect(statuses.find((s) => s.id === 'gemini')).toMatchObject({
      configured: false,
      health: { status: 'unconfigured' },
      lastCall: null,
    })
    expect(statuses.find((s) => s.id === 'tavily')?.health.status).toBe('unsupported')
  })
})
