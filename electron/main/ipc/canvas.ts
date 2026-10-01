import { ipcMain } from 'electron'
import { z } from 'zod'
import * as store from '../services/canvas-store'
import { broadcast } from '../services/notify'
import { summarizeWhereLeftOff } from '../services/session-purpose'
import type {
  CanvasNote,
  CanvasState,
  CanvasUpdatedEvent,
  SessionGroup,
  SummarizeSessionResult,
} from '../../../shared/types/canvas'

const scope = z.string().min(1)
const id = z.string().min(1)
const color = z.string().max(32).nullable()

const scopeSchema = z.object({ scope })
const positionsSchema = z.object({
  scope,
  items: z
    .array(
      z.object({
        kind: z.enum(['session', 'note', 'group', 'lane']),
        entityId: id,
        x: z.number().finite(),
        y: z.number().finite(),
        w: z.number().finite().positive().nullable().optional(),
        h: z.number().finite().positive().nullable().optional(),
      }),
    )
    .max(2000),
})
const viewStatesSchema = z.object({
  scope,
  items: z
    .array(z.object({ sessionId: id, viewState: z.enum(['collapsed', 'open', 'terminal']) }))
    .max(2000),
})
const noteCreateSchema = z.object({
  scope,
  bodyMd: z.string().max(20_000),
  attachedSessionId: id.nullable().optional(),
  color: color.optional(),
})
const noteUpdateSchema = z.object({
  id,
  bodyMd: z.string().max(20_000).optional(),
  attachedSessionId: id.nullable().optional(),
  color: color.optional(),
})
const groupCreateSchema = z.object({
  scope,
  name: z.string().trim().min(1).max(80),
  color: color.optional(),
})
const groupUpdateSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80).optional(),
  color: color.optional(),
})
const idSchema = z.object({ id })
const sessionGroupSchema = z.object({ sessionId: id, groupId: id.nullable() })
const purposeSchema = z.object({ sessionId: id, purpose: z.string().max(500).nullable() })
const summarizeSchema = z.object({ sessionId: id })

// Posições não emitem: quem arrastou já tem o estado, e cada soltura de card
// reconstruiria o grafo em todas as janelas à toa.
function changed(event: CanvasUpdatedEvent): void {
  broadcast('canvas:updated', event)
}

export async function summarizeSession(sessionId: string): Promise<SummarizeSessionResult> {
  const ccSessionId = store.sessionCcId(sessionId)
  if (!ccSessionId) return { ok: false, error: 'A sessão ainda não tem id do Claude.' }
  const result = await summarizeWhereLeftOff(ccSessionId)
  if (!result.ok) return result
  const at = Date.now()
  store.setSessionSummary(sessionId, result.summary, at)
  changed({ scope: null })
  return { ok: true, summary: result.summary, at }
}

export function registerCanvasIpc(): void {
  ipcMain.handle('canvas:get', (_e, input: unknown): CanvasState => {
    return store.getCanvas(scopeSchema.parse(input).scope)
  })
  ipcMain.handle('canvas:set-positions', (_e, input: unknown): void => {
    const { scope: s, items } = positionsSchema.parse(input)
    store.setPositions(s, items)
  })
  // Também sem broadcast: quem abriu/recolheu o cartão já aplicou local.
  ipcMain.handle('canvas:set-view-states', (_e, input: unknown): void => {
    const { scope: s, items } = viewStatesSchema.parse(input)
    store.setViewStates(s, items)
  })
  ipcMain.handle('canvas:clear-positions', (_e, input: unknown): void => {
    const { scope: s } = scopeSchema.parse(input)
    store.clearPositions(s)
    changed({ scope: s })
  })

  ipcMain.handle('canvas:note-create', (_e, input: unknown): CanvasNote => {
    const note = store.createNote(noteCreateSchema.parse(input))
    changed({ scope: note.scope })
    return note
  })
  ipcMain.handle('canvas:note-update', (_e, input: unknown): CanvasNote => {
    const note = store.updateNote(noteUpdateSchema.parse(input))
    changed({ scope: note.scope })
    return note
  })
  ipcMain.handle('canvas:note-delete', (_e, input: unknown): void => {
    store.deleteNote(idSchema.parse(input).id)
    changed({ scope: null })
  })

  ipcMain.handle('canvas:group-create', (_e, input: unknown): SessionGroup => {
    const group = store.createGroup(groupCreateSchema.parse(input))
    changed({ scope: group.scope })
    return group
  })
  ipcMain.handle('canvas:group-update', (_e, input: unknown): SessionGroup => {
    const group = store.updateGroup(groupUpdateSchema.parse(input))
    changed({ scope: group.scope })
    return group
  })
  ipcMain.handle('canvas:group-delete', (_e, input: unknown): void => {
    store.deleteGroup(idSchema.parse(input).id)
    changed({ scope: null })
  })

  ipcMain.handle('canvas:session-group-set', (_e, input: unknown): void => {
    const { sessionId, groupId } = sessionGroupSchema.parse(input)
    store.setSessionGroup(sessionId, groupId)
    changed({ scope: null })
  })
  ipcMain.handle('canvas:purpose-set', (_e, input: unknown): void => {
    const { sessionId, purpose } = purposeSchema.parse(input)
    store.setSessionPurpose(sessionId, purpose)
    changed({ scope: null })
  })
  ipcMain.handle('canvas:summarize', (_e, input: unknown): Promise<SummarizeSessionResult> => {
    return summarizeSession(summarizeSchema.parse(input).sessionId)
  })
}
