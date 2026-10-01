// Tools MCP agente↔agente (P7). Uma sessão pergunta a outra — de outro repo ou
// projeto — e lê a resposta estruturada, sem raspar a tela de ninguém. Quem
// pergunta/responde é o ?s= carimbado no spawn, nunca um argumento do modelo.
import * as z from 'zod/v4'
import {
  MAX_ASK_TEXT,
  MAX_REPLY_TEXT,
  MAX_WAIT_SECONDS,
  getAgentBus,
  type AgentBus,
} from '../agent-bus'
import { ok, type McpRequestContext, type ToolDef } from './tools'
import type { AgentPeer } from '../../../../shared/types/agent-bus'

const listSchema = z.object({
  scope: z
    .enum(['project', 'linked', 'all'])
    .optional()
    .describe(
      'project = same project as you; linked = your repo and repos connected to it (repo_connections_get); all (default) = every live session.',
    ),
})

const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .optional()
  .describe(`Block up to this many seconds (≤ ${MAX_WAIT_SECONDS}) waiting for the answer.`)

const askSchema = z
  .object({
    to: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Target session: its alias or address (as shown by agent_list) or its sessionId.'),
    repo: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Target repo (label or id) when you do not know the session: routed to the idlest/most recent live session there.',
      ),
    text: z
      .string()
      .trim()
      .min(1)
      .max(MAX_ASK_TEXT)
      .describe(
        'The question, self-contained (the other agent has none of your context). No secrets.',
      ),
    waitSeconds,
  })
  .refine((v) => v.to || v.repo, { message: 'Informe `to` ou `repo`.' })

const replySchema = z.object({
  askId: z.string().min(1).describe('The id attribute of the <pitwall-ask> you received.'),
  text: z
    .string()
    .trim()
    .min(1)
    .max(MAX_REPLY_TEXT)
    .describe('Your answer, complete and concrete.'),
})

const checkSchema = z.object({
  askId: z.string().min(1),
  waitSeconds,
})

function requireCaller(ctx: McpRequestContext): string {
  if (!ctx.motherSessionId) {
    throw new Error(
      'Esta tool só funciona dentro de uma sessão aberta pelo Pitwall (sem identidade de sessão).',
    )
  }
  return ctx.motherSessionId
}

function requireBus(): AgentBus {
  const bus = getAgentBus()
  if (!bus) throw new Error('Canal agente↔agente indisponível (o app ainda não terminou de subir).')
  return bus
}

function peerView(p: AgentPeer) {
  return {
    sessionId: p.sessionId,
    alias: p.alias,
    address: p.address,
    project: p.projectName,
    repo: p.repoLabel,
    repoId: p.repoId,
    provider: p.provider,
    status: p.status,
    purpose: p.purpose,
    lastActivityAt: p.lastActivityAt,
  }
}

export function agentTools(ctx: McpRequestContext): ToolDef[] {
  return [
    {
      name: 'agent_list',
      title: 'List live agent sessions',
      description:
        'List the OTHER live agent sessions the user has open in Pitwall (any repo/project): alias, project, repo, provider, status and purpose. Use it before agent_ask to find who owns the information you need (e.g. the session working on the API your front-end consumes).',
      inputSchema: listSchema,
      handler: (args) => {
        const { scope } = listSchema.parse(args)
        const caller = requireCaller(ctx)
        const bus = requireBus()
        const items = bus.list(caller, scope ?? 'all').map(peerView)
        const self = bus.list(null).find((p) => p.sessionId === caller)
        return ok({ you: self ? peerView(self) : null, items })
      },
    },
    {
      name: 'agent_ask',
      title: 'Ask another agent session',
      description:
        "Ask ANOTHER live agent session a question and get its answer back as structured data — use it when you need information that lives in another repo/project (an endpoint's contract, a schema, a decision taken there) instead of researching or editing that repo yourself. Address it by `to` (alias or sessionId from agent_list) or by `repo`. The question is delivered into the target's terminal only when it is idle, wrapped as <pitwall-ask>, and the target answers with agent_reply. Returns { askId, routedTo, mode }: mode 'delivered' or 'queued' (waiting for the target's turn to end); poll agent_check(askId) with backoff, or pass waitSeconds. mode 'needs-handoff' = nobody is live in that repo: nothing was sent; use session_handoff if the work is worth a new session. Guards: chain depth ≤ 3, rate limit per pair, answers expire after 15 min. Between two Claude sessions SendMessage to the target's `address` (from agent_list; not the alias, which may be a UI rename) also works; agent_ask adds routing by repo, the record and the expiry.",
      inputSchema: askSchema,
      handler: async (args) => {
        const { to, repo, text, waitSeconds: wait } = askSchema.parse(args)
        const caller = requireCaller(ctx)
        const bus = requireBus()
        const outcome = await bus.ask({ fromSessionId: caller, to, repo, text })
        if (!outcome.askId || !wait) return ok({ ...outcome })
        const checked = await bus.check(caller, outcome.askId, wait)
        return ok({ ...outcome, status: checked.status, reply: checked.reply })
      },
    },
    {
      name: 'agent_reply',
      title: 'Answer an agent question',
      description:
        'Answer a <pitwall-ask> that another agent session sent you (it arrives in your input as <pitwall-ask from="…" id="…">). Pass its id as askId and a complete, concrete answer: it goes straight back to the asker. Only the session the ask was delivered to can answer it.',
      inputSchema: replySchema,
      handler: (args) => {
        const { askId, text } = replySchema.parse(args)
        const message = requireBus().reply(requireCaller(ctx), askId, text)
        return ok({ askId, status: message.status, answeredAt: message.answeredAt })
      },
    },
    {
      name: 'agent_check',
      title: 'Check an agent question',
      description:
        'Check a question you sent with agent_ask: status pending | answered | expired, the reply when answered, and whether it has reached the target yet (delivered). waitSeconds (≤ 60) blocks until the answer arrives; poll with backoff (15s → 60s), never busy-loop.',
      inputSchema: checkSchema,
      handler: async (args) => {
        const { askId, waitSeconds: wait } = checkSchema.parse(args)
        return ok({ ...(await requireBus().check(requireCaller(ctx), askId, wait ?? 0)) })
      },
    },
  ]
}
