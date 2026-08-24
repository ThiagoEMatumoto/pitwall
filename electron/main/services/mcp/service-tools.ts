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
        const result = await callService(service, operation, params ?? {}, {
          sessionId: ctx.motherSessionId,
          deps: proxyDeps,
        })
        return ok({ ...result })
      },
    },
  ]
}
