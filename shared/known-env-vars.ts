// Compat: a lista que a UI (Configurações → Variáveis de ambiente) renderiza
// agora deriva do service registry — uma entrada por var de cada serviço. O
// registry é a fonte única; aqui fica só o metadado de apresentação.

import { SERVICE_REGISTRY, type ServiceId } from './service-registry'

export interface KnownEnvVar {
  envKey: string
  label: string
  unlocks: string
  docsUrl: string
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

export const KNOWN_ENV_VARS: KnownEnvVar[] = SERVICE_REGISTRY.flatMap((service) =>
  service.vars.map((v) => ({
    envKey: v.canonical,
    label: service.title,
    unlocks: SERVICE_META[service.id].unlocks,
    docsUrl: SERVICE_META[service.id].docsUrl,
  })),
)
