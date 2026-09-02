/** @vitest-environment node */
// Decisão em lote com store real (tmpdir): criar aplica override de dono e
// gera task `[Dono] título` com tag meeting; descartar só muda status.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'meeting-batch-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import * as taskStore from '../task-store'
import type { MeetingEvent } from '../../../../shared/types/meetings'
import { createActionItemBatch, installActionItemBatch } from './action-item-batch'
import * as store from './meeting-store'
import { actionItemBatchRegistry } from './recorder-contract'

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec(
    'DELETE FROM meeting_v2_action_items; DELETE FROM meeting_v2_segments; DELETE FROM meetings_v2; DELETE FROM task_links; DELETE FROM tasks; DELETE FROM app_prefs;',
  )
})

function seed() {
  const meeting = store.create({ title: 'Planning' })
  store.appendSegment({ meetingId: meeting.id, speaker: 'them', text: 'Vamos começar pela pauta', startMs: 0, endMs: 900, chunkIndex: 0 })
  store.appendSegment({ meetingId: meeting.id, speaker: 'them', text: 'Então a Bianca envia o PDF do caso até sexta', startMs: 61_000, endMs: 62_000, chunkIndex: 0 })
  const items = store.replaceActionItems(meeting.id, [
    { title: 'Enviar o PDF do caso', quote: 'envia o PDF do caso até sexta', grounded: true, status: 'proposed', taskId: null, owner: null, ownerKind: 'unknown' },
    { title: 'Revisar a pauta', quote: 'começar pela pauta', grounded: true, status: 'proposed', taskId: null, owner: 'Eu', ownerKind: 'me' },
    { title: 'Sem quote', quote: null, grounded: false, status: 'proposed', taskId: null, owner: 'Pedro', ownerKind: 'named' },
  ])
  return { meeting, items }
}

function setup() {
  const events: MeetingEvent[] = []
  const broadcasts: string[] = []
  const batch = createActionItemBatch({
    emit: (e) => events.push(e),
    broadcast: (channel) => broadcasts.push(channel),
    myName: () => null,
  })
  return { batch, events, broadcasts }
}

describe('action item batch', () => {
  it('create com override de dono: task [Bianca] …, tag meeting, quote e timestamp na descrição', async () => {
    const { meeting, items } = seed()
    const { batch, events, broadcasts } = setup()
    const [pdf] = items

    const result = await batch({ meetingId: meeting.id, ids: [pdf.id], action: 'create', overrides: { [pdf.id]: { owner: 'Bianca' } } })

    const saved = result.find((i) => i.id === pdf.id)!
    expect(saved).toMatchObject({ status: 'created', owner: 'Bianca', ownerKind: 'named' })
    const task = taskStore.get(saved.taskId!)
    expect(task).toMatchObject({ title: '[Bianca] Enviar o PDF do caso', origin: 'auto', tags: ['meeting'], status: 'todo', priority: 'medium' })
    expect(task?.description).toContain('Origem: reunião "Planning"')
    expect(task?.description).toContain('· 01:01')
    expect(task?.description).toContain('> envia o PDF do caso até sexta')
    expect(broadcasts).toEqual(['task:updated'])
    expect(events).toEqual([{ type: 'action_items', meetingId: meeting.id, items: result }])
    expect(result.filter((i) => i.status === 'proposed')).toHaveLength(2)
  })

  it('dono "Eu" (por override ou já salvo) não prefixa o título; item sem quote também cria', async () => {
    const { meeting, items } = seed()
    const { batch } = setup()
    const [pdf, pauta, semQuote] = items

    const result = await batch({
      meetingId: meeting.id,
      ids: [pdf.id, pauta.id, semQuote.id],
      action: 'create',
      overrides: { [pdf.id]: { owner: 'eu', title: 'Mandar o PDF' } },
    })

    const titles = result.map((i) => taskStore.get(i.taskId!)?.title)
    expect(titles).toEqual(['Mandar o PDF', 'Revisar a pauta', '[Pedro] Sem quote'])
    expect(result.map((i) => i.ownerKind)).toEqual(['me', 'me', 'named'])
    expect(taskStore.get(result[2].taskId!)?.description).not.toContain('>')
    expect(taskStore.list()).toHaveLength(3)
  })

  it('dismiss só muda status; criar de novo um item já criado não duplica', async () => {
    const { meeting, items } = seed()
    const { batch, events } = setup()
    const [pdf, pauta] = items

    const afterDismiss = await batch({ meetingId: meeting.id, ids: [pdf.id, pauta.id], action: 'dismiss' })
    expect(afterDismiss.map((i) => i.status)).toEqual(['dismissed', 'dismissed', 'proposed'])
    expect(taskStore.list()).toHaveLength(0)
    expect(events).toHaveLength(1)

    await batch({ meetingId: meeting.id, ids: [pauta.id], action: 'create' })
    await batch({ meetingId: meeting.id, ids: [pauta.id], action: 'create' })
    expect(taskStore.list()).toHaveLength(1)
  })

  it('id de outra reunião → erro; reunião inexistente → erro', async () => {
    const { items } = seed()
    const other = store.create({ title: 'Outra' })
    const { batch } = setup()
    await expect(batch({ meetingId: other.id, ids: [items[0].id], action: 'create' })).rejects.toThrow(/não pertence/)
    await expect(batch({ meetingId: 'nope', ids: [], action: 'create' })).rejects.toThrow(/não encontrada/)
  })

  it('installActionItemBatch registra no registry', () => {
    actionItemBatchRegistry.current = null
    installActionItemBatch({ emit: () => {}, broadcast: () => {} })
    expect(actionItemBatchRegistry.current).toBeTypeOf('function')
    actionItemBatchRegistry.current = null
  })
})
