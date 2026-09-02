/** @vitest-environment node */
// Store de Reuniões v2 contra DB real (tmp dir), electron mockado — mesma
// estratégia de task-store.test.ts.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'meeting-store-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { app } from 'electron'
import { closeDb, getDb } from '../db'
import {
  appendSegment,
  create,
  get,
  getActive,
  list,
  listSegments,
  remove,
  replaceActionItems,
  setActionItemStatus,
  setStatus,
  setSummary,
  update,
} from './meeting-store'

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec('DELETE FROM meeting_v2_action_items; DELETE FROM meeting_v2_segments; DELETE FROM meetings_v2;')
})

function segment(meetingId: string, startMs: number, speaker: 'me' | 'them' = 'me') {
  return appendSegment({
    meetingId,
    speaker,
    text: `fala em ${startMs}`,
    startMs,
    endMs: startMs + 1000,
    chunkIndex: Math.floor(startMs / 12000),
  })
}

describe('create / getActive', () => {
  it('cria em status recording com título dado e sem segmentos', () => {
    const before = Date.now()
    const m = create({ title: '  Daily  ' })

    expect(m.title).toBe('Daily')
    expect(m.status).toBe('recording')
    expect(m.startedAt).toBeGreaterThanOrEqual(before)
    expect(m.endedAt).toBeNull()
    expect(m.rawNotes).toBe('')
    expect(m.themLabel).toBe('Participante')
    expect(m.segmentCount).toBe(0)
    expect(m.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('gera título default quando não informado', () => {
    const m = create({})
    expect(m.title).toMatch(/^Reunião /)
  })

  it('getActive devolve a gravação em curso e null quando nenhuma', () => {
    expect(getActive()).toBeNull()
    const m = create({ title: 'Ativa' })
    expect(getActive()?.id).toBe(m.id)

    setStatus(m.id, 'done', { endedAt: Date.now() })
    expect(getActive()).toBeNull()
  })
})

describe('list', () => {
  it('ordena por started_at desc com segmentCount e durationMs calculados', () => {
    const older = create({ title: 'Antiga' })
    getDb().prepare('UPDATE meetings_v2 SET started_at = ? WHERE id = ?').run(1_000, older.id)
    setStatus(older.id, 'done', { endedAt: 61_000 })
    segment(older.id, 0)
    segment(older.id, 5000)
    const newer = create({ title: 'Nova' })

    const all = list()
    expect(all.map((m) => m.id)).toEqual([newer.id, older.id])
    expect(all[1].segmentCount).toBe(2)
    expect(all[1].durationMs).toBe(60_000)
    expect(all[0].segmentCount).toBe(0)
  })
})

describe('get', () => {
  it('devolve reunião + segmentos + action items; null para id desconhecido', () => {
    const m = create({ title: 'Detalhe' })
    segment(m.id, 0)
    replaceActionItems(m.id, [
      { title: 'Enviar proposta', quote: null, grounded: false, status: 'proposed', taskId: null },
    ])

    const detail = get(m.id)
    expect(detail?.meeting.id).toBe(m.id)
    expect(detail?.meeting.segmentCount).toBe(1)
    expect(detail?.segments).toHaveLength(1)
    expect(detail?.actionItems).toHaveLength(1)
    expect(get('nope')).toBeNull()
  })
})

describe('update', () => {
  it('altera title/rawNotes/themLabel e mantém o que veio undefined', () => {
    const m = create({ title: 'Original' })

    const afterNotes = update({ id: m.id, rawNotes: 'nota 1' })
    expect(afterNotes.title).toBe('Original')
    expect(afterNotes.rawNotes).toBe('nota 1')

    const afterAll = update({ id: m.id, title: 'Renomeada', themLabel: 'Cliente' })
    expect(afterAll.title).toBe('Renomeada')
    expect(afterAll.rawNotes).toBe('nota 1')
    expect(afterAll.themLabel).toBe('Cliente')
    expect(afterAll.updatedAt).toBeGreaterThanOrEqual(m.updatedAt)
  })

  it('título vazio não apaga o atual', () => {
    const m = create({ title: 'Fica' })
    expect(update({ id: m.id, title: '   ' }).title).toBe('Fica')
  })

  it('lança para id desconhecido', () => {
    expect(() => update({ id: 'nope', title: 'x' })).toThrow(/meeting not found/)
  })
})

describe('setStatus / setSummary', () => {
  it('grava endedAt ao encerrar e erro ao falhar; erro é limpo em transição posterior', () => {
    const m = create({ title: 'Status' })

    const failed = setStatus(m.id, 'error', { endedAt: m.startedAt + 5000, error: 'STT caiu' })
    expect(failed.status).toBe('error')
    expect(failed.endedAt).toBe(m.startedAt + 5000)
    expect(failed.error).toBe('STT caiu')
    expect(failed.durationMs).toBe(5000)

    const retried = setStatus(m.id, 'processing')
    expect(retried.status).toBe('processing')
    expect(retried.endedAt).toBe(m.startedAt + 5000)
    expect(retried.error).toBeNull()
  })

  it('setSummary grava markdown e modelo', () => {
    const m = create({ title: 'Resumo' })
    const summarized = setSummary(m.id, '# Resumo\n- ok', 'sonnet')
    expect(summarized.summaryMd).toBe('# Resumo\n- ok')
    expect(summarized.summaryModel).toBe('sonnet')
  })
})

describe('segments', () => {
  it('appendSegment persiste e listSegments ordena por start_ms', () => {
    const m = create({ title: 'Seg' })
    segment(m.id, 12000, 'them')
    const first = segment(m.id, 0, 'me')
    segment(m.id, 6000, 'them')

    expect(first.meetingId).toBe(m.id)
    expect(first.speaker).toBe('me')
    expect(first.chunkIndex).toBe(0)

    const segs = listSegments(m.id)
    expect(segs.map((s) => s.startMs)).toEqual([0, 6000, 12000])
    expect(segs.map((s) => s.speaker)).toEqual(['me', 'them', 'them'])
    expect(get(m.id)?.meeting.segmentCount).toBe(3)
  })

  it('rejeita speaker fora de me/them (CHECK do schema)', () => {
    const m = create({ title: 'Check' })
    expect(() =>
      appendSegment({
        meetingId: m.id,
        speaker: 'bot' as 'me',
        text: 'x',
        startMs: 0,
        endMs: 1,
        chunkIndex: 0,
      }),
    ).toThrow()
  })
})

describe('action items', () => {
  it('replaceActionItems substitui o conjunto inteiro', () => {
    const m = create({ title: 'Ações' })
    const firstBatch = replaceActionItems(m.id, [
      { title: 'A', quote: 'vamos fazer A', grounded: true, status: 'created', taskId: 'task-1' },
      { title: 'B', quote: null, grounded: false, status: 'proposed', taskId: null },
    ])
    expect(firstBatch).toHaveLength(2)
    expect(firstBatch[0]).toMatchObject({ title: 'A', grounded: true, status: 'created', taskId: 'task-1' })
    expect(firstBatch[1]).toMatchObject({ title: 'B', quote: null, grounded: false, taskId: null })

    const second = replaceActionItems(m.id, [
      { title: 'C', quote: null, grounded: false, status: 'proposed', taskId: null },
    ])
    expect(second.map((i) => i.title)).toEqual(['C'])
    expect(get(m.id)?.actionItems.map((i) => i.title)).toEqual(['C'])
  })

  it('setActionItemStatus muda status e mantém/atribui taskId', () => {
    const m = create({ title: 'Ações 2' })
    const [item] = replaceActionItems(m.id, [
      { title: 'A', quote: null, grounded: false, status: 'proposed', taskId: null },
    ])

    const dismissed = setActionItemStatus(item.id, 'dismissed')
    expect(dismissed.status).toBe('dismissed')
    expect(dismissed.taskId).toBeNull()

    const created = setActionItemStatus(item.id, 'created', 'task-9')
    expect(created.status).toBe('created')
    expect(created.taskId).toBe('task-9')
    expect(get(m.id)?.actionItems[0]).toMatchObject({ status: 'created', taskId: 'task-9' })
  })

  it('lança para action item desconhecido', () => {
    expect(() => setActionItemStatus('nope', 'dismissed')).toThrow(/action item not found/)
  })
})

describe('remove', () => {
  it('apaga a reunião e leva segmentos e action items por cascade', () => {
    const m = create({ title: 'Some' })
    segment(m.id, 0)
    replaceActionItems(m.id, [
      { title: 'A', quote: null, grounded: false, status: 'proposed', taskId: null },
    ])

    remove(m.id)

    expect(get(m.id)).toBeNull()
    expect(list()).toHaveLength(0)
    const db = getDb()
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_v2_segments').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_v2_action_items').get()).toEqual({ n: 0 })
  })
})
