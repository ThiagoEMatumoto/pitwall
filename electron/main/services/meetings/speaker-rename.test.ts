/** @vitest-environment node */
// Rename contra store real (tmpdir): label, segmentos e voz conhecida.
import { rmSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'meeting-rename-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

import { vi } from 'vitest'
import { app } from 'electron'
import type { MeetingEvent } from '../../../../shared/types/meetings'
import { closeDb, getDb } from '../db'
import * as store from './meeting-store'
import { speakerRenameRegistry } from './recorder-contract'
import { bufferToF32, createSpeakerRename, f32ToBuffer, installSpeakerRename, mergeEmbedding } from './speaker-rename'

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec(
    'DELETE FROM meeting_v2_segments; DELETE FROM meeting_v2_speakers; DELETE FROM meeting_v2_voices; DELETE FROM meetings_v2;',
  )
})

function seed(centroid: Float32Array | null) {
  const meeting = store.create({ title: 'Kickoff' })
  const speaker = store.upsertSpeaker({
    meetingId: meeting.id,
    label: 'Participante 1',
    turnCount: 2,
    centroid: centroid ? f32ToBuffer(centroid) : null,
  })
  const other = store.upsertSpeaker({
    meetingId: meeting.id,
    label: 'Participante 2',
    turnCount: 1,
  })
  const db = getDb()
  for (const [i, sid] of [speaker.id, other.id, speaker.id].entries()) {
    const seg = store.appendSegment({
      meetingId: meeting.id,
      speaker: 'them',
      text: `fala ${i}`,
      startMs: i * 1000,
      endMs: i * 1000 + 500,
      chunkIndex: 0,
    })
    db.prepare('UPDATE meeting_v2_segments SET speaker_id = ?, speaker_label = ? WHERE id = ?').run(
      sid,
      sid === speaker.id ? 'Participante 1' : 'Participante 2',
      seg.id,
    )
  }
  return { meeting, speaker, other }
}

describe('speaker rename', () => {
  it('troca o label, reescreve só os segmentos daquele speaker e emite o evento meeting', async () => {
    const { meeting, speaker, other } = seed(null)
    const events: MeetingEvent[] = []
    const rename = createSpeakerRename({ emit: (e) => events.push(e) })

    const out = await rename({
      meetingId: meeting.id,
      speakerId: speaker.id,
      name: '  Bianca ',
    })

    expect(out.speakers.find((s) => s.id === speaker.id)).toMatchObject({
      label: 'Bianca',
      voiceId: null,
    })
    const labels = store.listSegments(meeting.id).map((s) => s.speakerLabel)
    expect(labels).toEqual(['Bianca', 'Participante 2', 'Bianca'])
    expect(store.getSpeaker(other.id)?.label).toBe('Participante 2')
    expect(events).toEqual([{ type: 'meeting', meeting: out }])
    expect(store.listVoices()).toEqual([])
  })

  it('com centroide e nome novo → cria a voz e vincula o speaker', async () => {
    const centroid = new Float32Array([0.6, 0.8])
    const { meeting, speaker } = seed(centroid)
    const rename = createSpeakerRename({ emit: () => {} })

    const out = await rename({
      meetingId: meeting.id,
      speakerId: speaker.id,
      name: 'Bianca',
    })

    const voice = store.findVoiceByName('bianca')
    expect(voice).toMatchObject({ name: 'Bianca', dim: 2, sampleCount: 1 })
    expect(out.speakers.find((s) => s.id === speaker.id)?.voiceId).toBe(voice!.id)
    expect(Array.from(bufferToF32(store.getVoiceEmbedding(voice!.id)!))).toEqual(Array.from(centroid))
  })

  it('com centroide e voz já existente → média ponderada por sampleCount, renormalizada', async () => {
    const existing = store.createVoice({
      name: 'Bianca',
      embedding: f32ToBuffer(new Float32Array([1, 0])),
      dim: 2,
      sampleCount: 3,
    })
    const { meeting, speaker } = seed(new Float32Array([0, 1]))
    const rename = createSpeakerRename({ emit: () => {} })

    const out = await rename({
      meetingId: meeting.id,
      speakerId: speaker.id,
      name: 'bianca',
    })

    expect(store.listVoices()).toHaveLength(1)
    const voice = store.getVoice(existing.id)!
    expect(voice.sampleCount).toBe(4)
    const emb = bufferToF32(store.getVoiceEmbedding(existing.id)!)
    // (3·[1,0] + [0,1]) / 4 = [0.75, 0.25] → normalizado
    const norm = Math.hypot(0.75, 0.25)
    expect(emb[0]).toBeCloseTo(0.75 / norm, 5)
    expect(emb[1]).toBeCloseTo(0.25 / norm, 5)
    expect(out.speakers.find((s) => s.id === speaker.id)?.voiceId).toBe(existing.id)
  })

  it('rejeita nome vazio e speaker de outra reunião', async () => {
    const { meeting, speaker } = seed(null)
    const rename = createSpeakerRename({ emit: () => {} })
    await expect(rename({ meetingId: meeting.id, speakerId: speaker.id, name: '   ' })).rejects.toThrow(/vazio/)
    await expect(rename({ meetingId: 'outra', speakerId: speaker.id, name: 'Ana' })).rejects.toThrow(/não encontrado/)
    expect(store.getSpeaker(speaker.id)?.label).toBe('Participante 1')
  })

  it('installSpeakerRename registra no registry', () => {
    installSpeakerRename({ emit: () => {} })
    expect(speakerRenameRegistry.current).toBeTypeOf('function')
  })
})

describe('mergeEmbedding', () => {
  it('devolve vetor unitário', () => {
    const merged = mergeEmbedding(new Float32Array([3, 4]), 1, new Float32Array([3, 4]))
    expect(Math.hypot(merged[0], merged[1])).toBeCloseTo(1, 6)
  })
})
