// Decisão em lote do usuário sobre os itens propostos: criar tarefas (com
// dono/título ajustados na UI) ou descartar. Única porta de criação de task a
// partir de reunião fora do opt-in de criação automática.
import type { MeetingActionItem, MeetingActionItemBatch } from '../../../../shared/types/meetings'
import { broadcast } from '../notify'
import { getPref } from '../prefs-store'
import * as taskStore from '../task-store'
import { emitMeetingEvent } from './event-bus'
import { classifyOwner, createMeetingTask, locateQuote, MY_NAME_PREF } from './extract-actions'
import * as meetingStore from './meeting-store'
import { actionItemBatchRegistry } from './recorder-contract'

export interface ActionItemBatchDeps {
  store: Pick<typeof meetingStore, 'get' | 'getActionItem' | 'setActionItemStatus' | 'setActionItemOwner'>
  taskStore: Pick<typeof taskStore, 'create'>
  broadcast: (channel: string, payload: unknown) => void
  emit: typeof emitMeetingEvent
  myName: () => string | null
}

function defaultDeps(): ActionItemBatchDeps {
  return {
    store: meetingStore,
    taskStore,
    broadcast,
    emit: emitMeetingEvent,
    myName: () => getPref<string | null>(MY_NAME_PREF, null),
  }
}

export function createActionItemBatch(overrides: Partial<ActionItemBatchDeps> = {}) {
  const deps: ActionItemBatchDeps = { ...defaultDeps(), ...overrides }

  return async (input: MeetingActionItemBatch): Promise<MeetingActionItem[]> => {
    const detail = deps.store.get(input.meetingId)
    if (!detail) throw new Error(`Reunião não encontrada: ${input.meetingId}`)
    const myName = deps.myName()

    for (const id of input.ids) {
      const item = deps.store.getActionItem(id)
      if (!item || item.meetingId !== input.meetingId) throw new Error(`Item não pertence à reunião: ${id}`)
      if (item.status === 'created') continue

      if (input.action === 'dismiss') {
        deps.store.setActionItemStatus(id, 'dismissed')
        continue
      }

      const override = input.overrides?.[id]
      const current =
        override && 'owner' in override
          ? deps.store.setActionItemOwner(id, override.owner ?? null, classifyOwner(override.owner, myName))
          : item
      const task = createMeetingTask(
        detail.meeting,
        {
          title: override?.title?.trim() || current.title,
          quote: current.quote,
          owner: current.owner,
          ownerKind: current.ownerKind,
          atMs: locateQuote(detail.segments, current.quote),
        },
        deps,
      )
      deps.store.setActionItemStatus(id, 'created', task.id)
    }

    const items = deps.store.get(input.meetingId)?.actionItems ?? []
    deps.emit({ type: 'action_items', meetingId: input.meetingId, items })
    return items
  }
}

export function installActionItemBatch(overrides: Partial<ActionItemBatchDeps> = {}): void {
  actionItemBatchRegistry.current = createActionItemBatch(overrides)
}
