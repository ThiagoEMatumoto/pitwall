import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const sent: Array<{ channel: string; payload: unknown }> = []
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      },
    ],
  },
}))

let transcriptPath: string | null = null
vi.mock('./session-activity', () => ({
  findTranscriptPath: () => transcriptPath,
}))

import { parseChatMessages } from './chat-transcript'
import {
  chatTranscriptService,
  readTail,
  TAIL_BYTES,
  TAIL_MAX_BYTES,
  TAIL_MESSAGES,
} from './chat-transcript-service'
import {
  buildLongMotherLines,
  realShapeAssistantLine,
  withHugeLastResult,
} from './__fixtures__/long-mother-jsonl'

let dir: string
let longPath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-tail-'))
  longPath = join(dir, 'long-mother.jsonl')
  writeFileSync(longPath, buildLongMotherLines(300).join('\n') + '\n')
})

afterAll(() => {
  chatTranscriptService.closeAll()
  rmSync(dir, { recursive: true, force: true })
})

const lastFromFull = (path: string) =>
  parseChatMessages(readFileSync(path, 'utf8')).slice(-TAIL_MESSAGES)

describe('readTail', () => {
  it('a fixture é maior que 1MB, e a cauda bate com o parse completo', async () => {
    expect(statSync(longPath).size).toBeGreaterThan(1024 * 1024)
    const tail = await readTail(longPath)
    expect(tail).toHaveLength(TAIL_MESSAGES)
    expect(tail).toEqual(lastFromFull(longPath))
  })

  it('última mensagem maior que a janela: a janela cresce e devolve 5', async () => {
    const path = join(dir, 'huge-last.jsonl')
    writeFileSync(
      path,
      withHugeLastResult(buildLongMotherLines(300), TAIL_BYTES + 64 * 1024).join('\n') + '\n',
    )
    const tail = await readTail(path)
    expect(tail).toHaveLength(TAIL_MESSAGES)
    expect(tail).toEqual(lastFromFull(path))
  })

  it('acima de TAIL_MAX_BYTES devolve o que coube, sem lançar', async () => {
    const path = join(dir, 'over-max.jsonl')
    writeFileSync(
      path,
      withHugeLastResult(buildLongMotherLines(20), TAIL_MAX_BYTES + 1024).join('\n') + '\n',
    )
    const tail = await readTail(path)
    expect(tail.length).toBeLessThanOrEqual(TAIL_MESSAGES)
  })

  it('arquivo menor que a janela: lê do início, sem descartar a primeira linha', async () => {
    const path = join(dir, 'short.jsonl')
    writeFileSync(path, buildLongMotherLines(1).join('\n') + '\n')
    expect(await readTail(path)).toEqual(lastFromFull(path))
  })
})

describe('watchTail', () => {
  it('append de uma linha emite um único chat:transcript-tail, e nenhum chat:transcript-update', async () => {
    const path = join(dir, 'live.jsonl')
    writeFileSync(path, buildLongMotherLines(40).join('\n') + '\n')
    transcriptPath = path
    sent.length = 0

    chatTranscriptService.watchTail('s-tail', 'cc-tail')
    await vi.waitFor(() =>
      expect(sent.filter((s) => s.channel === 'chat:transcript-tail')).toHaveLength(1),
    )
    // chokidar precisa estar pronto antes do append, senão o change se perde.
    await new Promise((r) => setTimeout(r, 300))

    appendFileSync(
      path,
      realShapeAssistantLine(9999, 'msg_live', [{ type: 'text', text: 'linha nova da mãe' }]) +
        '\n',
    )
    await vi.waitFor(
      () => expect(sent.filter((s) => s.channel === 'chat:transcript-tail')).toHaveLength(2),
      { timeout: 3000 },
    )
    await new Promise((r) => setTimeout(r, 600))

    const tails = sent.filter((s) => s.channel === 'chat:transcript-tail')
    expect(tails).toHaveLength(2)
    const last = tails[1].payload as {
      sessionId: string
      transcriptExists: boolean
      messages: Array<{ text?: string }>
    }
    expect(last.sessionId).toBe('s-tail')
    expect(last.transcriptExists).toBe(true)
    expect(last.messages.at(-1)?.text).toBe('linha nova da mãe')
    expect(sent.some((s) => s.channel === 'chat:transcript-update')).toBe(false)

    chatTranscriptService.unwatchTail('s-tail')
  })

  it('sem transcript ainda: emite transcriptExists:false', () => {
    transcriptPath = null
    sent.length = 0
    chatTranscriptService.watchTail('s-nofile', 'cc-nofile')
    expect(sent).toEqual([
      {
        channel: 'chat:transcript-tail',
        payload: { sessionId: 's-nofile', transcriptExists: false, messages: [] },
      },
    ])
    chatTranscriptService.unwatchTail('s-nofile')
  })

  it('sem ccSessionId não observa nada', () => {
    sent.length = 0
    chatTranscriptService.watchTail('s-nocc', null)
    expect(sent).toEqual([])
  })
})
