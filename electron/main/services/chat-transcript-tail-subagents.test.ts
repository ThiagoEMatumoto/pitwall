import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Conta as leituras síncronas que subagent-turns.ts faz, sem trocar o comportamento.
vi.mock('node:fs', { spy: true })

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
import { chatTranscriptService, readTail, TAIL_MESSAGES } from './chat-transcript-service'
import { clearSubagentCachesForTest, readSubagentInfos } from './subagent-turns'
import { buildLongMotherLines, realShapeAssistantLine } from './__fixtures__/long-mother-jsonl'

const root = mkdtempSync(join(tmpdir(), 'tail-subagents-'))
afterAll(() => {
  chatTranscriptService.closeAll()
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => clearSubagentCachesForTest())

const subagentReads = () =>
  vi
    .mocked(fs.readFileSync)
    .mock.calls.map(([p]) => String(p))
    .filter((p) => p.includes(`${'/'}subagents${'/'}`))

// Mãe com N subagentes grandes; só o último é invocado nas mensagens finais.
// Meta: mesmas chaves do agent-*.meta.json que o claude grava (conferidas num
// arquivo real); turnos: linhas assistant no envelope real do fixture, com
// isSidechain como no agent-*.jsonl.
function buildMother(n: number, turnsPerSubagent = 60): { path: string; cc: string } {
  const projectDir = join(root, `proj-${n}`)
  const cc = `cc-${n}`
  const subDir = join(projectDir, cc, 'subagents')
  mkdirSync(subDir, { recursive: true })
  for (let i = 0; i < n; i++) {
    writeFileSync(
      join(subDir, `agent-${i}.meta.json`),
      JSON.stringify({
        agentType: i === n - 1 ? 'Explore' : 'general-purpose',
        description: `subagente ${i}`,
        toolUseId: `toolu_sub_${i}`,
        spawnDepth: 1,
        requestShape: 'agent',
        requestNonInteractive: true,
      }),
    )
    const lines: string[] = []
    for (let t = 0; t < turnsPerSubagent; t++) {
      const line = JSON.parse(
        realShapeAssistantLine(t, `msg_sub${i}_${t}`, [
          { type: 'text', text: `turno ${t} do subagente ${i}. ${'x'.repeat(2000)}` },
        ]),
      ) as Record<string, unknown>
      lines.push(JSON.stringify({ ...line, isSidechain: true, agentId: `a${i}` }))
    }
    writeFileSync(join(subDir, `agent-${i}.jsonl`), lines.join('\n') + '\n')
  }
  const path = join(projectDir, `${cc}.jsonl`)
  const lines = buildLongMotherLines(40)
  // A invocação de cada subagente fica no meio do transcript (fora da cauda),
  // menos a do último, que é a penúltima mensagem.
  const invocations = Array.from({ length: n - 1 }, (_, i) =>
    realShapeAssistantLine(5000 + i, `msg_inv_${i}`, [
      {
        type: 'tool_use',
        id: `toolu_sub_${i}`,
        name: 'Agent',
        input: { description: `subagente ${i}` },
      },
    ]),
  )
  writeFileSync(
    path,
    [
      ...lines.slice(0, 20),
      ...invocations,
      ...lines.slice(20),
      realShapeAssistantLine(9000, 'msg_inv_last', [
        {
          type: 'tool_use',
          id: `toolu_sub_${n - 1}`,
          name: 'Agent',
          input: { description: 'último' },
        },
      ]),
      realShapeAssistantLine(9001, 'msg_after', [{ type: 'text', text: 'subagente disparado' }]),
    ].join('\n') + '\n',
  )
  return { path, cc }
}

describe('readTail com subagentes', () => {
  it('bate com o parse completo (cards de subagente com turnos)', async () => {
    const { path, cc } = buildMother(4)
    const full = parseChatMessages(
      fs.readFileSync(path, 'utf8'),
      readSubagentInfos(join(root, 'proj-4'), cc),
    ).slice(-TAIL_MESSAGES)
    const tail = await readTail(path, cc)
    expect(tail).toEqual(full)
    const card = tail.find((m) => m.kind === 'subagent')
    expect(card).toMatchObject({
      kind: 'subagent',
      id: 'toolu_sub_3',
      name: 'Explore',
      turnCount: 60,
    })
  })

  it('o custo por emit não cresce com o número de subagentes', async () => {
    const perEmit = async (n: number) => {
      clearSubagentCachesForTest()
      const { path, cc } = buildMother(n)
      vi.mocked(fs.readFileSync).mockClear()
      await readTail(path, cc)
      const first = subagentReads()
      appendFileSync(
        path,
        realShapeAssistantLine(9999, 'msg_new', [{ type: 'text', text: 'nova' }]) + '\n',
      )
      vi.mocked(fs.readFileSync).mockClear()
      const tail = await readTail(path, cc)
      expect(tail.at(-1)).toMatchObject({ text: 'nova' })
      return {
        firstJsonl: first.filter((p) => p.endsWith('.jsonl')).length,
        next: subagentReads().length,
      }
    }
    const small = await perEmit(3)
    const big = await perEmit(80)
    // 1º emit: lê os metas (pequenos, uma vez) e só o .jsonl do card entregue.
    expect(small.firstJsonl).toBe(1)
    expect(big.firstJsonl).toBe(1)
    // Emits seguintes: nada mudou nos subagentes → nenhuma leitura, com 3 ou 80.
    expect(small.next).toBe(0)
    expect(big.next).toBe(0)
  })

  it('o .jsonl do subagente que cresceu é relido (cache por mtime/size)', async () => {
    const { path, cc } = buildMother(5)
    const first = await readTail(path, cc)
    expect(first.find((m) => m.kind === 'subagent')).toMatchObject({ turnCount: 60 })
    appendFileSync(
      join(root, 'proj-5', cc, 'subagents', 'agent-4.jsonl'),
      JSON.stringify({
        ...(JSON.parse(
          realShapeAssistantLine(99, 'msg_sub_more', [{ type: 'text', text: 'mais um' }]),
        ) as object),
        isSidechain: true,
      }) + '\n',
    )
    vi.mocked(fs.readFileSync).mockClear()
    const next = await readTail(path, cc)
    expect(next.find((m) => m.kind === 'subagent')).toMatchObject({ turnCount: 61 })
    expect(subagentReads()).toHaveLength(1)
  })

  it('nome/descrição do meta saem sem controles de terminal', async () => {
    const { path, cc } = buildMother(1)
    writeFileSync(
      join(root, 'proj-1', cc, 'subagents', 'agent-0.meta.json'),
      JSON.stringify({
        agentType: 'Exp\x1b[31mlore',
        description: 'a‮b',
        toolUseId: 'toolu_sub_0',
      }),
    )
    clearSubagentCachesForTest()
    const card = (await readTail(path, cc)).find((m) => m.kind === 'subagent')
    expect(card).toMatchObject({ name: 'Explore', description: 'ab' })
  })
})

describe('watchTail repetido', () => {
  it('2º consumidor da mesma sessão recebe a cauda atual sem esperar um change', async () => {
    const { path, cc } = buildMother(2)
    transcriptPath = path
    sent.length = 0
    chatTranscriptService.watchTail('s-twice', cc)
    const tails = () => sent.filter((s) => s.channel === 'chat:transcript-tail')
    await vi.waitFor(() => expect(tails()).toHaveLength(1))
    chatTranscriptService.watchTail('s-twice', cc)
    await vi.waitFor(() => expect(tails()).toHaveLength(2))
    expect(tails()[1].payload).toEqual(tails()[0].payload)
    chatTranscriptService.unwatchTail('s-twice')
  })
})
