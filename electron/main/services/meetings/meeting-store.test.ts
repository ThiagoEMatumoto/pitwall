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
  createVoice,
  deleteVoice,
  findVoiceByName,
  get,
  getActive,
  getSpeaker,
  getSpeakerCentroid,
  getVoiceEmbedding,
  list,
  listSegments,
  listSpeakers,
  listVoices,
  remove,
  replaceActionItems,
  setActionItemOwner,
  setActionItemStatus,
  setRuntimeInfo,
  setStatus,
  setSummary,
  update,
  updateSegmentsSpeaker,
  updateSpeaker,
  updateVoice,
  upsertSpeaker,
} from './meeting-store'

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec(
    'DELETE FROM meeting_v2_action_items; DELETE FROM meeting_v2_segments; DELETE FROM meeting_v2_speakers; DELETE FROM meetings_v2; DELETE FROM meeting_v2_voices;',
  )
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
    expect(m.speakers).toEqual([])
    expect(m).toMatchObject({ lastError: null, respawns: 0, micLevelDbfs: null, diarization: null })
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
    expect(first.speakerId).toBeNull()
    expect(first.speakerLabel).toBeNull()

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

describe('speakers', () => {
  it('upsertSpeaker cria com id gerado e label trimado; get() devolve speakers na reunião', () => {
    const m = create({ title: 'Falantes' })
    const s1 = upsertSpeaker({ meetingId: m.id, label: '  Participante 1 ' })
    expect(s1.id).toBeTruthy()
    expect(s1).toMatchObject({ meetingId: m.id, label: 'Participante 1', voiceId: null, turnCount: 0 })
    expect(listSpeakers(m.id)).toEqual([s1])
    expect(get(m.id)?.meeting.speakers).toEqual([s1])
    expect(list()[0].speakers).toEqual([s1])
  })

  it('upsertSpeaker com label repetido na mesma reunião atualiza em vez de duplicar', () => {
    const m = create({ title: 'Único' })
    const first = upsertSpeaker({ meetingId: m.id, label: 'Ana', turnCount: 1 })
    const again = upsertSpeaker({ meetingId: m.id, label: 'Ana', turnCount: 3, centroid: Buffer.from([1, 2]) })
    expect(again.id).toBe(first.id)
    expect(again.turnCount).toBe(3)
    expect(listSpeakers(m.id)).toHaveLength(1)
    expect(getSpeakerCentroid(first.id)).toEqual(Buffer.from([1, 2]))

    const other = create({ title: 'Outra' })
    expect(upsertSpeaker({ meetingId: other.id, label: 'Ana' }).id).not.toBe(first.id)
  })

  it('upsertSpeaker rejeita label vazio', () => {
    const m = create({ title: 'Vazio' })
    expect(() => upsertSpeaker({ meetingId: m.id, label: '  ' })).toThrow(/label vazio/)
  })

  it('updateSpeaker altera só o que veio e lança para id desconhecido', () => {
    const m = create({ title: 'Upd' })
    const s = upsertSpeaker({ meetingId: m.id, label: 'Participante 1', centroid: Buffer.from([9]) })
    const voice = createVoice({ name: 'Bia', embedding: Buffer.from([1]), dim: 1 })

    const renamed = updateSpeaker(s.id, { label: 'Bia', voiceId: voice.id })
    expect(renamed).toMatchObject({ id: s.id, label: 'Bia', voiceId: voice.id, turnCount: 0 })
    expect(getSpeakerCentroid(s.id)).toEqual(Buffer.from([9]))

    expect(updateSpeaker(s.id, { turnCount: 7 })).toMatchObject({ label: 'Bia', voiceId: voice.id, turnCount: 7 })
    expect(updateSpeaker(s.id, { label: '   ' }).label).toBe('Bia')
    expect(updateSpeaker(s.id, { voiceId: null }).voiceId).toBeNull()
    expect(getSpeaker('nope')).toBeNull()
    expect(() => updateSpeaker('nope', { label: 'x' })).toThrow(/speaker not found/)
  })

  it('appendSegment grava speakerId/speakerLabel e updateSegmentsSpeaker reescreve só os daquele speaker', () => {
    const m = create({ title: 'Seg speakers' })
    const a = upsertSpeaker({ meetingId: m.id, label: 'Participante 1' })
    const b = upsertSpeaker({ meetingId: m.id, label: 'Participante 2' })
    appendSegment({ meetingId: m.id, speaker: 'them', text: 'a1', startMs: 0, endMs: 1, chunkIndex: 0, speakerId: a.id, speakerLabel: a.label })
    appendSegment({ meetingId: m.id, speaker: 'them', text: 'b1', startMs: 1, endMs: 2, chunkIndex: 0, speakerId: b.id, speakerLabel: b.label })
    appendSegment({ meetingId: m.id, speaker: 'me', text: 'eu', startMs: 2, endMs: 3, chunkIndex: 0 })

    expect(updateSegmentsSpeaker(m.id, a.id, 'Ana')).toBe(1)
    const segs = listSegments(m.id)
    expect(segs.map((x) => [x.speakerId, x.speakerLabel])).toEqual([
      [a.id, 'Ana'],
      [b.id, 'Participante 2'],
      [null, null],
    ])
  })

  it('remove() cascateia os speakers da reunião', () => {
    const m = create({ title: 'Cascade' })
    upsertSpeaker({ meetingId: m.id, label: 'Participante 1' })
    remove(m.id)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM meeting_v2_speakers').get()).toEqual({ n: 0 })
  })
})

describe('voices', () => {
  it('createVoice/listVoices/findVoiceByName: metadados sem embedding, ordem por nome, busca case-insensitive', () => {
    const zed = createVoice({ name: 'Zed', embedding: Buffer.from([1, 2, 3]), dim: 3 })
    const ana = createVoice({ name: ' Ana ', embedding: Buffer.from([4]), dim: 1, sampleCount: 4 })
    expect(ana).toMatchObject({ name: 'Ana', dim: 1, sampleCount: 4 })
    expect(zed.sampleCount).toBe(1)
    expect(ana).not.toHaveProperty('embedding')

    expect(listVoices().map((v) => v.name)).toEqual(['Ana', 'Zed'])
    expect(findVoiceByName('ana')?.id).toBe(ana.id)
    expect(findVoiceByName('Ninguém')).toBeNull()
    expect(getVoiceEmbedding(zed.id)).toEqual(Buffer.from([1, 2, 3]))
    expect(getVoiceEmbedding('nope')).toBeNull()
  })

  it('createVoice rejeita nome ou embedding vazios', () => {
    expect(() => createVoice({ name: ' ', embedding: Buffer.from([1]), dim: 1 })).toThrow(/name vazio/)
    expect(() => createVoice({ name: 'X', embedding: Buffer.alloc(0), dim: 1 })).toThrow(/embedding vazio/)
  })

  it('updateVoice altera nome/embedding/sampleCount e lança para id desconhecido', () => {
    const v = createVoice({ name: 'Ana', embedding: Buffer.from([1]), dim: 1 })
    const merged = updateVoice(v.id, { embedding: Buffer.from([2]), sampleCount: 2 })
    expect(merged).toMatchObject({ id: v.id, name: 'Ana', sampleCount: 2 })
    expect(merged.updatedAt).toBeGreaterThanOrEqual(v.updatedAt)
    expect(getVoiceEmbedding(v.id)).toEqual(Buffer.from([2]))
    expect(updateVoice(v.id, { name: 'Ana Paula' }).name).toBe('Ana Paula')
    expect(() => updateVoice('nope', { name: 'x' })).toThrow(/voice not found/)
  })

  it('deleteVoice zera voiceId dos speakers vinculados (ON DELETE SET NULL)', () => {
    const m = create({ title: 'Voz' })
    const v = createVoice({ name: 'Ana', embedding: Buffer.from([1]), dim: 1 })
    const s = upsertSpeaker({ meetingId: m.id, label: 'Ana', voiceId: v.id })
    expect(s.voiceId).toBe(v.id)

    deleteVoice(v.id)
    expect(listVoices()).toEqual([])
    expect(getSpeaker(s.id)?.voiceId).toBeNull()
    expect(get(m.id)?.meeting.speakers[0].voiceId).toBeNull()
  })
})

describe('setRuntimeInfo', () => {
  it('grava só os campos informados e preserva o resto; não toca em status/error', () => {
    const m = create({ title: 'Runtime' })
    const a = setRuntimeInfo(m.id, { respawns: 2, micLevelDbfs: -48.5 })
    expect(a).toMatchObject({ respawns: 2, micLevelDbfs: -48.5, lastError: null, diarization: null })

    const b = setRuntimeInfo(m.id, { lastError: 'pw-record morreu', diarization: 'unavailable' })
    expect(b).toMatchObject({ respawns: 2, micLevelDbfs: -48.5, lastError: 'pw-record morreu', diarization: 'unavailable' })
    expect(b.status).toBe('recording')
    expect(b.error).toBeNull()

    const c = setRuntimeInfo(m.id, { lastError: null, micLevelDbfs: null })
    expect(c).toMatchObject({ lastError: null, micLevelDbfs: null, diarization: 'unavailable' })
    expect(() => setRuntimeInfo('nope', { respawns: 1 })).toThrow(/meeting not found/)
  })
})

describe('action item owner', () => {
  it('replaceActionItems aceita owner/ownerKind com default unknown', () => {
    const m = create({ title: 'Donos' })
    const items = replaceActionItems(m.id, [
      { title: 'A', quote: null, grounded: false, status: 'proposed', taskId: null, owner: 'Ana', ownerKind: 'named' },
      { title: 'B', quote: null, grounded: false, status: 'proposed', taskId: null },
    ])
    expect(items[0]).toMatchObject({ owner: 'Ana', ownerKind: 'named' })
    expect(items[1]).toMatchObject({ owner: null, ownerKind: 'unknown' })
  })

  it('setActionItemOwner atualiza dono e tipo, normaliza vazio pra null e lança para id desconhecido', () => {
    const m = create({ title: 'Dono 2' })
    const [item] = replaceActionItems(m.id, [
      { title: 'A', quote: null, grounded: false, status: 'proposed', taskId: null },
    ])
    expect(setActionItemOwner(item.id, ' Bia ', 'named')).toMatchObject({ owner: 'Bia', ownerKind: 'named' })
    expect(get(m.id)?.actionItems[0]).toMatchObject({ owner: 'Bia', ownerKind: 'named' })
    expect(setActionItemOwner(item.id, '', 'me')).toMatchObject({ owner: null, ownerKind: 'me' })
    expect(() => setActionItemOwner('nope', null, 'unknown')).toThrow(/action item not found/)
  })
})
