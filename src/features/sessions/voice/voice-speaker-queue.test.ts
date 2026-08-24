import { describe, expect, it } from 'vitest'
import { enqueueSpeech, finishSpeech, idleQueue, stopSpeech } from './voice-speaker-queue'

describe('enqueueSpeech', () => {
  it('em repouso: a fala começa imediatamente', () => {
    const r = enqueueSpeech(idleQueue, 'resumo A')
    expect(r.start).toBe('resumo A')
    expect(r.state).toEqual({ current: 'resumo A', queue: [] })
  })

  it('já falando: enfileira em ordem FIFO sem interromper', () => {
    let r = enqueueSpeech(idleQueue, 'a')
    r = enqueueSpeech(r.state, 'b')
    expect(r.start).toBeNull()
    r = enqueueSpeech(r.state, 'c')
    expect(r.start).toBeNull()
    expect(r.state).toEqual({ current: 'a', queue: ['b', 'c'] })
  })

  it('dedupe: a fala já tocando não re-entra (repique do broadcast)', () => {
    const first = enqueueSpeech(idleQueue, 'a')
    const again = enqueueSpeech(first.state, 'a')
    expect(again.start).toBeNull()
    expect(again.state).toEqual(first.state)
  })

  it('dedupe: a mesma fala no fim da fila não duplica', () => {
    let r = enqueueSpeech(idleQueue, 'a')
    r = enqueueSpeech(r.state, 'b')
    r = enqueueSpeech(r.state, 'b')
    expect(r.state).toEqual({ current: 'a', queue: ['b'] })
  })
})

describe('finishSpeech', () => {
  it('promove a próxima fala em ordem FIFO até esvaziar', () => {
    let q = enqueueSpeech(idleQueue, 'a').state
    q = enqueueSpeech(q, 'b').state
    q = enqueueSpeech(q, 'c').state

    let f = finishSpeech(q)
    expect(f.start).toBe('b')
    f = finishSpeech(f.state)
    expect(f.start).toBe('c')
    f = finishSpeech(f.state)
    expect(f).toEqual({ state: idleQueue, start: null })
  })

  it('em repouso: é no-op', () => {
    expect(finishSpeech(idleQueue)).toEqual({ state: idleQueue, start: null })
  })
})

describe('stopSpeech', () => {
  it('limpa a fala atual e toda a fila', () => {
    let q = enqueueSpeech(idleQueue, 'a').state
    q = enqueueSpeech(q, 'b').state
    expect(stopSpeech()).toEqual(idleQueue)
  })
})
