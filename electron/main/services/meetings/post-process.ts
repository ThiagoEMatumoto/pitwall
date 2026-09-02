// Dono da transição 'processing' → 'done'/'error': resumo + extração de tarefas
// após stop(), re-execução sob demanda (resummarize) e decisão do usuário sobre
// itens propostos. Registra nos registries de recorder-contract.ts.
import type { Meeting, MeetingActionItem, MeetingActionItemDecision } from '../../../../shared/types/meetings'
import { notify as defaultNotify } from '../notifications'
import { emitMeetingEvent } from './event-bus'
import { createMeetingTask, extractActionItems } from './extract-actions'
import * as meetingStore from './meeting-store'
import { actionItemRegistry, postProcessRegistry, resummarizeRegistry } from './recorder-contract'
import { summarizeMeeting } from './summarize'

export interface PostProcessDeps {
  store: Pick<typeof meetingStore, 'get' | 'setStatus' | 'getActionItem' | 'setActionItemStatus'>
  summarize: (meetingId: string) => Promise<Meeting>
  extract: (meetingId: string) => Promise<MeetingActionItem[]>
  createTask: typeof createMeetingTask
  emit: typeof emitMeetingEvent
  notify: (input: { title: string; body: string }) => void
}

function defaultDeps(): PostProcessDeps {
  return {
    store: meetingStore,
    summarize: (id) => summarizeMeeting(id),
    extract: (id) => extractActionItems(id),
    createTask: createMeetingTask,
    emit: emitMeetingEvent,
    notify: defaultNotify,
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createPostProcessor(overrides: Partial<PostProcessDeps> = {}) {
  const deps: PostProcessDeps = { ...defaultDeps(), ...overrides }

  // Nunca rejeita: falha vira status 'error' + notificação. O recorder também
  // tem um catch, mas quem registra aqui é dono do estado final.
  const run = async (meetingId: string): Promise<Meeting> => {
    try {
      await deps.summarize(meetingId)
      await deps.extract(meetingId)
      const meeting = deps.store.setStatus(meetingId, 'done')
      deps.emit({ type: 'meeting', meeting })
      deps.notify({ title: 'Reunião processada', body: meeting.title })
      return meeting
    } catch (err) {
      const message = errorText(err)
      const meeting = deps.store.setStatus(meetingId, 'error', { error: message })
      deps.emit({ type: 'meeting', meeting })
      deps.notify({ title: 'Falha ao processar reunião', body: message })
      return meeting
    }
  }

  const resummarize = async (meetingId: string): Promise<Meeting> => {
    const meeting = deps.store.setStatus(meetingId, 'processing')
    deps.emit({ type: 'meeting', meeting })
    return run(meetingId)
  }

  const decide = async ({ id, status }: MeetingActionItemDecision): Promise<MeetingActionItem> => {
    const item = deps.store.getActionItem(id)
    if (!item) throw new Error(`Item não encontrado: ${id}`)
    const detail = deps.store.get(item.meetingId)
    if (!detail) throw new Error(`Reunião não encontrada: ${item.meetingId}`)

    let updated: MeetingActionItem
    if (status === 'dismissed') {
      updated = deps.store.setActionItemStatus(id, 'dismissed')
    } else if (item.taskId) {
      updated = deps.store.setActionItemStatus(id, 'created')
    } else {
      const task = deps.createTask(detail.meeting, { title: item.title, quote: item.quote })
      updated = deps.store.setActionItemStatus(id, 'created', task.id)
    }
    const items = deps.store.get(item.meetingId)?.actionItems ?? [updated]
    deps.emit({ type: 'action_items', meetingId: item.meetingId, items })
    return updated
  }

  return { run, resummarize, decide }
}

export function installPostProcess(overrides: Partial<PostProcessDeps> = {}): void {
  const processor = createPostProcessor(overrides)
  postProcessRegistry.current = async (id) => {
    await processor.run(id)
  }
  resummarizeRegistry.current = processor.resummarize
  actionItemRegistry.current = processor.decide
}
