// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatTranscriptUpdate } from '../../shared/types/chat'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

let transcriptPath: string | null = null
vi.mock('../../electron/main/services/session-activity', () => ({
  findTranscriptPath: () => transcriptPath,
}))

import { buildLongMotherLines } from '../../electron/main/services/__fixtures__/long-mother-jsonl'
import { chatTranscriptService } from '../../electron/main/services/chat-transcript-service'
import { APPEND_EVERY_MS, transcriptLoad } from './transcript-load'

const BASE_TURNS = 3
const STREAM_TURNS = 40
const all = buildLongMotherLines(BASE_TURNS + STREAM_TURNS)
const turnLines = all.length / (BASE_TURNS + STREAM_TURNS)
const base = all.slice(0, turnLines * BASE_TURNS)
const stream = all.slice(base.length)

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-load-'))
  file = join(dir, 'cc-load.jsonl')
  writeFileSync(file, base.join('\n') + '\n')
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const written = (): string[] => readFileSync(file, 'utf8').split('\n').filter(Boolean)

describe('transcriptLoad', () => {
  it('grava um turno inteiro por tick e a rodada seguinte continua de onde a anterior parou', () => {
    vi.useFakeTimers()
    const load = transcriptLoad(file, stream, turnLines)

    const stopFirst = load.start()
    vi.advanceTimersByTime(APPEND_EVERY_MS)
    expect(written()).toEqual([...base, ...stream.slice(0, turnLines)])
    expect(load.appendedLines()).toBe(turnLines)
    stopFirst()
    vi.advanceTimersByTime(APPEND_EVERY_MS * 3)
    expect(load.appendedLines()).toBe(turnLines)

    const stopSecond = load.start()
    vi.advanceTimersByTime(APPEND_EVERY_MS * 2)
    stopSecond()
    expect(written()).toEqual([...base, ...stream.slice(0, turnLines * 3)])
    expect(load.appendedLines()).toBe(turnLines * 3)
  })

  it('para de gravar quando o stream acaba', () => {
    vi.useFakeTimers()
    const load = transcriptLoad(file, stream.slice(0, turnLines), turnLines)

    const stop = load.start()
    vi.advanceTimersByTime(APPEND_EVERY_MS * 4)
    stop()

    expect(written()).toEqual([...base, ...stream.slice(0, turnLines)])
  })

  // O watcher real do chat, com o debounce dele: appends mais juntos que o debounce
  // só chegam ao chat quando a carga para, e a rodada "sob carga" mede sem carga.
  it('o watcher do transcript entrega turno novo ao chat com a carga ainda rodando', async () => {
    transcriptPath = file
    const updates: ChatTranscriptUpdate[] = []
    const sender = Object.assign(new EventEmitter(), {
      id: 1,
      isDestroyed: () => false,
      send: (channel: string, payload: ChatTranscriptUpdate) => {
        if (channel === 'chat:transcript-update') updates.push(payload)
      },
    }) as unknown as WebContents
    chatTranscriptService.watch('s-load', 'cc-load', sender)
    await vi.waitFor(() => expect(updates).toHaveLength(1), { timeout: 3000 })
    // chokidar precisa estar pronto antes do append, senão o change se perde.
    await new Promise((r) => setTimeout(r, 300))

    const load = transcriptLoad(file, stream, turnLines)
    const stop = load.start()
    try {
      await vi.waitFor(() => expect(updates.length).toBeGreaterThan(1), { timeout: 3000 })
      expect(load.appendedLines()).toBeLessThan(stream.length)
      expect(JSON.stringify(updates[1].messages)).toContain(`pronto ${BASE_TURNS}.`)
    } finally {
      stop()
      chatTranscriptService.unwatch('s-load')
    }
  })
})
