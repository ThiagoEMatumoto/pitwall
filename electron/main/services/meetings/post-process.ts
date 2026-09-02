// Dono da transição 'processing' → 'done'/'error': resumo + extração de tarefas
// após stop() e re-execução sob demanda (resummarize). Registra nos registries
// de recorder-contract.ts. A decisão sobre itens propostos vive em
// action-item-batch.ts.
import type { Meeting, MeetingActionItem } from '../../../../shared/types/meetings'
import { notify as defaultNotify } from '../notifications'
import { emitMeetingEvent } from './event-bus'
import { extractActionItems } from './extract-actions'
import * as meetingStore from './meeting-store'
import { postProcessRegistry, resummarizeRegistry } from './recorder-contract'
import { summarizeMeeting } from './summarize'

export interface PostProcessDeps {
  store: Pick<typeof meetingStore, 'get' | 'setStatus' | 'listSpeakers'>
  summarize: (meetingId: string) => Promise<Meeting>
  extract: (meetingId: string, participants: string[]) => Promise<MeetingActionItem[]>
  emit: typeof emitMeetingEvent
  notify: (input: { title: string; body: string }) => void
}

function defaultDeps(): PostProcessDeps {
  return {
    store: meetingStore,
    summarize: (id) => summarizeMeeting(id),
    extract: (id, participants) => extractActionItems(id, { participants: () => participants }),
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
      const participants = deps.store.listSpeakers(meetingId).map((s) => s.label)
      await deps.extract(meetingId, participants)
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

  return { run, resummarize }
}

export function installPostProcess(overrides: Partial<PostProcessDeps> = {}): void {
  const processor = createPostProcessor(overrides)
  postProcessRegistry.current = async (id) => {
    await processor.run(id)
  }
  resummarizeRegistry.current = processor.resummarize
}
