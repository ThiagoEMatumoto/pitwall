import { z } from 'zod'

// Registro central dos serviços que o env hub conhece: quais env vars cada um
// usa (canônica + aliases legados), base URLs por ambiente, health-check e as
// operações que o proxy MCP pode executar. Valores de credencial NUNCA moram
// aqui — o registry só descreve nomes e formas; quem resolve valor é o main
// via getEnvVar. Nomes e URLs abaixo vieram de varredura dos .env reais e do
// código dos repos (legal-core/src/cli/shared/secrets.ts, job-kickoff.ts,
// legal-ui/.env, applicant-portal/.env.example, atelier/.env, voz.env).

export type ServiceId = 'litellm' | 'gemini' | 'legal_core' | 'laas' | 'elevenlabs' | 'tavily'

export type ServiceEnv = 'staging' | 'prod'

export interface ServiceVarDef {
  canonical: string
  aliases: readonly string[]
  required: boolean
  secret: boolean
}

export type HealthAuth = 'bearer' | 'query-key' | 'xi-api-key'

export interface HealthDef {
  method: 'GET'
  path: string
  authHeader: HealthAuth
}

// Como o serviço autentica QUALQUER chamada (proxy e health): esquema + qual
// var do próprio serviço carrega a credencial. null = serviço sem chamada
// autenticável pelo proxy (só status de configuração).
export interface ServiceAuthDef {
  scheme: HealthAuth
  varCanonical: string
}

export interface OperationDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  pathTemplate: string
  env: ServiceEnv
  paramsSchema: z.ZodType
  maxResponseBytes?: number
}

export interface ServiceDef {
  id: ServiceId
  title: string
  vars: readonly ServiceVarDef[]
  baseUrls: { staging?: string; prod?: string }
  auth: ServiceAuthDef | null
  health: HealthDef | null
  operations: Record<string, OperationDef>
}

export const SERVICE_REGISTRY: readonly ServiceDef[] = [
  {
    id: 'litellm',
    title: 'LiteLLM',
    vars: [
      {
        canonical: 'LITE_LLM_API_KEY',
        aliases: [],
        required: true,
        secret: true,
      },
    ],
    baseUrls: {
      // legal-core/src/cli/shared/secrets.ts:14
      staging: 'https://litellm-service-stg-2kzxgvaw5q-ue.a.run.app',
      prod: undefined,
    },
    auth: { scheme: 'bearer', varCanonical: 'LITE_LLM_API_KEY' },
    health: { method: 'GET', path: '/v1/models', authHeader: 'bearer' },
    operations: {
      chat_completions: {
        method: 'POST',
        pathTemplate: '/v1/chat/completions',
        env: 'staging',
        paramsSchema: z.strictObject({
          model: z.string().min(1),
          messages: z
            .array(
              z.strictObject({
                role: z.enum(['system', 'user', 'assistant']),
                content: z.string(),
              }),
            )
            .min(1),
          // Cap defensivo de custo: chamada via proxy é utilitária, não geração longa.
          max_tokens: z.number().int().positive().max(4096).optional(),
        }),
      },
    },
  },
  {
    id: 'gemini',
    title: 'Gemini',
    vars: [
      {
        canonical: 'GEMINI_API_KEY',
        aliases: [],
        required: true,
        secret: true,
      },
    ],
    baseUrls: {
      staging: undefined,
      prod: 'https://generativelanguage.googleapis.com',
    },
    auth: { scheme: 'query-key', varCanonical: 'GEMINI_API_KEY' },
    health: { method: 'GET', path: '/v1beta/models', authHeader: 'query-key' },
    operations: {
      generate_content: {
        method: 'POST',
        // {model} sai de params (validado + URL-encoded pelo proxy).
        pathTemplate: '/v1beta/models/{model}:generateContent',
        env: 'prod',
        paramsSchema: z.strictObject({
          model: z
            .string()
            .min(1)
            .regex(/^[a-zA-Z0-9._-]+$/),
          contents: z
            .array(
              z.strictObject({
                role: z.enum(['user', 'model']).optional(),
                parts: z.array(z.strictObject({ text: z.string() })).min(1),
              }),
            )
            .min(1),
        }),
      },
    },
  },
  {
    id: 'legal_core',
    title: 'LegalCore',
    vars: [
      {
        canonical: 'CORE_USERNAME',
        aliases: [],
        required: true,
        secret: false,
      },
      { canonical: 'CORE_PASSWORD', aliases: [], required: true, secret: true },
      {
        canonical: 'LEGAL_CORE_API_URL',
        aliases: [],
        required: false,
        secret: false,
      },
      {
        canonical: 'LEGAL_CORE_APPLICANT_USER',
        aliases: [],
        required: false,
        secret: false,
      },
      {
        canonical: 'LEGAL_CORE_APPLICANT_PASSWORD',
        aliases: [],
        required: false,
        secret: true,
      },
      {
        canonical: 'LEGAL_UI_STAGING_USERNAME',
        aliases: [],
        required: false,
        secret: false,
      },
      {
        canonical: 'LEGAL_UI_STAGING_PASSWORD',
        aliases: [],
        required: false,
        secret: true,
      },
      {
        canonical: 'LEGAL_UI_PROD_USERNAME',
        aliases: [],
        required: false,
        secret: false,
      },
      {
        canonical: 'LEGAL_UI_PROD_PASSWORD',
        aliases: [],
        required: false,
        secret: true,
      },
    ],
    baseUrls: {
      // legal-ui/.env VITE_API_URL aponta pro root do legal-core
      staging: 'https://core.legalstaging.lexter.ai',
      prod: undefined,
    },
    auth: null,
    health: null,
    operations: {},
  },
  {
    id: 'laas',
    title: 'LaaS / Legal Lab',
    vars: [
      {
        canonical: 'VITE_API_URL',
        aliases: [],
        required: false,
        secret: false,
      },
      {
        canonical: 'VITE_COPILOT_API_URL',
        aliases: [],
        required: false,
        secret: false,
      },
    ],
    baseUrls: {
      // legal-ui/.env VITE_COPILOT_API_URL
      staging: 'https://copilot-api-gateway-staging-79hbqyts.ue.gateway.dev',
      prod: undefined,
    },
    auth: null,
    health: null,
    operations: {},
  },
  {
    id: 'elevenlabs',
    title: 'ElevenLabs',
    vars: [
      {
        canonical: 'ELEVENLABS_API_KEY',
        aliases: ['VOZ_TTS_KEY'],
        required: true,
        secret: true,
      },
    ],
    baseUrls: { staging: undefined, prod: 'https://api.elevenlabs.io' },
    auth: { scheme: 'xi-api-key', varCanonical: 'ELEVENLABS_API_KEY' },
    health: { method: 'GET', path: '/v1/user', authHeader: 'xi-api-key' },
    operations: {},
  },
  {
    id: 'tavily',
    title: 'Tavily',
    vars: [
      {
        canonical: 'TAVILY_API_KEY',
        aliases: [],
        required: true,
        secret: true,
      },
    ],
    baseUrls: { staging: undefined, prod: 'https://api.tavily.com' },
    auth: { scheme: 'bearer', varCanonical: 'TAVILY_API_KEY' },
    health: null,
    operations: {},
  },
]

export function getService(id: ServiceId): ServiceDef {
  const def = SERVICE_REGISTRY.find((s) => s.id === id)
  if (!def) throw new Error(`unknown service: ${id}`)
  return def
}

// Precedência no padrão de voice-config: canônico primeiro, aliases na ordem
// declarada. getEnvVar é injetado (main usa custom-env; teste usa stub).
export function resolveServiceVar(
  def: ServiceDef,
  varCanonical: string,
  getEnvVar: (key: string) => string | undefined,
): string | undefined {
  const varDef = def.vars.find((v) => v.canonical === varCanonical)
  if (!varDef) return undefined
  for (const key of [varDef.canonical, ...varDef.aliases]) {
    const value = getEnvVar(key)
    if (value !== undefined) return value
  }
  return undefined
}
