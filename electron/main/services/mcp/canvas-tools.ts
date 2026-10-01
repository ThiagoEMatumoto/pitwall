// Tools MCP do mapa de sessões: a própria sessão declara do que se trata e deixa
// notas no mapa. A identidade vem do ?s= carimbado pelo app no spawn — a sessão
// só escreve sobre SI mesma, nunca sobre um id que o modelo passou.
import * as z from 'zod/v4'
import * as canvasStore from '../canvas-store'
import { GLOBAL_CANVAS_SCOPE } from '../../../../shared/types/canvas'
import { ok, type McpNotify, type McpRequestContext, type ToolDef } from './tools'

const purposeSchema = z.object({
  purpose: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "One line (≤ 120 chars ideally), in the user's language: what this session is working on.",
    ),
})
const noteSchema = z.object({
  body: z.string().min(1).max(20_000).describe('Markdown body of the note.'),
  attachToSelf: z
    .boolean()
    .optional()
    .describe('Pin the note to the calling session (drawn with a dotted line to its card).'),
})

function requireCaller(ctx: McpRequestContext): string {
  if (!ctx.motherSessionId) {
    throw new Error(
      'Esta tool só funciona dentro de uma sessão aberta pelo Pitwall (sem identidade de sessão).',
    )
  }
  return ctx.motherSessionId
}

export function canvasTools(notify: McpNotify, ctx: McpRequestContext): ToolDef[] {
  return [
    {
      name: 'session_purpose_set',
      title: 'Declare session purpose',
      description:
        'Declare, in one line, what THIS session is about. Shown on the session map and in the sidebar so the user remembers what each session was for. Overwrites the previous purpose.',
      inputSchema: purposeSchema,
      handler: (args) => {
        const { purpose } = purposeSchema.parse(args)
        const sessionId = requireCaller(ctx)
        canvasStore.setSessionPurpose(sessionId, purpose)
        notify.broadcast('canvas:updated', { scope: null })
        return ok({ sessionId, purpose })
      },
    },
    {
      name: 'canvas_note_create',
      title: 'Create session map note',
      description:
        'Leave a markdown note on the session map (a plan, a decision, a TODO for the user). With attachToSelf it is pinned to the calling session.',
      inputSchema: noteSchema,
      handler: (args) => {
        const { body, attachToSelf } = noteSchema.parse(args)
        const note = canvasStore.createNote({
          scope: GLOBAL_CANVAS_SCOPE,
          bodyMd: body,
          attachedSessionId: attachToSelf ? requireCaller(ctx) : null,
        })
        notify.broadcast('canvas:updated', { scope: note.scope })
        return ok({ note })
      },
    },
  ]
}
