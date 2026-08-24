import { describe, expect, it } from 'vitest'
import {
  MIN_RECORDING_MS,
  reduceRecorder,
  shouldCondense,
  type RecorderState,
} from './voice-recorder-state'

const idle: RecorderState = { status: 'idle' }

describe('reduceRecorder', () => {
  it('starts recording from idle with the start timestamp', () => {
    const next = reduceRecorder(idle, { type: 'start', at: 1000 })
    expect(next).toEqual({ status: 'recording', startedAt: 1000 })
  })

  it('discards recordings shorter than the minimum (Whisper hallucinates on silence)', () => {
    const recording = reduceRecorder(idle, { type: 'start', at: 1000 })
    const next = reduceRecorder(recording, { type: 'stop', at: 1000 + MIN_RECORDING_MS - 1 })
    expect(next).toEqual({ status: 'idle' })
  })

  it('moves to transcribing when the recording is long enough', () => {
    const recording = reduceRecorder(idle, { type: 'start', at: 1000 })
    const next = reduceRecorder(recording, { type: 'stop', at: 1000 + MIN_RECORDING_MS })
    expect(next).toEqual({ status: 'transcribing' })
  })

  it('returns to idle after a successful transcription', () => {
    const next = reduceRecorder({ status: 'transcribing' }, { type: 'transcribed' })
    expect(next).toEqual({ status: 'idle' })
  })

  it('lands on error with the message on failure', () => {
    const next = reduceRecorder({ status: 'transcribing' }, { type: 'failed', message: 'proxy fora' })
    expect(next).toEqual({ status: 'error', message: 'proxy fora' })
  })

  it('recovers from error by starting a new recording', () => {
    const error: RecorderState = { status: 'error', message: 'x' }
    const next = reduceRecorder(error, { type: 'start', at: 2000 })
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
    const state: RecorderState = { status: 'transcribing' }
    expect(reduceRecorder(state, { type: 'stop', at: 3000 })).toBe(state)
  })

  it('ignores transcribed outside of transcribing', () => {
    expect(reduceRecorder(idle, { type: 'transcribed' })).toBe(idle)
    const recording: RecorderState = { status: 'recording', startedAt: 1 }
    expect(reduceRecorder(recording, { type: 'transcribed' })).toBe(recording)
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
