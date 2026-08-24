import { describe, expect, it } from 'vitest'
import {
  MIN_RECORDING_MS,
  reduceRecorder,
  shouldCondense,
  type RecorderState,
} from './voice-recorder-state'

const idle: RecorderState = { status: 'idle' }

// idle → requesting → recording, o caminho feliz do clique no mic.
function startRecording(at: number): RecorderState {
  const requesting = reduceRecorder(idle, { type: 'request' })
  return reduceRecorder(requesting, { type: 'start', at })
}

describe('reduceRecorder', () => {
  it('moves to requesting while getUserMedia is in flight, then records', () => {
    const requesting = reduceRecorder(idle, { type: 'request' })
    expect(requesting).toEqual({ status: 'requesting' })
    const next = reduceRecorder(requesting, { type: 'start', at: 1000 })
    expect(next).toEqual({ status: 'recording', startedAt: 1000 })
  })

  it('ignores a second request while one is in flight (double-click mic leak guard)', () => {
    const requesting = reduceRecorder(idle, { type: 'request' })
    expect(reduceRecorder(requesting, { type: 'request' })).toBe(requesting)
    const recording = startRecording(1000)
    expect(reduceRecorder(recording, { type: 'request' })).toBe(recording)
    const transcribing: RecorderState = { status: 'transcribing' }
    expect(reduceRecorder(transcribing, { type: 'request' })).toBe(transcribing)
  })

  it('ignores start outside requesting (state changed during the getUserMedia await)', () => {
    expect(reduceRecorder(idle, { type: 'start', at: 1000 })).toBe(idle)
    const error: RecorderState = { status: 'error', message: 'x' }
    expect(reduceRecorder(error, { type: 'start', at: 1000 })).toBe(error)
  })

  it('fails from requesting when the mic permission is denied', () => {
    const requesting = reduceRecorder(idle, { type: 'request' })
    const next = reduceRecorder(requesting, { type: 'failed', message: 'sem mic' })
    expect(next).toEqual({ status: 'error', message: 'sem mic' })
  })

  it('discards recordings shorter than the minimum (Whisper hallucinates on silence)', () => {
    const recording = startRecording(1000)
    const next = reduceRecorder(recording, { type: 'stop', at: 1000 + MIN_RECORDING_MS - 1 })
    expect(next).toEqual({ status: 'idle' })
  })

  it('moves to transcribing when the recording is long enough', () => {
    const recording = startRecording(1000)
    const next = reduceRecorder(recording, { type: 'stop', at: 1000 + MIN_RECORDING_MS })
    expect(next).toEqual({ status: 'transcribing' })
  })

  it('returns to idle after a successful transcription', () => {
    const next = reduceRecorder({ status: 'transcribing' }, { type: 'transcribed' })
    expect(next).toEqual({ status: 'idle' })
  })

  it('lands on error with the message on failure', () => {
    const next = reduceRecorder(
      { status: 'transcribing' },
      { type: 'failed', message: 'proxy fora' },
    )
    expect(next).toEqual({ status: 'error', message: 'proxy fora' })
  })

  it('recovers from error by requesting a new recording', () => {
    const error: RecorderState = { status: 'error', message: 'x' }
    const requesting = reduceRecorder(error, { type: 'request' })
    expect(requesting).toEqual({ status: 'requesting' })
    const next = reduceRecorder(requesting, { type: 'start', at: 2000 })
    expect(next).toEqual({ status: 'recording', startedAt: 2000 })
  })

  it('resets error back to idle', () => {
    const next = reduceRecorder({ status: 'error', message: 'x' }, { type: 'reset' })
    expect(next).toEqual({ status: 'idle' })
  })

  it('ignores start while transcribing (audio already sent)', () => {
    const state: RecorderState = { status: 'transcribing' }
    expect(reduceRecorder(state, { type: 'start', at: 3000 })).toBe(state)
  })

  it('ignores stop when not recording', () => {
    expect(reduceRecorder(idle, { type: 'stop', at: 3000 })).toBe(idle)
    const requesting: RecorderState = { status: 'requesting' }
    expect(reduceRecorder(requesting, { type: 'stop', at: 3000 })).toBe(requesting)
    const state: RecorderState = { status: 'transcribing' }
    expect(reduceRecorder(state, { type: 'stop', at: 3000 })).toBe(state)
  })

  it('ignores transcribed outside of transcribing', () => {
    expect(reduceRecorder(idle, { type: 'transcribed' })).toBe(idle)
    const recording: RecorderState = { status: 'recording', startedAt: 1 }
    expect(reduceRecorder(recording, { type: 'transcribed' })).toBe(recording)
  })

  it('resets requesting back to idle', () => {
    expect(reduceRecorder({ status: 'requesting' }, { type: 'reset' })).toEqual({ status: 'idle' })
  })

  it('moves to condensing while a long dictation is being cleaned up', () => {
    const next = reduceRecorder({ status: 'transcribing' }, { type: 'condensing' })
    expect(next).toEqual({ status: 'condensing' })
  })

  it('returns to idle once condensation finishes', () => {
    const next = reduceRecorder({ status: 'condensing' }, { type: 'condensed' })
    expect(next).toEqual({ status: 'idle' })
  })

  it('ignores start while condensing (text is on its way to the composer)', () => {
    const state: RecorderState = { status: 'condensing' }
    expect(reduceRecorder(state, { type: 'start', at: 4000 })).toBe(state)
  })

  it('ignores condensing/condensed outside of their source states', () => {
    expect(reduceRecorder(idle, { type: 'condensing' })).toBe(idle)
    expect(reduceRecorder(idle, { type: 'condensed' })).toBe(idle)
    const recording: RecorderState = { status: 'recording', startedAt: 1 }
    expect(reduceRecorder(recording, { type: 'condensing' })).toBe(recording)
  })

  it('lands on error from condensing on failure', () => {
    const next = reduceRecorder({ status: 'condensing' }, { type: 'failed', message: 'x' })
    expect(next).toEqual({ status: 'error', message: 'x' })
  })
})

describe('shouldCondense', () => {
  it('condenses only at or above the word threshold', () => {
    expect(shouldCondense('one two three', 4)).toBe(false)
    expect(shouldCondense('one two three four', 4)).toBe(true)
    expect(shouldCondense('one two three four five', 4)).toBe(true)
  })

  it('counts words across any whitespace, ignoring blanks', () => {
    expect(shouldCondense('  one\n two\tthree  ', 3)).toBe(true)
    expect(shouldCondense('   ', 1)).toBe(false)
  })
})
