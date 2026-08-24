import { describe, expect, it } from 'vitest'
import { KNOWN_ENV_VARS } from './known-env-vars'
import { SERVICE_REGISTRY, getService, resolveServiceVar } from './service-registry'

const stubEnv =
  (vars: Record<string, string>) =>
  (key: string): string | undefined =>
    vars[key]

describe('SERVICE_REGISTRY shape', () => {
  it('conhece os 6 serviços do plano', () => {
    expect(SERVICE_REGISTRY.map((s) => s.id).sort()).toEqual([
      'elevenlabs',
      'gemini',
      'laas',
      'legal_core',
      'litellm',
      'tavily',
    ])
  })

  it('operations: litellm e gemini têm as reais; o resto segue vazio', () => {
    const litellm = getService('litellm').operations.chat_completions
    expect(litellm).toMatchObject({
      method: 'POST',
      pathTemplate: '/v1/chat/completions',
      env: 'staging',
    })
    expect(
      litellm.paramsSchema.safeParse({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'oi' }],
        max_tokens: 32,
      }).success,
    ).toBe(true)
    expect(litellm.paramsSchema.safeParse({ model: 'gpt-5', messages: [] }).success).toBe(false)
    expect(
      litellm.paramsSchema.safeParse({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'oi' }],
        extra: 'x',
      }).success,
    ).toBe(false)

    const gemini = getService('gemini').operations.generate_content
    expect(gemini).toMatchObject({
      method: 'POST',
      pathTemplate: '/v1beta/models/{model}:generateContent',
      env: 'prod',
    })
    expect(
      gemini.paramsSchema.safeParse({
        model: 'gemini-2.0-flash',
        contents: [{ role: 'user', parts: [{ text: 'oi' }] }],
      }).success,
    ).toBe(true)
    // model vai pro path: caracteres fora do allowlist são recusados na borda.
    expect(
      gemini.paramsSchema.safeParse({
        model: '../etc',
        contents: [{ parts: [{ text: 'oi' }] }],
      }).success,
    ).toBe(false)

    for (const s of SERVICE_REGISTRY) {
      if (s.id === 'litellm' || s.id === 'gemini') continue
      expect(s.operations).toEqual({})
    }
  })

  it('todo serviço com health ou operations declara auth com var do próprio serviço', () => {
    for (const s of SERVICE_REGISTRY) {
      if (!s.health && Object.keys(s.operations).length === 0) continue
      expect(s.auth).not.toBeNull()
      expect(s.vars.some((v) => v.canonical === s.auth?.varCanonical)).toBe(true)
    }
  })

  it('health: litellm/gemini/elevenlabs têm, tavily/legal_core/laas não', () => {
    expect(getService('litellm').health).toEqual({
      method: 'GET',
      path: '/v1/models',
      authHeader: 'bearer',
    })
    expect(getService('gemini').health).toEqual({
      method: 'GET',
      path: '/v1beta/models',
      authHeader: 'query-key',
    })
    expect(getService('elevenlabs').health).toEqual({
      method: 'GET',
      path: '/v1/user',
      authHeader: 'xi-api-key',
    })
    expect(getService('tavily').health).toBeNull()
    expect(getService('legal_core').health).toBeNull()
    expect(getService('laas').health).toBeNull()
  })

  it('toda var secret required tem canonical não-vazio e sem duplicatas globais', () => {
    const all = SERVICE_REGISTRY.flatMap((s) => s.vars.map((v) => v.canonical))
    expect(new Set(all).size).toBe(all.length)
    for (const name of all) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
  })

  it('base URL staging do LiteLLM vem de legal-core secrets.ts', () => {
    expect(getService('litellm').baseUrls.staging).toBe(
      'https://litellm-service-stg-2kzxgvaw5q-ue.a.run.app',
    )
    expect(getService('litellm').baseUrls.prod).toBeUndefined()
  })

  it('getService lança em id desconhecido', () => {
    expect(() => getService('nope' as never)).toThrow('unknown service')
  })
})

describe('resolveServiceVar', () => {
  it('resolve pelo nome canônico', () => {
    const value = resolveServiceVar(
      getService('litellm'),
      'LITE_LLM_API_KEY',
      stubEnv({ LITE_LLM_API_KEY: 'sk-canonical' }),
    )
    expect(value).toBe('sk-canonical')
  })

  it('cai no alias quando o canônico não existe (VOZ_TTS_KEY → ELEVENLABS_API_KEY)', () => {
    const value = resolveServiceVar(
      getService('elevenlabs'),
      'ELEVENLABS_API_KEY',
      stubEnv({ VOZ_TTS_KEY: 'el-alias' }),
    )
    expect(value).toBe('el-alias')
  })

  it('canônico tem precedência sobre alias', () => {
    const value = resolveServiceVar(
      getService('elevenlabs'),
      'ELEVENLABS_API_KEY',
      stubEnv({ ELEVENLABS_API_KEY: 'el-canonical', VOZ_TTS_KEY: 'el-alias' }),
    )
    expect(value).toBe('el-canonical')
  })

  it('undefined quando nada configurado ou var não pertence ao serviço', () => {
    expect(resolveServiceVar(getService('tavily'), 'TAVILY_API_KEY', stubEnv({}))).toBeUndefined()
    expect(
      resolveServiceVar(getService('tavily'), 'GEMINI_API_KEY', stubEnv({ GEMINI_API_KEY: 'x' })),
    ).toBeUndefined()
  })
})

describe('known-env-vars compat', () => {
  it('deriva uma entrada por var do registry, com shape da UI', () => {
    const total = SERVICE_REGISTRY.reduce((n, s) => n + s.vars.length, 0)
    expect(KNOWN_ENV_VARS).toHaveLength(total)
    for (const entry of KNOWN_ENV_VARS) {
      expect(entry.envKey).toBeTruthy()
      expect(entry.label).toBeTruthy()
      expect(entry.unlocks).toBeTruthy()
      expect(entry.docsUrl).toMatch(/^https:\/\//)
    }
  })

  it('mantém a entrada da Tavily que a EnvVarsTab já usava', () => {
    const tavily = KNOWN_ENV_VARS.find((v) => v.envKey === 'TAVILY_API_KEY')
    expect(tavily).toMatchObject({
      label: 'Tavily',
      unlocks: 'Busca web dos Dossiês',
      docsUrl: 'https://tavily.com',
    })
  })
})
