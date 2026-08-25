// Tools MCP do proxy de serviços (env hub). Duas tools genéricas — a allowlist
// é dado (shared/service-registry), não código. Segurança:
// - valores de credencial NUNCA saem por aqui (nem em list, nem em call);
// - URL/rota vêm só do registry; params validados pelo engine (service-proxy);
// - corpo/erro chegam já redigidos pelo createSecretRedactor do engine;
// - toda chamada é auditada com o session_id carimbado no ctx (nunca dos args).
import * as z from 'zod/v4'
import { SERVICE_REGISTRY } from '../../../../shared/service-registry'
import { callService, serviceStatuses, type ServiceProxyDeps } from '../service-proxy'
import { ok, type McpRequestContext, type ToolDef } from './tools'

const serviceCallSchema = z.object({
  service: z.string().min(1),
  operation: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
})

// Teto proporcional sem infra nova: janela deslizante em memória, por sessão.
// Segura loop descontrolado de agente e abuso de custo; não é quota de billing.
export const RATE_LIMIT_CALLS = 20
export const RATE_LIMIT_WINDOW_MS = 60_000
const recentCallsBySession = new Map<string, number[]>()

export function serviceCallAllowed(sessionKey: string, now: number = Date.now()): boolean {
  const fresh = (recentCallsBySession.get(sessionKey) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  )
  const allowed = fresh.length < RATE_LIMIT_CALLS
  recentCallsBySession.set(sessionKey, allowed ? [...fresh, now] : fresh)
  return allowed
}

export function resetServiceCallThrottle(): void {
  recentCallsBySession.clear()
}

export function serviceTools(
  ctx: McpRequestContext,
  proxyDeps: Partial<ServiceProxyDeps> = {},
): ToolDef[] {
  return [
    {
      name: 'service_list',
      title: 'List external services',
      description:
        'External services the env hub knows: configured state, cached health and the operations service_call can execute (with a JSON Schema of their params). Credential values are never included.',
      inputSchema: z.object({}),
      handler: async () => {
        const statuses = await serviceStatuses(proxyDeps)
        const services = statuses.map((status) => {
          const def = SERVICE_REGISTRY.find((s) => s.id === status.id)
          const operations = Object.entries(def?.operations ?? {}).map(([id, op]) => ({
            id,
            method: op.method,
            env: op.env,
            params: z.toJSONSchema(op.paramsSchema),
          }))
          return { ...status, operations }
        })
        return ok({ services })
      },
    },
    {
      name: 'service_call',
      title: 'Call an external service operation',
      description:
        'Execute one operation from service_list. The app injects the credential and builds the URL from its registry — arbitrary URLs are impossible. Responses and errors are redacted; every call is audited.',
      inputSchema: serviceCallSchema,
      handler: async (args) => {
        const { service, operation, params } = serviceCallSchema.parse(args)
        // ctx.motherSessionId vem do ?s= que o CLIENTE escolheu ao conectar:
        // é rótulo DECLARADO, não identidade verificada. Serve de atribuição
        // na auditoria e de chave do throttle — nunca de autorização.
        const sessionKey = ctx.motherSessionId ?? 'anonymous'
        if (!serviceCallAllowed(sessionKey)) {
          return ok({
            ok: false,
            status: 429,
            durationMs: 0,
            error: `rate limit: máximo de ${RATE_LIMIT_CALLS} chamadas por minuto por sessão`,
          })
        }
        const result = await callService(service, operation, params ?? {}, {
          sessionId: ctx.motherSessionId,
          deps: proxyDeps,
        })
        return ok({ ...result })
      },
    },
  ]
}
