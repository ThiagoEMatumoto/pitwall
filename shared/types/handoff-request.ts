// Pedido tipado da filha (ou da mãe, numa escalação) — migration 058.
export type RequestKind = 'decision' | 'confirmation' | 'human_action' | 'question'
export type RequestResolver = 'mother' | 'human_only'
export type RequestRisk = 'destructive_data' | 'deploy_infra_spend'
export type RequestStatus = 'open' | 'answered' | 'rejected' | 'cancelled'
export type RequestAddressee = 'mother' | 'human'

export interface RequestOption {
  key: string
  label: string
  detail?: string
}

export interface HandoffRequest {
  id: string
  handoffId: string
  // Quem perguntou (filha, ou a mãe numa escalação nova): destinatário da resposta.
  askerSessionId: string | null
  // sessions.id da mãe que escalou: também recebe a resposta.
  escalatedBy: string | null
  kind: RequestKind
  question: string
  options: RequestOption[] // [] para question/human_action
  recommendation: string | null // key de uma option, ou texto livre se options=[]
  costOfError: string | null
  risk: RequestRisk | null
  resolver: RequestResolver
  addressee: RequestAddressee
  status: RequestStatus
  answer: string | null
  answerNote: string | null
  answeredBy: 'mother' | 'human' | null
  idempotencyKey: string | null
  createdAt: number
  escalatedAt: number | null
  resolvedAt: number | null
}

export interface CreateRequestInput {
  kind?: RequestKind
  question: string
  options?: RequestOption[]
  recommendation?: string | null
  costOfError?: string | null
  risk?: RequestRisk | null
  resolver?: RequestResolver
  idempotencyKey?: string | null
  escalatedBy?: string | null
}

export const HUMAN_ONLY_RISKS: readonly RequestRisk[] = ['destructive_data', 'deploy_infra_spend']

// Ninguém rebaixa human_only para mother: qualquer risco declarado já basta.
export function resolverFor(risk: RequestRisk | null | undefined, asked?: RequestResolver): RequestResolver {
  return risk || asked === 'human_only' ? 'human_only' : 'mother'
}

// IPC handoffs:answer-request (resposta do humano pela Room).
export interface AnswerHandoffRequestInput {
  requestId: string
  choice?: string
  text?: string
  reject?: boolean
  idempotencyKey?: string
}
