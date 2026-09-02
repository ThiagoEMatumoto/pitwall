// Dono da transição 'processing' → 'done'/'error': resumo + extração de tarefas
// após stop(), re-execução sob demanda (resummarize) e decisão do usuário sobre
// itens propostos. Registra nos registries de recorder-contract.ts.
import type { Meeting, MeetingActionItem } from '../../../../shared/types/meetings'
import { notify as defaultNotify } from '../notifications'
import { emitMeetingEvent } from './event-bus'
import { createMeetingTask, extractActionItems } from './extract-actions'
import * as meetingStore from './meeting-store'
import { postProcessRegistry, resummarizeRegistry } from './recorder-contract'
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

  // Decisão unitária foi substituída por meetings:actionItems:batch
  // (actionItemBatchRegistry); W2-A registra a implementação em action-item-batch.ts.
  const decide = async (): Promise<MeetingActionItem> => {
    throw new Error('decide() foi substituído por actionItemBatchRegistry (meetings:actionItems:batch)')
  }

  return { run, resummarize, decide }
}

export function installPostProcess(overrides: Partial<PostProcessDeps> = {}): void {
  const processor = createPostProcessor(overrides)
  postProcessRegistry.current = async (id) => {
    await processor.run(id)
  }
  resummarizeRegistry.current = processor.resummarize
}
