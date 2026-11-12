import { EventEmitter } from 'node:events'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { WebContents } from 'electron'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatTranscriptUpdate } from '../../../shared/types/chat'

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

import { lastPlanFilePath, parseChatMessages } from './chat-transcript'
import { clearSubagentCachesForTest, readSubagentInfos } from './subagent-turns'
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

// O que o serviço usa do WebContents de quem chamou chat:watch: id, send e os eventos de
// ciclo de vida. `updates` guarda só o canal do chat completo.
let nextSenderId = 100
function fakeSender() {
  const updates: ChatTranscriptUpdate[] = []
  const events = new EventEmitter()
  const sender = Object.assign(events, {
    id: nextSenderId++,
    isDestroyed: () => false,
    send: (channel: string, payload: ChatTranscriptUpdate) => {
      if (channel === 'chat:transcript-update') updates.push(payload)
    },
  }) as unknown as WebContents
  return { sender, updates, events }
}

// O lado do renderer, reduzido ao contrato: revs em sequência, base 0 substitui, o resto
// emenda em `base`. Devolve a lista que um consumidor teria depois de todos os updates.
function follower(updates: ChatTranscriptUpdate[]) {
  let seen = 0
  let rev = 0
  let messages: ChatMessage[] = []
  return (): ChatMessage[] => {
    for (; seen < updates.length; seen++) {
      const u = updates[seen]
      expect(u.rev, `rev do update ${seen}`).toBe(rev + 1)
      expect(u.base, `base do update ${seen}`).toBeLessThanOrEqual(messages.length)
      rev = u.rev
      messages = messages.slice(0, u.base).concat(u.messages)
    }
    return messages
  }
}

let seq = 0
// Sessão observada sobre um arquivo novo no tmp. `refresh` é a leitura que o watcher
// dispara depois do debounce: chamá-la direto tira o chokidar do caminho do teste.
async function watched(initial: string[], projectDir = dir) {
  const n = seq++
  const cc = `cc-full-${n}`
  const sessionId = `s-full-${n}`
  const path = join(projectDir, `${cc}.jsonl`)
  writeFileSync(path, initial.map((l) => l + '\n').join(''))
  transcriptPath = path
  const { sender, updates, events } = fakeSender()
  chatTranscriptService.watch(sessionId, cc, sender)
  await chatTranscriptService.refresh(sessionId)
  const full = () =>
    parseChatMessages(readFileSync(path, 'utf8'), readSubagentInfos(dirname(path), cc))
  return {
    sessionId,
    cc,
    path,
    sender,
    updates,
    events,
    view: follower(updates),
    full,
    append: async (lines: string[]) => {
      appendFileSync(path, lines.map((l) => l + '\n').join(''))
      await chatTranscriptService.refresh(sessionId)
    },
  }
}

const FIXTURES = join(__dirname, '../../../shared/tui/__fixtures__')
const REWIND = 'claude-2.1.318-rewind-e2e-restored.jsonl'
const fixtureLines = (name: string): string[] =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
const REAL = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.jsonl') && !f.includes('hook-spike-payloads'))
  .map((f): [string, string[]] => [f, fixtureLines(f)])
// Write num arquivo de plano, no envelope real: nenhum transcript versionado tem um.
const PLAN_WRITE = realShapeAssistantLine(7000, 'msg_plan', [
  {
    type: 'tool_use',
    id: 'toolu_plan',
    name: 'Write',
    input: { file_path: '/home/dev/.claude/plans/plano-novo.md', content: '# plano' },
  },
])
const MOTHER = buildLongMotherLines(30)
const CASES: [string, string[]][] = [
  ...REAL,
  ['mãe longa (30 turnos)', MOTHER],
  ['mãe com Write de plano no meio', [...MOTHER.slice(0, 20), PLAN_WRITE, ...MOTHER.slice(20, 30)]],
]

describe('watch — delta só para quem observa', () => {
  beforeEach(() => clearSubagentCachesForTest())

  it('cobre os transcripts reais do repo, o de rewind incluso', () => {
    expect(REAL.map(([name]) => name)).toEqual(
      expect.arrayContaining(['claude-2.1.286-send-message.jsonl', REWIND]),
    )
    expect(REAL.length).toBeGreaterThanOrEqual(12)
  })

  it.each(CASES)('%s: linha a linha, o delta aplicado é o parse completo', async (_n, lines) => {
    const w = await watched([])
    expect(w.updates).toHaveLength(1)
    expect(w.updates[0]).toMatchObject({ base: 0, rev: 1, transcriptExists: true, messages: [] })

    for (let k = 0; k < lines.length; k++) {
      await w.append([lines[k]])
      const full = w.full()
      expect(w.view(), `até a linha ${k}`).toEqual(full)
      expect(w.updates.at(-1)?.lastPlanFilePath, `até a linha ${k}`).toBe(lastPlanFilePath(full))
    }
    expect(w.view().length).toBeGreaterThan(0)
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it.each(CASES)('%s: prefixo + resto em todo ponto de corte', async (_n, lines) => {
    for (let k = 0; k <= lines.length; k++) {
      const w = await watched(lines.slice(0, k))
      const before = w.view()
      await w.append(lines.slice(k))
      const after = w.view()
      expect(after, `corte ${k}`).toEqual(w.full())
      const last = w.updates.at(-1)!
      // Abaixo de `base` o renderer mantém os objetos que já tinha.
      if (last.base > 0) for (let i = 0; i < last.base; i++) expect(after[i]).toBe(before[i])
      chatTranscriptService.unwatch(w.sessionId, w.sender.id)
    }
  })

  it('append numa mãe longa manda só a cauda, não a lista', async () => {
    const lines = buildLongMotherLines(40)
    const w = await watched(lines.slice(0, 150))
    const before = w.view().length
    expect(before).toBeGreaterThan(100)

    await w.append(lines.slice(150, 151))

    const last = w.updates.at(-1)!
    expect(w.updates).toHaveLength(2)
    expect(last.base).toBeGreaterThanOrEqual(before - 1)
    expect(last.messages.length).toBeLessThanOrEqual(2)
    expect(w.view()).toEqual(w.full())
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it('o watcher real entrega o append só ao sender inscrito, com base > 0', async () => {
    const lines = buildLongMotherLines(12)
    const w = await watched(lines.slice(0, 40))
    const other = fakeSender()
    sent.length = 0
    // chokidar precisa estar pronto antes do append, senão o change se perde.
    await new Promise((r) => setTimeout(r, 300))

    appendFileSync(w.path, lines[40] + '\n')
    await vi.waitFor(() => expect(w.updates).toHaveLength(2), { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 400))

    expect(w.updates).toHaveLength(2)
    expect(w.updates[1].base).toBeGreaterThan(0)
    expect(w.updates[1].sessionId).toBe(w.sessionId)
    expect(w.view()).toEqual(w.full())
    expect(other.updates).toEqual([])
    // Nada vai às outras janelas (ocultas de screenshot/PDF inclusas).
    expect(sent.some((s) => s.channel === 'chat:transcript-update')).toBe(false)
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it('leitura sem novidade não emite', async () => {
    const w = await watched(buildLongMotherLines(3))
    await chatTranscriptService.refresh(w.sessionId)
    await chatTranscriptService.refresh(w.sessionId)
    expect(w.updates).toHaveLength(1)
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it('linha escrita pela metade só entra quando o \\n chega', async () => {
    const lines = buildLongMotherLines(3)
    const w = await watched(lines.slice(0, 5))
    const half = Math.floor(lines[5].length / 2)

    appendFileSync(w.path, lines[5].slice(0, half))
    await chatTranscriptService.refresh(w.sessionId)
    expect(w.updates).toHaveLength(1)
    expect(w.view()).toEqual(w.full())

    appendFileSync(w.path, lines[5].slice(half) + '\n')
    await chatTranscriptService.refresh(w.sessionId)
    expect(w.updates).toHaveLength(2)
    expect(w.view()).toEqual(w.full())
    expect(w.view()).toEqual(parseChatMessages(lines.slice(0, 6).join('\n')))
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it('arquivo maior que um bloco de leitura: a 1ª leitura bate com o parse completo', async () => {
    const w = await watched(buildLongMotherLines(300, 16 * 1024))
    expect(statSync(w.path).size).toBeGreaterThan(4 * 1024 * 1024)
    expect(w.updates).toHaveLength(1)
    expect(w.view()).toEqual(w.full())
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it('arquivo truncado relê do zero (base 0)', async () => {
    const lines = buildLongMotherLines(6)
    const w = await watched(lines)
    writeFileSync(w.path, lines.slice(0, 10).map((l) => l + '\n').join(''))
    await chatTranscriptService.refresh(w.sessionId)

    expect(w.updates.at(-1)).toMatchObject({ base: 0, rev: 2 })
    expect(w.view()).toEqual(w.full())
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it('arquivo reescrito com outro conteúdo e mais bytes relê do zero (base 0)', async () => {
    const w = await watched(buildLongMotherLines(4))
    const other = buildLongMotherLines(9, 512).map((l) => l.replaceAll('pedido', 'PEDIDO'))
    writeFileSync(w.path, other.map((l) => l + '\n').join(''))
    expect(statSync(w.path).size).not.toBe(0)
    await chatTranscriptService.refresh(w.sessionId)

    expect(w.updates.at(-1)).toMatchObject({ base: 0 })
    expect(w.view()).toEqual(w.full())
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it('o prompt que bifurca no fixture de rewind relê do zero (base 0) e tira o ramo abandonado', async () => {
    const lines = fixtureLines(REWIND)
    const forkAt = lines.findIndex((l) => l.includes('Responda só: ok depois.'))
    expect(forkAt).toBeGreaterThan(0)
    const w = await watched(lines.slice(0, forkAt))
    const before = w.view().length

    await w.append([lines[forkAt]])

    expect(w.updates.at(-1)).toMatchObject({ base: 0 })
    expect(w.view().length).toBeLessThan(before)
    expect(w.view()).toEqual(w.full())
    // Depois do rewind a leitura volta a ser incremental.
    await w.append(lines.slice(forkAt + 1))
    expect(w.updates.at(-1)!.base).toBeGreaterThan(0)
    expect(w.view()).toEqual(w.full())
    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
  })

  it('sem transcript ainda: avisa só o inscrito, e o arquivo que nasce chega com base 0', async () => {
    transcriptPath = null
    const { sender, updates } = fakeSender()
    chatTranscriptService.watch('s-poll', 'cc-poll', sender)
    expect(updates).toEqual([
      {
        sessionId: 's-poll',
        transcriptExists: false,
        base: 0,
        rev: 1,
        messages: [],
        lastPlanFilePath: null,
      },
    ])

    const path = join(dir, 'cc-poll.jsonl')
    writeFileSync(path, buildLongMotherLines(2).map((l) => l + '\n').join(''))
    transcriptPath = path
    await vi.waitFor(() => expect(updates).toHaveLength(2), { timeout: 3000 })

    expect(updates[1]).toMatchObject({ transcriptExists: true, base: 0, rev: 2 })
    expect(follower(updates)()).toEqual(parseChatMessages(readFileSync(path, 'utf8')))
    chatTranscriptService.unwatch('s-poll', sender.id)
  })

  it('sem ccSessionId não observa nada', () => {
    const { sender, updates } = fakeSender()
    chatTranscriptService.watch('s-nocc-full', null, sender)
    expect(updates).toEqual([])
    expect(chatTranscriptService.isWatching('s-nocc-full')).toBe(false)
  })
})

describe('watch — inscritos', () => {
  it('quem chega depois recebe a lista inteira no rev atual, e segue junto', async () => {
    const lines = buildLongMotherLines(6)
    const w = await watched(lines.slice(0, 10))
    await w.append(lines.slice(10, 15))
    const late = fakeSender()

    chatTranscriptService.watch(w.sessionId, w.cc, late.sender)

    expect(late.updates).toHaveLength(1)
    expect(late.updates[0]).toMatchObject({ base: 0, rev: w.updates.at(-1)!.rev })
    expect(late.updates[0].messages).toEqual(w.view())
    expect(w.updates).toHaveLength(2) // o primeiro não recebe a reemissão.

    await w.append(lines.slice(15))
    expect(late.updates.at(-1)).toEqual(w.updates.at(-1))
    chatTranscriptService.unwatch(w.sessionId)
  })

  it('watch repetido do mesmo sender não reemite', async () => {
    const w = await watched(buildLongMotherLines(2))
    chatTranscriptService.watch(w.sessionId, w.cc, w.sender)
    expect(w.updates).toHaveLength(1)
    chatTranscriptService.unwatch(w.sessionId)
  })

  it('unwatch tira só o sender; o último libera a entrada', async () => {
    const lines = buildLongMotherLines(4)
    const w = await watched(lines.slice(0, 10))
    const b = fakeSender()
    chatTranscriptService.watch(w.sessionId, w.cc, b.sender)

    chatTranscriptService.unwatch(w.sessionId, w.sender.id)
    expect(chatTranscriptService.isWatching(w.sessionId)).toBe(true)
    const seenByA = w.updates.length
    await w.append(lines.slice(10))
    expect(w.updates).toHaveLength(seenByA)
    expect(b.updates.at(-1)!.base).toBeGreaterThan(0)

    chatTranscriptService.unwatch(w.sessionId, b.sender.id)
    expect(chatTranscriptService.isWatching(w.sessionId)).toBe(false)
  })

  it('sender destruído sem unwatch libera a entrada', async () => {
    const w = await watched(buildLongMotherLines(2))
    expect(chatTranscriptService.isWatching(w.sessionId)).toBe(true)

    w.events.emit('destroyed')

    expect(chatTranscriptService.isWatching(w.sessionId)).toBe(false)
  })

  it('sender destruído não derruba a entrada que outra janela ainda observa', async () => {
    const w = await watched(buildLongMotherLines(2))
    const b = fakeSender()
    chatTranscriptService.watch(w.sessionId, w.cc, b.sender)

    w.events.emit('destroyed')

    expect(chatTranscriptService.isWatching(w.sessionId)).toBe(true)
    chatTranscriptService.unwatch(w.sessionId)
  })

  it('reload da janela (navegação do frame principal) libera todas as entradas dela', async () => {
    const w = await watched(buildLongMotherLines(2))
    const second = `${w.sessionId}-b`
    chatTranscriptService.watch(second, `${w.cc}-b`, w.sender)
    expect(chatTranscriptService.isWatching(second)).toBe(true)

    // Navegação de iframe e troca de hash não recarregam o renderer.
    w.events.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    w.events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(chatTranscriptService.isWatching(w.sessionId)).toBe(true)

    w.events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })

    expect(chatTranscriptService.isWatching(w.sessionId)).toBe(false)
    expect(chatTranscriptService.isWatching(second)).toBe(false)
  })

  it('a janela recarregada volta a observar e recebe a lista do zero', async () => {
    const w = await watched(buildLongMotherLines(2))
    w.events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    w.updates.length = 0

    chatTranscriptService.watch(w.sessionId, w.cc, w.sender)
    await chatTranscriptService.refresh(w.sessionId)

    expect(w.updates).toHaveLength(1)
    expect(w.updates[0]).toMatchObject({ base: 0, rev: 1 })
    expect(w.updates[0].messages).toEqual(w.full())
    chatTranscriptService.unwatch(w.sessionId)
  })

  it('uma janela com muitas sessões registra um par de listeners, não um por sessão', async () => {
    const w = await watched(buildLongMotherLines(1))
    for (let i = 0; i < 20; i++) chatTranscriptService.watch(`${w.sessionId}-${i}`, `${w.cc}-${i}`, w.sender)
    expect(w.events.listenerCount('destroyed')).toBe(1)
    expect(w.events.listenerCount('did-start-navigation')).toBe(1)
    w.events.emit('destroyed')
    expect(chatTranscriptService.isWatching(`${w.sessionId}-7`)).toBe(false)
  })
})

describe('snapshot', () => {
  it('logo após o watch espera a 1ª leitura e devolve a lista completa, no rev dela', async () => {
    const lines = buildLongMotherLines(20)
    const path = join(dir, 'cc-snap.jsonl')
    writeFileSync(path, lines.map((l) => l + '\n').join(''))
    transcriptPath = path
    const { sender, updates } = fakeSender()

    chatTranscriptService.watch('s-snap', 'cc-snap', sender)
    const snap = await chatTranscriptService.snapshot('s-snap', 'cc-snap')

    expect(snap.messages).toEqual(parseChatMessages(readFileSync(path, 'utf8')))
    expect(snap.messages.length).toBeGreaterThan(0)
    expect(snap).toMatchObject({ rev: 1, path, ccSessionId: 'cc-snap', lastPlanFilePath: null })
    expect(snap.mtimeMs).toBe(statSync(path).mtimeMs)
    expect(updates).toHaveLength(1)
    chatTranscriptService.unwatch('s-snap')
  })

  it('sem watch cai na leitura avulsa do arquivo inteiro, com rev 0', async () => {
    const path = join(dir, 'cc-nowatch.jsonl')
    writeFileSync(path, buildLongMotherLines(3).map((l) => l + '\n').join(''))
    transcriptPath = path

    const snap = await chatTranscriptService.snapshot('s-nowatch', 'cc-nowatch')

    expect(snap).toEqual({ ...(await chatTranscriptService.read('cc-nowatch')), rev: 0 })
    expect(snap.messages.length).toBeGreaterThan(0)
    expect(chatTranscriptService.isWatching('s-nowatch')).toBe(false)
  })

  it('concorrente a um append não duplica mensagens', async () => {
    const lines = buildLongMotherLines(8)
    const w = await watched(lines.slice(0, 20))

    appendFileSync(w.path, lines.slice(20).map((l) => l + '\n').join(''))
    const reading = chatTranscriptService.refresh(w.sessionId)
    const snap = await chatTranscriptService.snapshot(w.sessionId, w.cc)
    await reading

    expect(snap.messages).toEqual(w.full())
    expect(snap.rev).toBe(w.updates.at(-1)!.rev)
    // O renderer que aplicou o snapshot ignora os updates até o rev dele: mesma lista.
    expect(w.view()).toEqual(snap.messages)
    chatTranscriptService.unwatch(w.sessionId)
  })

  it('Write de plano: lastPlanFilePath segue no snapshot e no update', async () => {
    const w = await watched([...buildLongMotherLines(2), PLAN_WRITE])
    const snap = await chatTranscriptService.snapshot(w.sessionId, w.cc)
    expect(snap.lastPlanFilePath).toBe('/home/dev/.claude/plans/plano-novo.md')
    expect(w.updates[0].lastPlanFilePath).toBe('/home/dev/.claude/plans/plano-novo.md')
    chatTranscriptService.unwatch(w.sessionId)
  })
})

// Subagente em disco, nos shapes que o claude grava: agent-N.meta.json (mesmas chaves de
// chat-transcript-tail-subagents.test.ts) e agent-N.jsonl com turnos isSidechain.
describe('watch — subagentes', () => {
  beforeEach(() => clearSubagentCachesForTest())

  const invocation = (id: string) =>
    realShapeAssistantLine(8000, `msg_inv_${id}`, [
      { type: 'tool_use', id, name: 'Agent', input: { description: 'mapear' } },
    ])
  const result = (id: string) =>
    JSON.stringify({
      ...(JSON.parse(buildLongMotherLines(1)[3]) as Record<string, unknown>),
      uuid: `00000000-0000-4000-8000-00000000${id.length}999`,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: 'feito', is_error: false }],
      },
    })
  const turn = (t: number) =>
    JSON.stringify({
      ...(JSON.parse(
        realShapeAssistantLine(t, `msg_sub_${t}`, [{ type: 'text', text: `turno ${t}` }]),
      ) as Record<string, unknown>),
      isSidechain: true,
      agentId: 'a0',
    })
  function projectDir(): string {
    const d = join(dir, `proj-${seq}`)
    mkdirSync(d, { recursive: true })
    return d
  }
  function writeSubagent(project: string, cc: string, toolUseId: string, turns: number): string {
    const subDir = join(project, cc, 'subagents')
    mkdirSync(subDir, { recursive: true })
    const jsonl = join(subDir, 'agent-0.jsonl')
    writeFileSync(jsonl, Array.from({ length: turns }, (_, t) => turn(t) + '\n').join(''))
    writeFileSync(
      join(subDir, 'agent-0.meta.json'),
      JSON.stringify({
        agentType: 'Explore',
        description: 'mapear',
        toolUseId,
        spawnDepth: 1,
        requestShape: 'agent',
        requestNonInteractive: true,
      }),
    )
    return jsonl
  }

  it('meta que já existe: o tool_use nasce como card, com os turnos do subagente', async () => {
    const project = projectDir()
    writeSubagent(project, `cc-full-${seq}`, 'toolu_sub', 3)
    const w = await watched([...buildLongMotherLines(2), invocation('toolu_sub')], project)

    expect(w.view().at(-1)).toMatchObject({ kind: 'subagent', id: 'toolu_sub', turnCount: 3 })
    expect(w.view()).toEqual(w.full())
    await w.append([result('toolu_sub')])
    expect(w.view().at(-1)).toMatchObject({ kind: 'subagent_result', forId: 'toolu_sub' })
    expect(w.view()).toEqual(w.full())
    chatTranscriptService.unwatch(w.sessionId)
  })

  it('meta que chega com o tool_use pendente: troca o card no lugar, sem reler', async () => {
    const project = projectDir()
    const w = await watched([...buildLongMotherLines(2), invocation('toolu_sub')], project)
    const idx = w.view().length - 1
    expect(w.view()[idx]).toMatchObject({ kind: 'tool_use', id: 'toolu_sub' })

    writeSubagent(project, w.cc, 'toolu_sub', 2)
    await chatTranscriptService.refresh(w.sessionId)

    expect(w.updates.at(-1)).toMatchObject({ base: idx })
    expect(w.view()[idx]).toMatchObject({ kind: 'subagent', id: 'toolu_sub', turnCount: 2 })
    expect(w.view()).toEqual(w.full())
    await w.append([result('toolu_sub')])
    expect(w.view().at(-1)).toMatchObject({ kind: 'subagent_result' })
    expect(w.view()).toEqual(w.full())
    chatTranscriptService.unwatch(w.sessionId)
  })

  it('meta que chega depois do tool_result: relê do zero (base 0)', async () => {
    const project = projectDir()
    const w = await watched(
      [...buildLongMotherLines(2), invocation('toolu_sub'), result('toolu_sub')],
      project,
    )
    expect(w.view().at(-1)).toMatchObject({ kind: 'tool_result', forId: 'toolu_sub' })

    writeSubagent(project, w.cc, 'toolu_sub', 2)
    await chatTranscriptService.refresh(w.sessionId)

    expect(w.updates.at(-1)).toMatchObject({ base: 0 })
    expect(w.view().at(-1)).toMatchObject({ kind: 'subagent_result' })
    expect(w.view()).toEqual(w.full())
    chatTranscriptService.unwatch(w.sessionId)
  })

  it('subagente em andamento: os turnos novos trocam só o card dele', async () => {
    const project = projectDir()
    const jsonl = writeSubagent(project, `cc-full-${seq}`, 'toolu_sub', 1)
    const mother = buildLongMotherLines(3)
    const w = await watched(
      [...mother.slice(0, 10), invocation('toolu_sub'), ...mother.slice(10)],
      project,
    )
    const idx = w.view().findIndex((m) => m.kind === 'subagent')
    const before = w.view()

    appendFileSync(jsonl, turn(1) + '\n' + turn(2) + '\n')
    await chatTranscriptService.refresh(w.sessionId)

    expect(w.updates.at(-1)).toMatchObject({ base: idx })
    const after = w.view()
    expect(after[idx]).toMatchObject({ kind: 'subagent', turnCount: 3 })
    expect(after).toEqual(w.full())
    for (let i = 0; i < idx; i++) expect(after[i]).toBe(before[i])
    chatTranscriptService.unwatch(w.sessionId)
  })
})
