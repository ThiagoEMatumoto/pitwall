// A seção "Integrações" da EnvVarsTab deriva do service registry: UM card por
// SERVIÇO, com as vars dele dentro (canônicas). O registry é a fonte única;
// aqui fica só o metadado de apresentação.

import { SERVICE_REGISTRY, type ServiceId } from './service-registry'

export interface KnownIntegrationVar {
  envKey: string
  required: boolean
  // secret:false (username, URL) NÃO deve virar input type=password na UI.
  secret: boolean
}

export interface KnownIntegration {
  serviceId: ServiceId
  label: string
  unlocks: string
  docsUrl: string
  vars: KnownIntegrationVar[]
}

const SERVICE_META: Record<ServiceId, { unlocks: string; docsUrl: string }> = {
  litellm: {
    unlocks: 'Chamadas de LLM via gateway LiteLLM',
    docsUrl: 'https://docs.litellm.ai',
  },
  gemini: {
    unlocks: 'Modelos Gemini (atelier, extração)',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  legal_core: {
    unlocks: 'API do LegalCore e login do legal-ui',
    docsUrl: 'https://github.com/lexter-ai/legal-core',
  },
  laas: {
    unlocks: 'Endpoints do LaaS / Legal Lab',
    docsUrl: 'https://github.com/lexter-ai/legal-ui',
  },
  elevenlabs: {
    unlocks: 'Síntese de voz (TTS)',
    docsUrl: 'https://elevenlabs.io',
  },
  tavily: { unlocks: 'Busca web dos Dossiês', docsUrl: 'https://tavily.com' },
}

export const KNOWN_INTEGRATIONS: KnownIntegration[] = SERVICE_REGISTRY.map((service) => ({
  serviceId: service.id,
  label: service.title,
  unlocks: SERVICE_META[service.id].unlocks,
  docsUrl: SERVICE_META[service.id].docsUrl,
  vars: service.vars.map((v) => ({
    envKey: v.canonical,
    required: v.required,
    secret: v.secret,
  })),
}))

// Todas as chaves canônicas conhecidas — separa "linha de integração" de
// "variável custom" na EnvVarsTab.
export const KNOWN_ENV_KEYS: ReadonlySet<string> = new Set(
  KNOWN_INTEGRATIONS.flatMap((i) => i.vars.map((v) => v.envKey)),
)
