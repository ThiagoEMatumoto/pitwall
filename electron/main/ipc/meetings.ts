import { ipcMain } from 'electron'
import { z } from 'zod'
import * as meetingStore from '../services/meetings/meeting-store'
import {
  actionItemBatchRegistry,
  detectorRegistry,
  floatingRegistry,
  getRecorder,
  modelDownloadRegistry,
  resummarizeRegistry,
  setupCheckRegistry,
  speakerRenameRegistry,
} from '../services/meetings/recorder-contract'
import { broadcast } from '../services/notify'

const idSchema = z.string().min(1)

const startSchema = z.object({ title: z.string().optional() }).default({})

const updateSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  rawNotes: z.string().optional(),
  themLabel: z.string().optional(),
})

const quickNoteSchema = z.object({
  meetingId: z.string().min(1),
  text: z.string(),
})

const actionItemBatchSchema = z.object({
  meetingId: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1),
  action: z.enum(['create', 'dismiss']),
  overrides: z
    .record(
      z.string().min(1),
      z.object({ owner: z.string().nullable().optional(), title: z.string().min(1).optional() }),
    )
    .optional(),
})

const renameSpeakerSchema = z.object({
  meetingId: z.string().min(1),
  speakerId: z.string().min(1),
  name: z.string().trim().min(1),
})

const floatingSchema = z.object({ action: z.enum(['show', 'hide', 'toggle']) })

const detectionSchema = z.object({ action: z.enum(['record', 'ignore']) })

function unavailable(what: string): never {
  throw new Error(`${what} não disponível`)
}

export function registerMeetingsIpc(): void {
  ipcMain.handle('meetings:start', (_e, payload: unknown) => {
    const { title } = startSchema.parse(payload)
    return getRecorder().start({ title })
  })

  ipcMain.handle('meetings:stop', () => getRecorder().stop())

  ipcMain.handle('meetings:state', () => getRecorder().getState())

  ipcMain.handle('meetings:list', () => meetingStore.list())

  ipcMain.handle('meetings:get', (_e, payload: unknown) => {
    const id = idSchema.parse(payload)
    const detail = meetingStore.get(id)
    if (!detail) throw new Error(`Reunião não encontrada: ${id}`)
    return detail
  })

  ipcMain.handle('meetings:update', (_e, payload: unknown) => {
    const meeting = meetingStore.update(updateSchema.parse(payload))
    broadcast('meetings:event', { type: 'meeting', meeting })
    return meeting
  })

  // O recorder concatena a linha e emite o evento 'meeting' — o editor da
  // janela principal anexa em vez de sobrescrever.
  ipcMain.handle('meetings:quickNote', (_e, payload: unknown) => {
    const { meetingId, text } = quickNoteSchema.parse(payload)
    return getRecorder().appendQuickNote(meetingId, text)
  })

  ipcMain.handle('meetings:delete', (_e, payload: unknown) => {
    meetingStore.remove(idSchema.parse(payload))
  })

  ipcMain.handle('meetings:resummarize', (_e, payload: unknown) => {
    const id = idSchema.parse(payload)
    const run = resummarizeRegistry.current ?? unavailable('Resumo de reunião')
    return run(id)
  })

  ipcMain.handle('meetings:actionItems:batch', (_e, payload: unknown) => {
    const input = actionItemBatchSchema.parse(payload)
    const decide = actionItemBatchRegistry.current ?? unavailable('Tarefas de reunião')
    return decide(input)
  })

  ipcMain.handle('meetings:renameSpeaker', (_e, payload: unknown) => {
    const input = renameSpeakerSchema.parse(payload)
    const rename = speakerRenameRegistry.current ?? unavailable('Renomear participante')
    return rename(input)
  })

  ipcMain.handle('meetings:voices:list', () => meetingStore.listVoices())

  ipcMain.handle('meetings:voices:delete', (_e, payload: unknown) => {
    meetingStore.deleteVoice(idSchema.parse(payload))
  })

  ipcMain.handle('meetings:models:download', () => {
    const download = modelDownloadRegistry.current ?? unavailable('Download de modelos')
    return download()
  })

  ipcMain.handle('meetings:floating', (_e, payload: unknown) => {
    const { action } = floatingSchema.parse(payload)
    const control = floatingRegistry.current ?? unavailable('Janela flutuante')
    control(action)
  })

  ipcMain.handle('meetings:detection', (_e, payload: unknown) => {
    const { action } = detectionSchema.parse(payload)
    const detector = detectorRegistry.current ?? unavailable('Detecção de reunião')
    detector.decide(action)
  })

  ipcMain.handle('meetings:checkSetup', () => {
    const check = setupCheckRegistry.current ?? unavailable('Verificação de setup')
    return check()
  })
}
