import { ipcMain } from 'electron'
import { z } from 'zod'
import { findTranscriptPath } from '../services/transcript-path'
import {
  importMotherPins,
  inheritMotherPin,
  listMotherPins,
  motherPinKeyOf,
  setMotherPin,
} from '../services/mother-pins-store'
import { broadcastMotherPins, promoteToMother, runRestart } from '../services/handoff/promote'
import type { MotherPin, PromoteMotherResult } from '../../../shared/types/mother-pins'

const setSchema = z.object({ sessionId: z.string().min(1), pinned: z.boolean() })
const importSchema = z.object({
  keys: z.array(z.string().min(1)).max(500),
  sessionIds: z.array(z.string().min(1)).max(500),
})
const inheritSchema = z.object({ fromKey: z.string().min(1), sessionId: z.string().min(1) })
const promoteSchema = z.object({
  sessionId: z.string().min(1),
  restart: z.enum(['now', 'when-idle']),
})

export function setMotherPinForSession(sessionId: string, pinned: boolean): MotherPin[] {
  const key = motherPinKeyOf(sessionId)
  if (!key) throw new Error(`Sessão não encontrada: ${sessionId}`)
  if (setMotherPin(key, pinned)) broadcastMotherPins()
  return listMotherPins()
}

export function registerMotherPinsIpc(): void {
  ipcMain.handle('mother-pins:list', (): MotherPin[] => listMotherPins())
  ipcMain.handle('mother-pins:set', (_e, raw: unknown): MotherPin[] => {
    const { sessionId, pinned } = setSchema.parse(raw)
    return setMotherPinForSession(sessionId, pinned)
  })
  ipcMain.handle('mother-pins:import', (_e, raw: unknown): MotherPin[] => {
    const { keys, sessionIds } = importSchema.parse(raw)
    const resolved = sessionIds.flatMap((id) => {
      const k = motherPinKeyOf(id)
      return k ? [k] : []
    })
    if (importMotherPins([...keys, ...resolved]) > 0) broadcastMotherPins()
    return listMotherPins()
  })
  ipcMain.handle('mother-pins:inherit', (_e, raw: unknown): MotherPin[] => {
    const { fromKey, sessionId } = inheritSchema.parse(raw)
    const hasTranscript = (cc: string) => findTranscriptPath(cc) !== null
    if (inheritMotherPin(fromKey, sessionId, { hasTranscript })) broadcastMotherPins()
    return listMotherPins()
  })
  ipcMain.handle('mother-pins:promote', (_e, raw: unknown): PromoteMotherResult =>
    promoteToMother(promoteSchema.parse(raw)),
  )
  ipcMain.handle('mother-pins:restart-now', async (_e, raw: unknown): Promise<void> => {
    await runRestart(z.string().min(1).parse(raw))
  })
}
