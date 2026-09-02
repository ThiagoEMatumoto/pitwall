// Renomear um speaker (W2-B): troca o label, reescreve o label desnormalizado
// dos segmentos e promove o centroide a voz conhecida — nova, ou fundida na
// voz que já tem esse nome (média ponderada pelo sample_count) — pra próxima
// reunião reconhecer a pessoa de cara.
import type { Meeting, RenameMeetingSpeakerInput } from '../../../../shared/types/meetings'
import { emitMeetingEvent } from './event-bus'
import * as meetingStore from './meeting-store'
import { speakerRenameRegistry } from './recorder-contract'

export interface SpeakerRenameDeps {
  store: Pick<
    typeof meetingStore,
    | 'get'
    | 'getSpeaker'
    | 'getSpeakerCentroid'
    | 'updateSpeaker'
    | 'updateSegmentsSpeaker'
    | 'findVoiceByName'
    | 'getVoiceEmbedding'
    | 'createVoice'
    | 'updateVoice'
  >
  emit: typeof emitMeetingEvent
}

export function bufferToF32(buf: Buffer): Float32Array {
  // Buffer de pool pode não estar alinhado a 4 bytes: copia antes de reinterpretar.
  const copy = new Uint8Array(buf.byteLength)
  copy.set(buf)
  return new Float32Array(copy.buffer)
}

export function f32ToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  return v.map((x) => x / norm)
}

/** (voz × sampleCount + centroide) / (sampleCount + 1), renormalizado. */
export function mergeEmbedding(voice: Float32Array, sampleCount: number, centroid: Float32Array): Float32Array {
  const out = new Float32Array(voice.length)
  for (let i = 0; i < out.length; i++) out[i] = (voice[i] * sampleCount + centroid[i]) / (sampleCount + 1)
  return normalize(out)
}

function linkVoice(deps: SpeakerRenameDeps, name: string, centroid: Buffer): string {
  const existing = deps.store.findVoiceByName(name)
  if (!existing) {
    return deps.store.createVoice({
      name,
      embedding: centroid,
      dim: centroid.byteLength / 4,
    }).id
  }
  const current = deps.store.getVoiceEmbedding(existing.id)
  const dimMatches = current && current.byteLength === centroid.byteLength
  if (dimMatches) {
    const merged = mergeEmbedding(bufferToF32(current), existing.sampleCount, bufferToF32(centroid))
    deps.store.updateVoice(existing.id, {
      embedding: f32ToBuffer(merged),
      sampleCount: existing.sampleCount + 1,
    })
  }
  return existing.id
}

export function createSpeakerRename(overrides: Partial<SpeakerRenameDeps> = {}) {
  const deps: SpeakerRenameDeps = {
    store: meetingStore,
    emit: emitMeetingEvent,
    ...overrides,
  }

  return async ({ meetingId, speakerId, name }: RenameMeetingSpeakerInput): Promise<Meeting> => {
    const label = name.trim()
    if (!label) throw new Error('Nome vazio')
    const speaker = deps.store.getSpeaker(speakerId)
    if (!speaker || speaker.meetingId !== meetingId) throw new Error(`Speaker não encontrado: ${speakerId}`)

    deps.store.updateSpeaker(speakerId, { label })
    deps.store.updateSegmentsSpeaker(meetingId, speakerId, label)

    const centroid = deps.store.getSpeakerCentroid(speakerId)
    if (centroid && centroid.byteLength > 0) {
      deps.store.updateSpeaker(speakerId, {
        voiceId: linkVoice(deps, label, centroid),
      })
    }

    const detail = deps.store.get(meetingId)
    if (!detail) throw new Error(`Reunião não encontrada: ${meetingId}`)
    deps.emit({ type: 'meeting', meeting: detail.meeting })
    return detail.meeting
  }
}

export function installSpeakerRename(overrides: Partial<SpeakerRenameDeps> = {}): void {
  speakerRenameRegistry.current = createSpeakerRename(overrides)
}
