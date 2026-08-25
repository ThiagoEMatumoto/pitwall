import {
  SERVICE_REGISTRY,
  getService,
  resolveServiceVar,
  type OperationDef,
  type ServiceDef,
  type ServiceId,
} from '../../../shared/service-registry'
import type {
  ServiceAuditEntry,
  ServiceHealth,
  ServiceStatusEntry,
} from '../../../shared/types/ipc'
import { createSecretRedactor, getEnvVar } from './custom-env'
import {
  lastServiceCall,
  recordServiceCall,
  type RecordServiceCallInput,
} from './service-audit-store'

// Engine do proxy de serviços (env hub). A sessão MCP pede {service, operation,
// params}; o main valida contra o registry, injeta a credencial e faz o fetch.
// Invariantes de segurança:
// - URL SÓ do registry (baseUrls + pathTemplate) — nunca vinda de params.
// - params validados pelo paramsSchema (strict) antes de qualquer uso.
// - credencial resolvida via getEnvVar no main; nunca aparece no resultado.
// - TUDO que sai (corpo, erro) passa por createSecretRedactor com snapshot das
//   vars do serviço, e o erro persiste na auditoria JÁ redigido.

export const CALL_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024
export const HEALTH_TTL_MS = 5 * 60_000
const HEALTH_TIMEOUT_MS = 10_000

export interface ServiceProxyDeps {
  getEnvVar: (key: string) => string | undefined
  recordCall: (input: RecordServiceCallInput) => unknown
  lastCall: (service: string) => ServiceAuditEntry | null
  now: () => number
}

function withDefaults(over: Partial<ServiceProxyDeps>): ServiceProxyDeps {
  return {
    getEnvVar,
    recordCall: recordServiceCall,
    lastCall: lastServiceCall,
    now: Date.now,
    ...over,
  }
}

export type ServiceCallResult =
  | {
      ok: true
      status: number
      durationMs: number
      body: string
      truncated: boolean
    }
  | { ok: false; status: number; durationMs: number; error: string }

// Snapshot dos valores das vars do serviço (canônica + aliases) pro redator.
// Inclui as não-secretas de propósito: o redator já ignora valores curtos, e
// username vazando em log é vazamento do mesmo jeito.
function secretSnapshot(def: ServiceDef, getVar: ServiceProxyDeps['getEnvVar']) {
  const out: Record<string, string> = {}
  for (const varDef of def.vars) {
    for (const key of [varDef.canonical, ...varDef.aliases]) {
      const value = getVar(key)
      if (value) out[key] = value
    }
  }
  return out
}

function authHeaders(def: ServiceDef, key: string): Record<string, string> {
  if (def.auth?.scheme === 'bearer') return { Authorization: `Bearer ${key}` }
  if (def.auth?.scheme === 'xi-api-key') return { 'xi-api-key': key }
  return {}
}

// Substitui {name} do template pelo param homônimo (URL-encoded) e o REMOVE do
// corpo. Placeholder sem param string vira erro — nunca 'undefined' na URL.
function buildPath(
  op: OperationDef,
  params: Record<string, unknown>,
): { path: string; rest: Record<string, unknown> } | { pathError: string } {
  const rest = { ...params }
  let missing: string | null = null
  const path = op.pathTemplate.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = rest[name]
    if (typeof value !== 'string' || value === '') {
      missing = name
      return ''
    }
    delete rest[name]
    return encodeURIComponent(value)
  })
  if (missing) return { pathError: `parâmetro de path ausente: ${missing}` }
  return { path, rest }
}

function truncateBody(raw: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(raw, 'utf8')
  if (buf.byteLength <= maxBytes) return { text: raw, truncated: false }
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

// Lê o body como stream e ABORTA o download logo além do cap — res.text()
// bufferizaria uma resposta arbitrariamente grande antes de qualquer corte.
// A margem existe pra que um segredo cortado exatamente em maxBytes ainda
// apareça inteiro pro redator; o truncateBody final (pós-redação) descarta o
// excedente.
const CAP_MARGIN_BYTES = 64 * 1024

async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<{ raw: string; capped: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) return { raw: await res.text().catch(() => ''), capped: false }
  const hardCap = maxBytes + CAP_MARGIN_BYTES
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (total < hardCap) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      total += value.byteLength
    }
  } catch {
    // Rede caiu no meio: segue com o que chegou (já redigido adiante).
  }
  if (total >= hardCap) await reader.cancel().catch(() => {})
  return {
    raw: Buffer.concat(chunks).toString('utf8'),
    capped: total >= hardCap,
  }
}

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
}

export async function callService(
  serviceId: string,
  operationId: string,
  params: unknown,
  opts: { sessionId?: string | null; deps?: Partial<ServiceProxyDeps> } = {},
): Promise<ServiceCallResult> {
  const d = withDefaults(opts.deps ?? {})
  const def = SERVICE_REGISTRY.find((s) => s.id === serviceId)
  if (!def) {
    return {
      ok: false,
      status: 0,
      durationMs: 0,
      error: `serviço desconhecido: ${serviceId}`,
    }
  }

  const redact = createSecretRedactor(secretSnapshot(def, d.getEnvVar))
  const fail = (status: number, durationMs: number, rawError: string): ServiceCallResult => {
    const error = redact(rawError)
    d.recordCall({
      sessionId: opts.sessionId ?? null,
      service: def.id,
      operation: operationId,
      status: 'error',
      durationMs,
      error,
    })
    return { ok: false, status, durationMs, error }
  }

  const op = def.operations[operationId]
  if (!op) return fail(0, 0, `operação desconhecida em ${def.id}: ${operationId}`)

  const parsed = op.paramsSchema.safeParse(params)
  if (!parsed.success) return fail(0, 0, `params inválidos: ${zodIssues(parsed.error)}`)

  const base = def.baseUrls[op.env]
  if (!base) return fail(0, 0, `serviço ${def.id} não tem base URL para o ambiente ${op.env}`)

  let key: string | undefined
  if (def.auth) {
    key = resolveServiceVar(def, def.auth.varCanonical, d.getEnvVar)
    if (!key) return fail(0, 0, `credencial não configurada: ${def.auth.varCanonical}`)
  }

  const built = buildPath(op, parsed.data as Record<string, unknown>)
  if ('pathError' in built) return fail(0, 0, built.pathError)

  const url = new URL(base + built.path)
  if (def.auth?.scheme === 'query-key' && key) url.searchParams.set('key', key)

  const headers: Record<string, string> = key ? authHeaders(def, key) : {}
  let body: string | undefined
  if (op.method === 'GET') {
    for (const [name, value] of Object.entries(built.rest)) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }
  } else {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(built.rest)
  }

  const started = d.now()
  let res: Response
  try {
    res = await fetch(url, {
      method: op.method,
      headers,
      body,
      // Redirect vaza header de auth pro host de destino; nenhuma operação do
      // registry precisa seguir 3xx.
      redirect: 'error',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
  } catch {
    return fail(0, d.now() - started, 'sem resposta do serviço (rede, redirect ou timeout em 30s)')
  }

  const maxBytes = op.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const { raw, capped } = await readBodyCapped(res, maxBytes)
  const durationMs = d.now() - started
  // Redige o texto INTEGRAL antes de qualquer corte: truncar/slice primeiro
  // bissectaria um segredo na fronteira e vazaria o prefixo que o redator não vê.
  const redacted = redact(raw)
  const { text, truncated } = truncateBody(redacted, maxBytes)

  if (!res.ok) return fail(res.status, durationMs, `HTTP ${res.status}: ${text.slice(0, 2000)}`)

  d.recordCall({
    sessionId: opts.sessionId ?? null,
    service: def.id,
    operation: operationId,
    status: 'ok',
    durationMs,
  })
  return {
    ok: true,
    status: res.status,
    durationMs,
    body: text,
    truncated: truncated || capped,
  }
}

// ---------------------------------------------------------------------------
// Health check (cache TTL 5min)
// ---------------------------------------------------------------------------

const healthCache = new Map<ServiceId, ServiceHealth>()

export function clearServiceHealthCache(): void {
  healthCache.clear()
}

export async function healthCheck(
  serviceId: ServiceId,
  deps: Partial<ServiceProxyDeps> = {},
): Promise<ServiceHealth> {
  const d = withDefaults(deps)
  const cached = healthCache.get(serviceId)
  if (cached && d.now() - cached.checkedAt < HEALTH_TTL_MS) return cached
  const fresh = await runHealthCheck(getService(serviceId), d)
  healthCache.set(serviceId, fresh)
  return fresh
}

async function runHealthCheck(def: ServiceDef, d: ServiceProxyDeps): Promise<ServiceHealth> {
  const checkedAt = d.now()
  // Serviço sem descritor de health (Tavily, LegalCore, LaaS): o card mostra só
  // "configurado" — não há endpoint barato e seguro pra sondar.
  if (!def.health || !def.auth) return { status: 'unsupported', checkedAt }

  const key = resolveServiceVar(def, def.auth.varCanonical, d.getEnvVar)
  if (!key) return { status: 'unconfigured', checkedAt }

  const base = def.baseUrls.prod ?? def.baseUrls.staging
  if (!base) return { status: 'unsupported', checkedAt }

  const redact = createSecretRedactor(secretSnapshot(def, d.getEnvVar))
  const url = new URL(base + def.health.path)
  if (def.auth.scheme === 'query-key') url.searchParams.set('key', key)

  try {
    const res = await fetch(url, {
      method: def.health.method,
      headers: authHeaders(def, key),
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (res.ok) return { status: 'ok', checkedAt, httpStatus: res.status }
    const raw = await res.text().catch(() => '')
    // Redige o texto INTEGRAL e só então corta (slice antes bissectaria segredo).
    return {
      status: 'error',
      checkedAt,
      httpStatus: res.status,
      error: `HTTP ${res.status}: ${redact(raw).slice(0, 200)}`,
    }
  } catch {
    return {
      status: 'error',
      checkedAt,
      error: 'sem resposta (rede ou tempo esgotado)',
    }
  }
}

// ---------------------------------------------------------------------------
// Status agregado pros cards da aba Integrações
// ---------------------------------------------------------------------------

// Mesma régua da UI: required todas presentes; serviço sem required conta
// qualquer var conhecida. Presença via getEnvVar (cofre + process.env).
function isConfigured(def: ServiceDef, getVar: ServiceProxyDeps['getEnvVar']): boolean {
  const required = def.vars.filter((v) => v.required)
  const present = (v: { canonical: string }) =>
    resolveServiceVar(def, v.canonical, getVar) !== undefined
  return required.length > 0 ? required.every(present) : def.vars.some(present)
}

export async function serviceStatuses(
  deps: Partial<ServiceProxyDeps> = {},
): Promise<ServiceStatusEntry[]> {
  const d = withDefaults(deps)
  return Promise.all(
    SERVICE_REGISTRY.map(async (def) => ({
      id: def.id,
      title: def.title,
      configured: isConfigured(def, d.getEnvVar),
      health: await healthCheck(def.id, deps),
      lastCall: d.lastCall(def.id),
    })),
  )
}
